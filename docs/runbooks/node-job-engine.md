# Node 任务引擎运维

本 runbook 对应 DBOS SDK **5.2.11**（MIT）及 `job_engine` 自有事务消息 inbox。精确版本锁定于 `packages/platform/package.json` 与 lockfile；生产不使用范围版本自动升级。Cloudflare 队列不受本 runbook 影响。

## 初始化与迁移

使用一次性 migrator 进程，顺序是：版本控制的业务迁移 → `DBOS.migrate` 公共 API 与权限 → app/jobs 启动。运行时 `runMigrations: false`，app 只有必要 DML 权限，不能授予 CREATE/ALTER 解决启动失败。

1. 协调者在 main 统一生成业务迁移：`pnpm --filter @product-res/db exec drizzle-kit generate --name node_job_engine`。该命令读取 `src/schema/index.ts`，覆盖 `job_engine` pgSchema；队列、事件与调度表对应迁移必须全部就绪。审阅 SQL 与 metadata，再在隔离数据库验收；worker 不提交迁移。
2. 配置该环境的 `MIGRATION_DATABASE_URL`（migrator 凭据）后，运行 `pnpm --filter @product-res/db db:migrate`。不要把连接串粘贴到终端命令或报告。
3. 在仓库根执行公共迁移入口：`node --experimental-strip-types packages/platform/src/node/job-engine-migrate.ts`。它调用 `DBOS.migrate`；`DBOS_APPLICATION_ROLE` 默认 `app`，按需配置 `DBOS_READONLY_ROLE=readonly`。该进程使用 migrator URL，只输出固定结构化事件。
4. 业务/schema 与 native schema 均成功后才启动 jobs，app 使用独立 DML URL。迁移入口失败必须停止发布，不以 app 自动迁移兜底。

升级在隔离库复制备份后，固定新 SDK 版本，重复迁移、事务提交/回滚、批次混合结果、双实例限额、重启恢复和保留期边界验证。使用未迁移的旧 native schema 启动必须明确失败；SDK 启动成功不代表业务表兼容。回滚前停止领取并保留 inbox/checkpoint；旧代码不兼容新 schema 时恢复匹配版本备份或继续使用匹配版本引擎。跨代码版本热重放尚未承诺：先完成/暂停旧运行，或保留旧 handler 与稳定 step 次序、`applicationVersion`。

## 连接、轮询与 ownership

当前默认 web 业务池 10；每个 jobs 业务池 10，native `pg` 池 4。ownership 专用连接从这 4 个 native 连接中借出，不另加 1；双 jobs 默认上限为 **10 + 2 × (10 + 4) = 38**。native 池最少 3。迁移额外使用独立 max=1 池及公共迁移 API 的临时连接，安排在 app 启动前；health 复用已建业务池。PG 管理、备份和运维连接另留余量，38 不是整机资源验收结论。改业务/native 池大小时重新预算并观察 `pg_stat_activity`。

队列默认 250ms 轮询；每队列最多 10 条、最长 5 秒聚合窗口。并发/滑动速率按消息计额，批内成员与重试都计入，各队列独立。默认初次加最多 5 次重试，共 6 次；30 秒指数退避，封顶 900 秒。业务事务直接写 `job_engine.message`，提交前不发布；普通 `send` 不提供业务事务原子保证。批次发布 ID 固定为 `queue-batch:<batch UUID>`，不另建 outbox。

每个 jobs 必须有稳定且互异的 `executorId`，同一 executor 跨重启保持相同主机名。所有 jobs 共享同一个持久、受限的本机 `ownershipDirectory`。Node 入口未显式配置 `JOB_EXECUTOR_ID` 时使用 `hostname()`；容器必须固定 hostname，不能沿用每次重建随机变化的容器名。DB advisory 会话锁与 exclusive 本机 owner 文件共同保护启动；Linux 另由进程生命周期内核锁保护（见下段）。文件记录每个 incarnation 的 PID、host、PID namespace inode、token，Linux 还记录宿主 `machineId`、`boot_id` 与 `/proc/<pid>/stat` 的进程启动时间（诊断用，不作退出证明）。Linux 从 `JOB_HOST_ID_FILE` 指定文件读取宿主身份，默认 `/etc/machine-id`；要求32位十六进制且非全零。容器必须只读挂载真实宿主的身份文件，不能以容器内生成的身份替代；宿主克隆也必须确保机器身份互异。

