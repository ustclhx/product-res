# Design

## 背景

`refreshStudy` → `buildSnapshot` → `InsightAi.generate` → `startWorkspaceChat`，并 `await started.result.text` 与 `started.done`。
一次请求的耗时 = 读数据 + 模型生成 + 结算。经 Tunnel 访问时超过约 100 秒即 524。

## 决策

### D1 执行位置：web 进程的 BackgroundTasks，而不是 jobs 队列

AI 调用必须复用 `startWorkspaceChat`（权益、预扣、定价快照、检查点、结算、对话记录）。它和它依赖的
`text-stream.ts`、`templateConfig`、在途对话表都在 `apps/web`，`apps/jobs` 不能依赖 `apps/web`；
放进 jobs 需要先把整条文本对话计费链路抽到 `packages/ai`，这是跨模块重构，超出本 change。

因此分析交给请求运行时已有的 `BackgroundTasks.waitUntil`（`startWorkspaceChat` 本身也用它在响应之后完成结算）：

- 请求在快照写入后立即返回，不再受边缘读超时影响。
- Node web 进程停机时 `background.shutdown` 会等待在途任务排空（与 SHUTDOWN_TIMEOUT_MS 同一期限）。
- 进程崩溃时：预扣由 jobs 已有的 AI hold 兜底处理器结算；快照的“分析中”按 D4 过期，用户可重新刷新。

执行方式通过 `RefreshDeps.background`（`AnalysisBackground`）注入。以后若把对话计费链路抽到 package，
可改为投递 Node 队列由 jobs 消费，业务逻辑（`runAnalysis`）不变。

### D2 状态模型（存于快照 JSON，无迁移）

`modules.painPoints.themes` 与 `modules.suggestions` 新增状态：

- `running`：`{ status: 'running', reason, job: { id, fingerprint, modelKey, startedAt, expiresAt } }`
- 完成：沿用 `ok`（`ai.fingerprint` 即 job 指纹，`reusedFrom: null`）
- 失败：沿用 `error`，新增 `code`：`INVALID_OUTPUT`、`AI_FAILED`、`ANALYSIS_EXPIRED`，或计费链路的 AppError code
  （`INSUFFICIENT_CREDITS`、`CREDIT_DEBT`、`UPGRADE_REQUIRED`、`MODEL_UNAVAILABLE`、`AI_PROVIDER_NOT_CONFIGURED`、`RATE_LIMITED`）。

后台写回在事务中 `select … for update` 该快照，只有其状态仍为 `running` 且 `job.id` 相同时才更新，
因此不会覆盖其他路径写入的结果。

### D3 幂等与不重复计费

- 幂等键：研究 ID + 输入指纹（参与分析的差评 ID 与头部竞品 ID 的 SHA-256，沿用 `insightFingerprint`）。
- 刷新在写快照的事务里先取 `pg_advisory_xact_lock(hashtextextended('category-study:<id>', 0))`，
  再读该研究最新快照：若其分析在途、未过期且指纹相同，直接返回该快照，不插入、不启动分析。双击、并发请求与重试都串行到这一判断。
- 沿用规则：取该研究最近一份 AI 结果为 `ok` 的快照，指纹相同则沿用（不再只看最新一份，避免最新一份是“分析中”或失败时错过可沿用的结果）。
- 后台分析只在事务提交后启动；复用在途分析时不会调用模型。

### D4 过期

期限 = `CHAT_HOLD_TTL_MS`（10 分钟，模型流在此时被截止并结算）+ 2 分钟写回余量 = 12 分钟，记在 `job.expiresAt`。
过期在读取时判断：报告页把过期的 `running` 显示为 `error / ANALYSIS_EXPIRED`；刷新时过期的分析不算在途，会新建快照重新分析。
存储不改写，因此极少数迟到的结果仍能写回原快照（已经计费的结果不丢）。

### D5 页面

主题与建议模块在 `running` 时显示“分析中”。报告页在所选快照分析中时每 4 秒 `router.invalidate()` 重新加载
（路由 `staleTime: 0`），状态变为完成、失败或过期后停止。

## 风险与取舍

- 后台任务不是持久任务：进程异常退出会丢失在途分析，只能靠过期后重新刷新（预扣由兜底处理器结算，不会多扣）。
- 未把调用迁到 jobs（见 D1），需协调者决定是否另开 change 抽取对话计费链路。
