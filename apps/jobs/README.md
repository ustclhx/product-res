# Jobs 平台调用（A 4.5）

Cloudflare 默认入口仍为 `src/index.ts`，导出 `AiMediaWorkflow` 与 fetch/queue/scheduled。
Wrangler 的五条 UTC Cron、队列重试配置、工作流绑定和 Sentry 启用条件保持原样。
入口每次事件校验 env、显式挑选支付标量，装配 platform 的数据库/KV/Queue/WorkflowStep
适配器；不跨事件保存数据库客户端。Sentry CF SDK 只由入口及其 `src/sentry.ts` 目标辅助模块加载。

业务入口是 `src/handlers.ts` 的 `consumeJobsBatch`、`runJobsSchedule` 与
`registerJobsSchedules`。`JobsContext` 注入 `DatabaseAccess`、`KeyValueStore`、
`QueueProducer`、邮件 transport、文件清理能力和 `JobObserver`，不接收原始 bindings。
日维护的空间清理/指标汇总、十分钟维护的计费/文件清理继续使用 allSettled；一项失败仍运行
另一项，最后报告整组失败。删除失效重试成功后才记录五分钟心跳。

## B 接入位置

| 入口 | 装配责任 |
| --- | --- |
| `consumeJobsBatch(batch, context)` | B 将真实投递转成 platform `QueueBatch`（email/events）；入口可用 `withLogContext` 加 queue，消费者恢复每条消息的 requestId。逐条 ack/retry 保留，未确认投递的持久重试/耗尽由 B 负责。 |
| `JobsContext.emailDeadLetters` | Node 必须注入 B 的 `DeadLetterSink<unknown>`。有效邮件不可重试或达到 6 次尝试时调用 `failed`；sink 持久记录后确认，记录失败则 handler 拒绝且不提前 ack。无效消息直接确认。CF 不装配此 hook，保持原 ack/drop。 |
| `registerJobsSchedules(scheduler, context)` | 向 B 的真实 Scheduler 注册原有五条 UTC Cron、missedRun:skip；每次运行生成 requestId，使用引擎的 scheduledAt 计算指标日期。B 负责锁、持久调度、补跑及真实心跳健康判定。 |
| `runMediaTask(taskId, step, deps)` | B 注入中立 `WorkflowStep`、业务数据库/Provider/持久文件函数。retry delay/timeout 为毫秒；不可重试异常来自 platform，B 转换为引擎异常。成功步骤仅保存 JSON，流/字节留在单一步骤内；原截止时间、取消检查与幂等结算不变。 |
| `JobObserver` | CF 注入现有 Sentry capture/tag；Node 暂用 `logJobObserver` 记录错误类型与共享日志上下文。C 再接入 Node Sentry。 |
| `JobsContext.files` / 媒体 `deps.persist` | C 未接入 Node 文件能力时，文件清理传 available:false，在访问 DB 前拒绝；媒体不装配/启动。十分钟 Cron 的计费任务仍独立执行。 |

真实 B 装配及队列集成验收属于 A 9。C 的 Node 存储/媒体和 Node Sentry 仍待交付，不把业务模块可加载当作
持久任务、死信或媒体生产能力已验收。

## Node 生产入口（A 5.2）

`pnpm --filter @product-res/jobs build:node` 使用现有 esbuild 生成独立
`.output/server/index.mjs`；`pnpm --filter @product-res/jobs start:node` 在 Node >=22.12 启动。
默认 `build` 仍输出 Wrangler `dist`。workspace 源码编译进入 ESM，第三方依赖保持外置，
允许运行层加载原生 Node 模块；部署时必须安装 jobs 的 production dependencies。
`.output/node-build.json` 记录实际外置依赖与源码图，产物不包含 CF entry、workerd 或 Sentry CF。
platform Node barrel 当前也导出 B 引擎代码，因此 DBOS/pg 是已声明的外置依赖；本入口不装配引擎。

入口在 listen 前调用 `loadNodeEnv({ templateConfig })` 校验 dotenv/env/文件密钥和模板开关，
随后创建 `DB_POOL_MAX` 上限的自有 app 池及共享 `CACHE_NAMESPACE` 的 Valkey 连接。
监听 `HOST`（默认 `0.0.0.0`）和 `PORT`（默认 `3001`），只有 GET `/internal/live` 返回 200。
这是容器内部进程 liveness：queue/scheduler 为 unavailable、lastCronAt 为 null；
不执行临时队列、Cron 或媒体任务，不将进程存活当作依赖 readiness。

SIGTERM/SIGINT 使用同一个幂等 shutdown：停止接收 → 排空请求/后台任务 → 同时关闭缓存与 SQL 池。
`SHUTDOWN_TIMEOUT_MS` 覆盖整个顺序（默认 30 秒）；最终销毁残留 socket，排空或资源关闭不完整时
以非零状态退出。正常运行没有平台 CPU 或响应后时限；现有业务 timeout、依赖探测 timeout 与
停机 deadline 各自保留，waitUntil 仍不提供 crash durability。

`pnpm --filter @product-res/jobs test:node` 独立运行 Node 单元用例；
`pnpm --filter @product-res/jobs test:node:integration` 要求 `TEST_VALKEY_URL` 和
`TEST_DATABASE_URL`（本地可读取 worktree app 连接），缺资源直接失败。
生产子进程用真实 Valkey 启动、读取 unavailable 探活，并在半开 HTTP socket 下验证 SIGTERM 退出；
单元用例另外验证启动配置拒绝、external 解析、drain 顺序与超时，不替代 B 的任务引擎验收。

## 验证

- `pnpm --filter @product-res/jobs typecheck`：原有源码与测试类型检查。
- `pnpm --filter @product-res/jobs test`：原 CF 全部用例，及 Node 单元用例。媒体测试只将步骤类型/
  毫秒字段改成中立契约，保留预算、取消、重放、等待、截止时间、存储与结算断言。
- `test/node-load.unit.test.ts`：临时 ESM bundle 在真实 Node 子进程加载业务 handler 与 runner；
  检查完整构建依赖图没有 cloudflare:* / Sentry CF，不注入 Workers 全局。临时文件测试后删除。
- 精简回归用例覆盖两组 Cron 独立失败、文件能力不可用前置拒绝、持久死信记录前不确认及
  sink 故障不确认。持久 sink 本身的数据库验收由 B 执行。

共享文件仅增加 jobs manifest 的 platform 依赖与已锁定 esbuild 的测试依赖（用于真实 Node
加载验证）；lockfile 增加 jobs importer，并按 pnpm dedupe --check 要求统一 Better Auth 的同版本
Vite 可选 peer 快照（包版本未升级）。check-deps 仅删除 jobs 自己的两条 transition，
不扩大 composition/fixture 例外，不改中立契约或 B 的 Node/engine schema。

协调者授权的跨模块同步仅涉及 web 的运营通知/公开媒体测试与本地媒体 e2e 夹具：注入
中立 jobs 依赖、从 runner 参数取得步骤类型，移除旧 nonRetryable 工厂；原断言和业务行为
保持。没有修改 web 生产代码或扩大检查器例外。

2026-10-12 本 worktree 验证：jobs 16 文件/66 用例通过（Node 单元 25、CF 41）；web 的
运营通知/公开媒体定向 11 用例通过；根 check、check:deps、check:singletons、typecheck、
test（26 tasks）、build 和 dedupe --check 通过。首次根 DB setting 用例存在 4ms 时间差，
原断言未改，复测通过。本地 test:e2e:smoke 1 用例通过；staging 仅等待合入 main 后自动发布。