Linux runtime 必须提供 `flock(1)`（已实查正式 Debian slim jobs 镜像）。启动时 Node 自己打开 `<executor>.lock` 与本 incarnation 新建的 `<executor>.<token>.lock`，把描述符交给 `flock -n -x 3` 加锁后 flock 立即退出；`flock` 锁属于打开文件描述，仍由 Node 进程持有的描述符承载，描述符永不关闭。因此锁只在该 Node 进程真正退出（正常 exit、SIGKILL、OOM、容器删除或宿主 reboot）后由内核释放；engine close、DB 锁释放、helper 进程退出都不释放它。同一宿主内核上，不同容器/PID namespace 经同一 named volume 对同一 inode 加 flock 互斥，所以无需 `pid:host`。executor 锁拒绝任何仍存活的同 ID 进程并串行化初始化；token 锁供其他进程以非阻塞共享锁探测某个 token 的 incarnation 是否已退出。`.lock` 文件持久保留，不在运行或恢复期间删除/替换（加锁后核对路径仍指向同一 inode）；ownership 卷必须是本机文件系统，不能是跨主机的网络卷。

退出证明先核对 host，不同 hostname 一律拒绝回收。Linux 还要求旧/当前 `machineId` 相同：flock 只在同一内核有效，恢复到另一台机器的卷没有持锁者，不能据此证明旧机退出，不同机器或旧记录缺宿主身份时拒绝回收。满足后，旧 incarnation 的 token 锁文件存在且非阻塞共享锁成功即证明其进程已退出；锁文件缺失（含本契约之前的记录）、打不开、仍被持有或 flock 调用失败都不能放行。不再以 PID namespace、boot ID 或 PID 启动时间推断 Linux 进程退出。非 Linux 开发环境保留同 namespace 下 `kill(pid, 0)` 返回 `ESRCH` 的证明。

Selfhost Compose 为 jobs 固定 `hostname=${JOB_EXECUTOR_ID:-jobs-1}`，并设置同值 executor ID；`job_owners` named volume 挂载到 `/app/.data/job-owners`，宿主 `/etc/machine-id` 只读挂载到 `/run/job-host/machine-id` 并设置 `JOB_HOST_ID_FILE`。jobs 不使用 `pid:host`，保持独立 PID namespace；容器重建与宿主 reboot 均由内核释放旧进程的锁提供证明。双副本必须分别配置不同且稳定的 hostname/ID、挂载同一 owner 目录并注册同版本完整 handler 集；不要对这个固定身份的 service 盲目执行 `docker compose up --scale jobs=2`。不同 hostname 的副本不能代替原 executor 证明退出，共享目录本身不提供跨 hostname 接管。

**BREAKING：** 修复前镜像（`0813050` 及更早）从未部署到真实服务器，因此不提供缺少 `machineId` 或 token 锁文件的旧 Linux owner 记录升级迁移路径。正式 flock 版本须以全新 ownership 和数据库卷部署；旧记录会明确拒绝自动接管，不自动修改 JSON、不删除目录或更换 executor ID 绕过拒绝。隔离旧测试环境保留其证据后独立清理，不能将新卷部署称为历史任务迁移。异机恢复的可信退出证明仍为开放设计项，暂停 jobs，等待独立流程与签收。

SIGTERM 先停止领取，受控排空，然后关闭 DBOS/native 池。超时 callback 可能仍执行外部副作用；`close()` 返回、DB 锁释放、网络中断或固定 TTL 均不能证明旧进程退出。**真正退出后**才能复用相同 executor ID 或回收其 batch/permit。外部调用仍使用业务幂等键。

## 只读排查

用 readonly 凭据执行以下查询。查询只取 metadata，禁止 `SELECT *`，不读 `message.body` 或 DBOS inputs/output/error；正文仅供获授权业务重放工具在受控路径读取。

