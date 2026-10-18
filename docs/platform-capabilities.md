# 平台能力与 A/B 接口交接

本批实现 `add-selfhost-foundation` 1.1–1.3。Cloudflare 仍为默认构建和部署目标；业务模块迁移属于组 4，Node 基础适配器属于组 2/3，Node 持久任务引擎属于 B。当前没有 Node 生产队列、Workflow 或 Cron。

## 入口与装配

业务仅从 `@product-res/platform` 导入中立类型、`NonRetryableError` 和 `requireCapability`。composition root 显式导入 `@product-res/platform/cloudflare` 或 `@product-res/platform/node`，不使用条件导出或万能 bindings env。中立入口与 Node 入口不读取 process.env、不加载 `cloudflare:*`。Node 类型检查不注入 Workers 全局类型；测试还在真实 Node 子进程中加载两个 package export。

| 能力 | 中立契约 | CF 装配 |
| --- | --- | --- |
| env | `PlatformEnv<C>`，只读已校验标量配置及能力表 | `createCloudflareEnv` 接收 app schema 校验后挑选的标量，binding 引用留在入口 |
| db | `DatabaseAccess.business()/public()`，返回现有 `Database` | `createCloudflareDatabase` 在每请求/事件内创建，分别使用 HYPERDRIVE / HYPERDRIVE_CACHED，闭包限于该次调用，不结束 workerd 客户端 |
| KV | `KeyValueStore`，text/JSON get、string put、秒 TTL、delete | `createCloudflareKv` 使用原 KV binding，TTL 至少 60 秒 |
| 限流 | `RateLimiter.limit('auth'|'ai'|'api', key)` | 原 RL_AUTH / RL_AI / RL_API；保留 key 与限额，缺 binding 拒绝执行 |
| 延续 | `BackgroundTasks.waitUntil(promise)` | `createCloudflareBackgroundTasks(ctx)` 保留 ctx receiver 和原 Promise，CF 继续管理生命周期 |
| 请求 | `RequestMetadata`，应用 requestId、可空 clientIp、可选 cfRay | `createCloudflareRequestMetadata(request)` 仅由可信 CF 入口调用；cf-ray 只是附加字段 |

适配器不能放在模块全局并缓存请求资源。后续组 4 的入口将适配器注入业务上下文；本批不改变现有 handler 的业务调用路径。

## B 签收接口与验收责任

合并后以以下文件作为交接点；PR 列出同一接口清单供协调者和 B 审阅签收。`packages/platform/test/contracts.ts` 是无需引擎类型的 spike 接入类型夹具，随中立类型检查执行；它证明接口可接入，不代表 B 引擎已验收。

| 文件 / 导出 | A 提供的行为 | B 的责任 |
| --- | --- | --- |
| `src/queue.ts` / `QueueProducer<T>` | send(body,{delaySeconds?})、sendBatch([{body,delaySeconds?}])，返回 Promise<void> | 持久投递，retry/backoff/concurrency/rate 由队列配置决定 |
| `QueueMessage<T>` / `QueueBatch<T>` | 稳定 id、body、attempts、timestamp，逐条/整批 ack/retry | 至少一次投递；未 ack 重投；耗尽后保留死信 |
| `TransactionalEnqueue<T>` / `DatabaseTransaction` | enqueue(tx,body)，事务类型取自现有 db.transaction 回调参数 | 同一 PG 事务或 outbox，回滚不投递；不能另开引擎连接冒充同一事务 |
| `DeadLetterSink<T>` / `QueueFailure` | failed(message,{code,retryable})，与 ack/retry 分开 | 对有效消息的不可重试/耗尽失败持久记录，完成后才确认；不要沿用 CF 邮件 ack/drop 丢失死信证据 |
| `src/workflow.ts` / `Workflow<P,R>` | create({id?,params})、get(id)，instance.status/terminate/sendEvent | 业务稳定 id；参数、事件、步骤结果只用 JSON；缺实例/终态发事件明确报错 |
| `WorkflowStatus` | queued/running/paused/waiting/completed/failed/terminated | 引擎状态映射到中立枚举，不向业务暴露 DBOS/pg-boss 对象 |
| `WorkflowStep` | do(name,callback) 或 do(name,{retries:{limit,delayMs,backoff},timeoutMs},callback)，sleep(name,durationMs)，waitForEvent(name,{type,timeoutMs}) | 成功步骤持久化、重启续跑；事件按 type FIFO 单次消费，早到事件至少保留 60 分钟 |
| `NonRetryableError` | 两目标共用的不可重试异常，CF 转换为原引擎异常；引擎拒绝时还原为共享类型并保留 `code`（引擎 rejection 放在 `cause`） | 转换到 B 引擎，不重试该步骤 |
| `src/scheduler.ts` / `Scheduler` | register({id,cron,timeZone,missedRun:'skip'|'once'},handler)，handler 收到 scheduledAt:Date；health() | jobs 内调度、锁互斥、补跑策略、心跳；健康读取最近成功 cron 时间 |
| `src/capabilities.ts` / `TaskHealth` | queue() → {status}；scheduler() → {status,lastCronAt}，status 为 up/down/unavailable，lastCronAt 为 UTC ISO 或 null | 实时 backend/consumer readiness 和 scheduler heartbeat，不能用 DB 可达推断 queue up |

