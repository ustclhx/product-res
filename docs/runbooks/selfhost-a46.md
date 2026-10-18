# A 4.6：平台迁移整合验收

范围为 `add-selfhost-foundation` 4.6。不实现 Node 生产入口、B 持久任务引擎或 C 对象存储/监控；默认 Cloudflare 构建、e2e-smoke、main 自动 staging 发布仍沿原流水线。

## 实现与边界

- 剩余账号、删除、dev 邮件/Workflow、health 五个入口改用 `getWebRuntime()`。邮件/Workflow 在调用前检查中立能力；CF JSON 投递与状态映射由既有 adapter 负责。
- 删除旧 `getAuth(env, db)`、`billingDeletionSteps(env, db)`、`legacyRequestMetadata` 和 auth 的旧 `KvStore`/`RateLimiter` 类型导出。
- 环境绑定校验与 Sentry SDK 移入明确登记的 `server/cloudflare/` 辅助入口。共享 Start 异常链通过 runtime 观测注入；CF 原 Sentry 配置、release、请求身份与过滤规则保留。管理员验证仍实时授权、同源限制、先提交审计再抛错，审计 IP 使用可信 runtime 元数据。
- health 借用惰性业务数据库 getter，保留原 CF 200/503 body、version、5 秒超时、no-store、实时心跳与脱敏。初始化失败也返回 503，不关闭借用池；Node 完整 readiness 属于 8.1。
- 删除规则的 `transition` 字段及检查器计数豁免。回归测试证明旧 transition 配置不能放行业务导入。没有将迁移业务路径登记为入口或目标夹具。
- web 默认 typecheck 增加 `tsconfig.neutral.json`，覆盖中立 src，只注入 Node/Vite 声明；CF composition、绑定声明、目标辅助测试保持独立检查。manifest 仅增加检查命令，无依赖版本或 lockfile 改动。

## 定向扫描

对 apps/packages 的 TS/TSX/MTS/CTS 扫描 `cloudflare:*`、`Cloudflare.Env` 及 KVNamespace、Fetcher、Queue、Workflow、ExecutionContext、ExportedHandler、Hyperdrive、R2Bucket/R2UploadedPart、RateLimit、MessageBatch、ScheduledController、WorkflowEvent/WorkflowEntrypoint/WorkflowStepConfig、FixedLengthStream 等。排除依赖、构建产物及生成的 worker-configuration/routeTree 声明；逐项区分实际类型、platform 中立 import、注释和字符串。

实际平台依赖仅位于：

| 位置 | 允许原因 |
| --- | --- |
| `packages/platform/src/cloudflare/**` | 平台 CF adapter |
| `packages/storage/src/cloudflare/**` | 目标文件 adapter，R2/FixedLengthStream 隔离 |
| web `server.ts`、`server/cloudflare/{env,sentry}.ts` 与 jobs `index.ts` | 逐文件登记的 CF composition |
| web `env.d.ts`、jobs `worker-env.d.ts` | 逐文件登记的 composition 绑定声明 |
| `scripts/check-deps.rules.json` 的 targetFixtures / targetAdapterFixtures | 明确的 CF 测试、探针和本地 e2e 夹具；仅类型的文件使用空模块列表，不授权平台 import |

业务目录无实际 Workers 全局能力类型。`Workflow` 等同名业务符号来自 `@product-res/platform`；db/config 的 `HyperdriveBinding` 是自定义结构接口。模型/设置的 KVNamespace 注释不是类型依赖。旧无用 CF mock 已从支付入口单元测试移除。Node 中立类型检查不需要 Workers 声明。

## 验证记录

根验证全部通过：

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | Biome、550 个生产文件积分写入扫描、支付边界和工程脚本通过 |
| `pnpm check:deps` | 12 包/2 应用，7 个检查器回归通过 |
| `pnpm check:singletons` | 关键依赖单实例通过 |
| `pnpm dedupe --check` | 通过，无 lockfile 改动 |
| `pnpm typecheck` | 14/14 任务；web CF、中立 Node 与既有 Node 配置通过 |
| `pnpm test` | 26/26 任务，163 文件/1198 用例；web 55/310，jobs 16/66 |
| `pnpm build` | 默认 CF web 构建/18 个公开页预渲染与 jobs dry-run，2/2 通过 |

首次 `pnpm check` 的积分扫描使用 git 文件清单，暂存文件迁移前曾尝试读取旧 env 路径；暂存后复测通过，没有修改检查器忽略规则。

定向 Node 单元（环境、探活、观测与管理员验证）6 文件/16 用例通过；默认本地 CF e2e-smoke 1/1 通过，验证注册、退出/登录、积分包购买与重复回调入账。仅使用 worktree 隔离数据库，运行现有迁移，无新增 SQL 提交或 staging 写入。

合入后 main 自动 staging run 与 `/api/health` 完整合并 SHA 由协调者验收；4.6 不提前勾选 8.3、Node 生产构建或外部凭据验收。不手动部署分支，不归档 change。