```sql
-- 未完成消息、尝试及原始接收时间；created_at 不随重试改变。
SELECT id, queue, request_id, created_at, available_at,
       state, attempts, batch_id, finished_at
FROM job_engine.message
WHERE state IN ('pending', 'claimed', 'running')
ORDER BY available_at, id LIMIT 100;

SELECT id, queue, state, size, executor_id, executor_token,
       created_at, finished_at
FROM job_engine.batch
ORDER BY created_at DESC LIMIT 100;

SELECT message_id, queue, attempts, code, retryable, created_at
FROM job_engine.dead_letter
ORDER BY created_at DESC LIMIT 100;

SELECT queue, message_id, batch_id, attempt, started_at
FROM job_engine.start
ORDER BY started_at DESC LIMIT 100;

-- native 状态只读，不修改第三方表。
SELECT workflow_uuid, status, name, executor_id, application_version,
       created_at, updated_at, recovery_attempts, queue_name
FROM dbos.workflow_status
WHERE workflow_uuid LIKE 'queue-batch:%'
ORDER BY created_at DESC LIMIT 100;
```

`acked/dead` 是消息终态，`completed/failed` 是批次终态；DBOS SUCCESS 只表示 workflow 返回，不能代替业务成功。批次失败后仍有 claimed/running 消息时先排查 ownership 与恢复器，不修改状态使列表“变绿”。错误摘要是机器码；日志输出 `messageId/queue/attempt/requestId/jobId` 与计数，不输出邮件验证码、payload、驱动异常、连接串或 SDK error。

## 手动处置

- 死信重放：先查业务副作用是否已经成功以及失败原因，修正原因后，经获授权重放工具读取原消息并用 producer/业务事务重新入队。创建**新的消息 UUID**，保留原业务 `idempotencyKey` 与 `requestId`，记录新旧身份映射；保留原死信直到保留期结束。不要把原死信行改回 pending 或 reset attempts，也不要为规避去重生成新业务幂等键。
- 卡住批次：核对 native 状态、batch executor/token 及对应 incarnation 文件。先停止该实例，按前述相同 host/machineId 下 token 锁存在且非阻塞共享 flock 成功的规则取得 Linux 退出证明，再让相同稳定身份的 adapter 恢复器按原消息与批次身份修复。记录旧/当前身份及证明依据；boot ID、PID namespace 或其他容器中看不到同号 PID 都不能单独作为 Linux 退出证据。禁止直接释放仍可能活着的 permit、删除 active batch/start、根据年龄或心跳缺失进行 TTL 接管，也不以清除 owner 文件或随机更换 executor ID 绕过拒绝。
- `.recovering` guard 残留：Linux 先取得 OS flock，再读取 guard 的完整身份，只有同可信宿主域证明对应进程真实退出时才定向删除该一个 guard、独占创建本次 guard。文件证明、删除、替换及本次 guard 清理均在同一个内核锁内，DB 会话锁丢失不会使两个初始化进程交错删除新 guard。活进程、未知身份、不同宿主或损坏记录继续拒绝；不自动猜测旧版本身份。非 Linux 保留原先保守拒绝路径。需要人工处置未知 guard 时，先停止所有可能竞争的 jobs/恢复进程并取得独立可信退出依据；保留 owner 与 incarnation 记录，记录操作者，不清空整个 ownership 目录。
- 清理与重放/DBOS resume 操作互斥；清理期间不复活终态 native workflow。SDK 公共查询与删除不是跨系统原子事务，必须维持终态不被人工恢复的运维约束。

## 保留期与清理

已启动的独立 jobs 维护路径调用 `cleanupNodeQueues(db, options)`（`packages/platform/src/node/job-maintenance.ts`），使用已建业务池和初始化后的 DBOS；只允许一个维护调用在途，低峰运行。不要运行全 schema DELETE、TRUNCATE 或 SDK-wide 清理命令。

| 数据 | 默认与删除条件 |
|---|---|
| 终态消息 | 7 天；finished_at 达到保留期、所属 batch 已安全终态、没有仍保留的 DLQ |
| 死信 | 30 天；created_at 达到死信保留期且原消息满足终态消息清理条件 |
| start 日志 | 至少 `max(60 分钟, startRetentionMs, 队列 rateLimit.periodMs)`；所属业务/native batch 都已终态至少 60 分钟 |
| batch 与 owned native journal | 7 天；业务 finished_at 与 native updatedAt 都达到终态保留期；batch 无剩余 message/start 引用才删除 |