`Workflow<P,R>` 的 P/R 受 `JsonValue` 约束；结构性参数对象使用 type alias（如 `type MediaParams = { taskId: string; requestId?: string }`），避免 interface 缺少 JSON 索引签名。步骤结果的 `JsonValue` 类型禁止流、Date 和二进制进入持久化结果。现有媒体 runner 中使用的 `10 seconds` / `2 minutes` / `15 minutes` 在迁移时分别写为 `10_000` / `120_000` / `900_000` 毫秒。业务超时、终态检查、提交幂等规则不变。

Cloudflare Workflow 将 complete 映射到 completed、errored 映射到 failed，waitingForPause/rollingBack 视为 running；unknown 明确返回 WORKFLOW_NOT_FOUND。get 验证原生 handle 是否存在，终态事件返回 WORKFLOW_TERMINAL；发送时发生的原生错误继续传播。step adapter 原样转发毫秒 retry/backoff/timeout、sleep 和事件等待，转换共享 NonRetryableError。原 CF 邮件消费者的有效消息最终失败仍保留 ack/drop；B 的持久死信 hook 在后续 Node handler 接入。

CF `cloudflareTransactionalEnqueue()` 返回 available:false。Node `unavailableTaskCapabilities()` 的 queue、transactionalEnqueue、workflow、scheduler 全部 available:false，health 返回 queue/scheduler unavailable、lastCronAt:null。`requireCapability` 在调用方副作用前抛 CAPABILITY_UNAVAILABLE（503），不提供假成功或内存后端。组 8/9 接入 Node readiness 和真实 B 引擎；完整认证 Compose e2e 仍等待 B。

## Cloudflare Cron 兼容边界

`createCloudflareScheduler` 接收 Wrangler 已部署的 crons，注册仅接受 UTC + missedRun:skip。任意时区、once 补跑或未部署 cron 均明确拒绝。相同 cron 可注册不同 id 的独立任务，scheduled handler 用原 controller.scheduledTime 生成 scheduledAt，allSettled 保证一项失败不阻止其他项；成功时间由既有业务心跳写库，适配器不伪造 lastCronAt。`createCloudflareTaskHealth` 组合明确传入的队列探测与 scheduler.health；CF 没有原生队列 ping，不假装验证消费者就绪。

当前 jobs 的五条 UTC triggers 保持原配置和分派：

| Cron | 既有分派 |
| --- | --- |
| `*/5 * * * *` | 删除清理后记录心跳 |
| `0 3 * * *` | 空间清理与日指标，独立执行 |
| `0 * * * *` | 每小时计费维护 |
| `*/10 * * * *` | 计费补偿与文件清理，独立执行 |
| `0 4 * * *` | 每日计费维护 |

## 平台边界收尾（A 4.6）

`transition` 与检查器的计数豁免已删除；业务目录不再允许 `cloudflare:*`。检查器仍解析静态/动态 import、export、require 与 type import，明确登记的目标入口/夹具和平台 CF 目录才允许对应导入。旧 transition 配置也不能恢复业务豁免，回归用例验证这一点。