三个可配置保留期均不得小于 60 分钟。未终态、缺 finished_at、未知 native 更新时间或 native 仍 active 时保留；未发布或此前已删除的 native 状态可为空，但业务终态与引用检查仍必须通过。active batch 及其关联消息/start 永不清理，长任务超过保留期也不例外。清理按 queue 行锁与领取/速率统计串行化，不能提前删除滑动窗口 start 计数；大积压可能增加领取延迟，应观察耗时。

native 删除仅使用 `DBOS.deleteWorkflow('queue-batch:<UUID>', false)` 公共 API，先核对 owned handler `product-res-queue-batch-v1`、终态和更新时间；不递归删 child workflows，不写第三方内部表。公共删除会删该 workflow 的 native journal/消息/事件，故本入口仅用于不接受外部早到事件的 queue-batch，不涉及其他 workflow、scheduler 或未来 event inbox。

协调者确认 2.5 只验收队列域清理与其他事件数据的保留保护；自有 FIFO event inbox 的终态清理归 3.3。本入口不访问其事件数据，后续清理必须独立遵守：active 实例永不删，未消费早到事件至少保留 60 分钟；不得仅凭 native 终态删除未来事件，需确认事件归属、消费状态、发送时间及保留期。清理结果仅输出计数；public native 删除与业务 tx 分离，后续业务 tx 失败时下一次清理继续，不能重新发布已终态 queue batch。

本批以模拟清理时钟验证 60 分钟边界、active batch、30 天 DLQ 连带消息保留，以及其他 workflow/native 早到事件未删除。这不代替 3.3 的真实 60+ 分钟等待；整机预算与新加坡服务器验收保留为后续独立门槛。

## 最小装配与本地验证

业务数据库由 A 的 `createDb(url, { max })` 创建并拥有，engine/queue 只借用 `Database` facade。composition 先注册固定版本 handler，再启动 DBOS 和 publisher：

```ts
let queues: ReturnType<typeof createNodeQueueAdapter>
let scheduler: ReturnType<typeof createNodeScheduler>
const engine = await createNodeJobEngine({
  database: db, databaseUrl, executorId, applicationVersion, ownershipDirectory,
  async register(engine) {
    queues = createNodeQueueAdapter({
      db, executorId, ownershipToken: engine.ownershipToken,
      assertOwnership: () => engine.assertOwnership(),
      isExecutorStopped: (id, token) => engine.isExecutorStopped(id, token),
    })
    queues.register('email', consumeEmail)
    scheduler = createNodeScheduler({ engine })
    scheduler.register(
      { id: 'report-v1', cron: '0 2 * * *', timeZone: 'Asia/Singapore', missedRun: 'once' },
      ({ scheduledAt }) => runReport(scheduledAt),
    )
    await queues.prepare()
    await scheduler.prepare()
  },
  start() { queues.start(); scheduler.start() },
  stopReceiving() { queues.stopReceiving(); scheduler.stopReceiving() },
})
```

A shutdown 的 `stopReceiving` 先调用 `engine.stopReceiving()`；`closeResources` 调用 `engine.close()`，最后关闭业务池。业务生产端用 `createNodeQueueProducer<T>(db, 'email')`，取 `producer.send/sendBatch` 或 `transactionalEnqueue.enqueue(tx, body)`。消息体沿用 requestId/idempotencyKey，消息 ID 和初始 timestamp 由 inbox 分配且重试不改变。

handler 的 Promise 必须涵盖整批全部在途工作；并行消费使用 allSettled 等待所有成员，不把未完成外部调用留在 detached Promise 中。`ack/ackAll` 与 `retry/retryAll` 使用先到决定；`await sink.failed(...)` 成功后才确认有效终态失败。全部业务副作用仍需幂等。

本地只使用独立测试 PG，先在该库迁移。`db:push` 默认只检查 public；测试 job_engine 时使用临时 Drizzle 配置 `schemaFilter: ['job_engine']` 与 `schema: './src/schema/job-engine.ts'`，发布时仍使用版本控制的迁移。配置 `TEST_JOB_DATABASE_URL`、`TEST_JOB_MIGRATOR_URL`、`TEST_JOB_READONLY_DATABASE_URL` 后运行 `pnpm --filter @product-res/platform test:job-engine`。生产退避测试真实等待约 16 分钟，不使用 fake timers；单独快验可用 Vitest 的 `-t` 筛选。`job-schema-probe.ts` 使用隔离旧库的 `TEST_JOB_OLD_DATABASE_URL`，在升级前输出 rejected、升级后输出 started，只输出安全状态码。结束后仅停止自己启动的测试进程与容器。

所有 jobs 必须注册相同 `applicationVersion` 的完整 handler 集与队列策略。DBOS 恢复会进入全局内部队列，不能让缺少对应 handler 或无法读取同一 ownership 目录的实例接走恢复任务；不同注册集的测试运行使用不同逻辑数据库，不并发复用同一 DBOS 应用版本。

## 工作流装配、恢复与停机（B 3.1–3.4）

在 `createNodeJobEngine` 的 `register(engine)` 内调用
`createNodeWorkflow({ engine, name: 'media-v1', handler })`，handler 接收
`(params, step)`，只能返回 JSON。通过 Node 入口取得适配器；业务仍使用中立
`Workflow` / `WorkflowStep`。所有 jobs 必须注册同一版本的完整 handler 集，不能让缺少
handler 的实例领取恢复任务。`applicationVersion` 由发布版本固定，handler 名包含版本；
同版本重启沿用稳定且互异的 executor ID，并且必须确认旧进程已退出。

业务 ID 是合法非空字符串（含 Unicode），内部 ID 为
`workflow:<handler 名的 base64url>:<业务 ID 的 base64url>`，不与 queue-batch 身份混用。
省略 ID 时生成 UUIDv7；重复 create 复用同一身份，首次持久输入与结果保持不变。
SDK completed 只表示 handler 返回，返回的业务状态仍可能 failed，不据此更新 ai_task。
实例缺失报 `WORKFLOW_NOT_FOUND`，终态事件报 `WORKFLOW_TERMINAL`。

命名步骤在一个流程中唯一，顺序稳定；随机值、当前时间和副作用在 `step.do` 内获取并
保存 JSON 结果。`retries.limit` 不包含首次，所有时间单位为毫秒；linear 为
`delayMs / 2×delayMs / 3×delayMs`，exponential 为 `delayMs / 2×delayMs / 4×delayMs`。
每次失败结果与重试 sleep 分别持久保存，成功 callback 在恢复时不再调用。
`NonRetryableError` 不重试，handler 仍可捕获它完成失败结算。
`WORKFLOW_STEP_TIMEOUT` 表示尝试超时，不能强行停止不合作 callback；其迟到结果被
丢弃，但外部副作用仍可能发生，必须依靠业务幂等或底层取消信号。副作用已提交而 step
checkpoint 未提交时，恢复可重试；不要宣称任意副作用 exactly-once。

`sleep` 使用原生持久唤醒时刻。`waitForEvent` 使用自有 wait 日志保存首次 deadline，
重启不延长；超时报可捕获的 `WORKFLOW_EVENT_TIMEOUT`，随后可按既有业务策略轮询。
事件可在 queued 或 sleep 中发送，按 type/单调序号 FIFO，事件消费与 wait JSON 结果
在同一事务提交。事件时间持久为 UTC ISO 字符串，API 还原为 `Date`。截止后到达的事件
不完成原等待，仍可用于后续等待。不要使用 DBOS native recv 替代这一 FIFO 语义。

停机先由 A 的 stopReceiving hook 调用每个 workflow adapter 的 `stopReceiving()` 和
队列 publisher 的停止入口，再发起 `engine.close()`；DBOS shutdown 先停止 native
队列领取与恢复接收，再在配置的 `shutdownTimeoutMs` 内排空。之后关闭业务池。
超时的 sleep/wait/未完成 step 保留在 PG，真正退出后由相同版本恢复；不要通过
terminate、清空事件或删除 journal 来模拟停机。停止接收后新 create 报
`WORKFLOW_STOPPING`，在途业务请求应先排空，再关闭其使用的资源。

本期只承诺同版本恢复；升级前先完成旧任务，或保留旧版本 handler 与兼容的步骤次序。
不能原地修改旧 handler 的 do/sleep/wait 顺序或持久结果形状并热重放旧实例。
回滚时也保留 native checkpoint、event inbox 和 wait 日志，确认 schema/代码版本匹配。

### 事件 schema、权限与清理