web 的 `server/cloudflare/env.ts` 与 `server/cloudflare/sentry.ts` 是显式 CF composition 辅助入口；绑定声明和只含目标类型的测试逐文件登记。`start.ts` 的共享异常处理使用 runtime 注入的 `observability`，CF 仍附请求身份采集，未装配的 Node 目标使用共享日志。Sentry 验证 HTTP 入口使用 runtime 的实时认证、数据库和可信 IP，保留同源限制与先审计再抛错。

账号、删除、dev 邮件/Workflow 和 health 均使用 runtime。health 注入惰性无缓存业务数据库 getter，数据库创建/查询失败仍返回脱敏 503；facade 不关闭借用池。Node 完整 readiness 扩展留组 8。`getAuth(env, db)`、`billingDeletionSteps(env, db)`、`legacyRequestMetadata`、auth 旧 `KvStore`/`RateLimiter` 导出均已移除。

`apps/web/tsconfig.neutral.json` 在默认 typecheck 中检查整个中立 src，仅加载 Node/Vite 全局声明，排除 CF entry、绑定声明和 CF composition 辅助文件。CF 仍单独检查完整 src 和目标夹具。定向扫描的允许位置和本批验收见 [A 4.6 记录](runbooks/selfhost-a46.md)。

## 本批验证

- `pnpm --filter @product-res/platform typecheck`：中立/Node 无 Workers 声明，另行检查 CF 适配器和测试类型，包含 B 接入夹具。
- `pnpm --filter @product-res/platform test`：原生 CF batch 确认/重试，Workflow 状态与事件边界，step 参数与异常转换，UTC Cron 独立执行，KV JSON/TTL，Node 缺失能力与真实 Node 导入。
- `pnpm check:deps`：工程扫描加检查器正反例，含 routes/features 拒绝及清单收缩。
- 根检查、全部现有测试与默认 CF 构建仍为 PR 门槛，e2e-smoke 与 main 自动 staging 发布保持原流水线；合并后的 staging 验收由协调者完成。

## A 4.1：认证与空间的请求上下文

`apps/web/src/server/runtime.ts` 导出中立 `WebRuntime`、`getWebRuntime()` 和
`withWebRuntime(runtime, handler)`。AsyncLocalStorage 隔离每个请求，CF composition entry
`apps/web/src/server.ts` 在环境校验后装配；同一个 requestId 用于日志与响应。数据库和认证
使用请求内惰性 getter，公开页面不会因建立上下文而提前连接数据库。

| runtime 字段 | 使用方式 |
| --- | --- |
| `config` | 已校验的认证标量与 Turnstile site key；不含 bindings，不能整个返回前端 |
| `db` / `auth` | 本请求的业务 facade 与认证实例；实时守卫继续查数据库 |
| `cache` / `rateLimiter` | 平台 KV / 限流契约，限流传入 auth、ai、api policy |
| `requestMeta` | 入口解析的可信 clientIp、应用 requestId 和可选 cfRay |
| `createAuth(db, cache?)` | 为后台事务 facade 与延后提交缓存创建认证实例 |
| `handleAuthRequest(request)` | 保留后台 HTTP 白名单、模拟限制、实时守卫与事务审计 |

`createWebAuth(config, db, deps)` 是中立认证工厂。composition 注入发信 sender、注册准入和
删除步骤；web 共用空间席位与验证后积分钩子。CF 发信仍使用 EMAIL_QUEUE，仅等待入队。
Node composition 由后续组 5/9 装配；B 未接入前不提供临时生产邮件队列。

供 4.2–4.4 owner 迁移：Server Function / API handler 使用
`const runtime = getWebRuntime()` 获取 db、auth、config，替换直接导入
`cloudflare:workers` 与 `getAuth(env, db)`；已有事务或其他 facade 时用
`runtime.createAuth(db)`。审计取 `runtime.requestMeta.clientIp`，防刷调用
`runtime.rateLimiter.limit('ai'|'api', key)`，不重新读取 CF/XFF 头。迁移各自字段时扩展
标量 config/能力并由 composition 显式装配，不把原始 env 传入 runtime。独立业务测试可直接
注入能力，feature 不导入目标 adapter；迁移完成在同一 PR 缩减对应 transition 条目。
A 4.6 已删除旧 `getAuth(env, db)` 与 auth 旧 RateLimiter/KvStore 接线，全部调用方要求请求 runtime。