协调者合并后生成新增两张表的迁移：
`pnpm --filter @product-res/db exec drizzle-kit generate --name node_workflow_events`。
先应用业务迁移，再运行 `pnpm --filter @product-res/platform dbos:migrate`，最后启动 jobs。
app 拥有事件表 DML 和序号 sequence USAGE；readonly 仅能读以下摘要列，不能读 payload
或 wait result。初始化/升级须复验固定版 `dbos.workflow_status` 的
`workflow_uuid/status/name/updated_at` 及行锁：发送和消费只读取/锁定该表，从不手写第三方表。

```sql
SELECT id, sequence, workflow_id, type, created_at, consumed_at
FROM job_engine.workflow_event
ORDER BY sequence LIMIT 100;

SELECT id, workflow_id, name, type, deadline, state, created_at, finished_at
FROM job_engine.workflow_wait
ORDER BY created_at DESC LIMIT 100;
```

维护路径单独调用 `cleanupNodeWorkflowEvents(db, { terminalRetentionMs })`，默认 7 天，
最短 60 分钟。只删自有 event/wait；native journal 由另行获授权的运维流程管理。
实例必须是本模块的已知 native 终态且 updated_at 已达到保留期，事件/wait 自身创建时间
也达到保留期，才可删；未消费事件同样至少保留 60 分钟。active、缺失 native 状态或
未知更新时间均保留，长任务不因年龄被删。清理与人工 resume 互斥，不修改终态使其复活。
每实例短事务与发送/消费使用同一 native 行锁，日志只报告删除计数，不输出 payload。

本地快验：配置隔离的 `TEST_JOB_DATABASE_URL`、`TEST_JOB_MIGRATOR_URL` 与
`TEST_JOB_READONLY_DATABASE_URL` 后，执行
`pnpm --filter @product-res/platform exec vitest run --config vitest.workflow.config.ts`。
真实长跑另设 `TEST_WORKFLOW_LONG=1` 并筛选 `-t 'real 61-minute'`；同一逻辑数据库不能并发跑
注册集不同的 DBOS suite，长跑与快验使用独立数据库。长跑使用真实时钟，不用 fake timers
或把数据库时间改老来冒充 60+ 分钟事件/1–2 小时流水线验收。

## Node apps 装配与探活

生产入口为 `apps/jobs/src/index.node.ts`，资源与生命周期在
`apps/jobs/src/node/runtime.ts`，五条 UTC 业务注册在
`apps/jobs/src/node/registration.ts`。新增任务按 [Node jobs 扩展指南](../node-jobs-extension.md)
接入；不在平台 package 导入业务 app。

Jobs 从 `JOB_EXECUTOR_ID`（Node 入口默认 `hostname()`，Compose 默认 `jobs-1`）、`JOB_OWNERSHIP_DIRECTORY`
（默认 `.data/job-owners`）和 `JOB_NATIVE_POOL_MAX`（默认 4，最小 3）读取引擎参数。
版本使用 Node 构建固化的完整 SHA。双 jobs 使用互异且稳定的 hostname/executor ID，遵守前述共享
ownership 目录、Linux 退出证明与同版本完整注册集约束。

`GET /internal/live` 仅检查进程，`GET /internal/ready` 实时检查 DB、Valkey、
真实 queue backend/consumer、scheduler 与五分钟成功心跳，返回完整版本及
`jobs.lastCronAt`，响应 `no-store`。首次成功心跳前，缺记录、消费者停止或
心跳陈旧超过 10 分钟时 readiness 为 503；进程存活不推进成功时间。

Web 配置 `JOBS_URL`（默认 `http://jobs:3001`），从 jobs 的 `/internal/ready`
取得任务探测结果，并与自己的 DB/Valkey 探测组合为 `/api/health`。
邮件与事件生产者直接写同库的 PG inbox，无需在 web 启动 DBOS；因此先完成
jobs 的队列 `prepare()` 再接受生产流量。Jobs 的内部端点不映射公网。

Node 文件能力尚未装配时跳过文件清理分支，媒体 Workflow 继续 unavailable，
媒体请求在 hold 前拒绝；本次装配不代表对象存储或媒体验收完成。
关闭计费、积分与 AI 的域处理器仍保留 jobs、email/operations 和成功 heartbeat，
具体开关组合与验证命令见扩展指南。