本批删除 auth options、workspace functions、auth API 与共享 middleware 四个 transition 条目，
精确登记四个 auth CF adapter 测试夹具与一个 Node 集成夹具，没有新增业务例外。auth/web
manifest 与 lockfile 仅增加 platform workspace 依赖。共享入口及后台认证调用方修改经过
协调者授权；计费 customer functions 两个参数改用 Database，以接受中立 middleware facade，
不再要求连接池 owner 的关闭方法，计费逻辑保持原样。

验证命令：既有 `pnpm --filter @product-res/auth test` 验证 CF 行为；
`TEST_VALKEY_URL=<隔离测试缓存> pnpm --filter @product-res/auth exec vitest run --config vitest.node.config.ts`
使用本 worktree PG17 与独立 Valkey 验证基础认证 DB/cache。Node 配置缺资源立即失败，
仅允许同库的隔离 worktree/CI app 与 migrator 连接。覆盖注册登录、缓存读取、实时吊销、撤销、
跨客户端 IP/邮箱防刷和缓存故障 503；关闭 Turnstile 不要求密钥也不调用 siteverify。
测试 sender 仅捕获消息，不替代 B 持久投递验收，完整 Compose auth e2e 仍属于 9.3。

## A 4.4：文件、growth 与公开读取

`WebRuntime.files` 注入 `Capability<Storage>`，`publicDb` 为惰性的公开读 facade。文件 HTTP 与 RPC 在副作用前检查文件能力，媒体提交 POST 也先检查存储，Node 在 C 之前明确返回 503，无任务/预扣。Cloudflare storage 工厂在 web/jobs entry 装配；R2/FixedLengthStream 细节仅由 `@product-res/storage/cloudflare` 导出。C 的 `Storage`/`MediaOutputCopier` 接口见 [storage README](../packages/storage/README.md)，本批验证及 Node 生产预渲染的组 5 边界见 [验收说明](runbooks/selfhost-a4-storage.md)。

公开定价读取接受借用的 Database，不终止进程池；构建快照由脚本关闭自有池。公开页沿用数据库不可达降级，语言处理仅在账号区域读取 auth/db。growth 限流使用请求 runtime 的可信 IP 与 auth policy，发信依赖缺失时在业务写入前拒绝。

## C：Node 存储、邮件与观测接线

Node 生产配置完整时，web 的 `files` 与 `ai.downloadFile` 使用 `@product-res/storage/node`；
jobs 仅注入删除能力，批量 key 逐个等待删除。十分钟维护只在 files 已装配时执行文件清理。
全部 S3 参数未配置和构建预渲染继续 unavailable，部分配置拒绝启动。
媒体 workflow 仍独立 unavailable，storage-only 提交在创建 task/hold 前返回 503。
存储工厂、copier 与 C→B 5.3/5.4 交接见 [文件验收](runbooks/selfhost-c-storage.md)。

Node SMTP 由 jobs composition 显式选择并注入既有 EmailSender；web 继续只负责持久入队，
CF 的 log/resend 通道不变。原初次加五次重试、混合批次独立确认、终态先持久 DLQ 再确认
沿用 B，SMTP 稳定 Message-ID 不承诺幂等。详情见 [jobs 接线](runbooks/selfhost-c-jobs-wire.md)。

Node 早期 ESM 入口在加载应用前初始化唯一进程 observer。web 在 bootstrap、Nitro、Start
之间显式传递身份与受信任 AppError 摘要；每请求与后台成员使用独立 scope，不存全局身份。
正常停机在 A 的业务排空/资源关闭后只使用剩余 deadline 关闭监控，监控失败不改业务退出结果。
source maps、上传入口和未完成外部验收见 [共享接线验收](runbooks/selfhost-c-wire.md)。
