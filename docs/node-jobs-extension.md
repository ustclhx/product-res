# Node jobs 注册与扩展

业务使用 `@product-res/platform` 的 `QueueBatch`、`DeadLetterSink`、`QueueProducer`、
`TransactionalEnqueue`、`Scheduler`、`WorkflowStep` 等中立契约。
`@product-res/platform/node` 仅由 Node composition 或明确的 Node 测试导入；
业务处理器不依赖 DBOS SDK、Workers 全局对象或 `process.env`。

## 注册位置与启动顺序

`apps/jobs/src/index.node.ts` 校验配置，调用 `node/runtime.ts` 的 `startNodeJobs`。
在 `createNodeJobEngine` 的 `register(engine)` 中创建适配器，注册同版本完整的
queue/workflow/schedule handler，依次 `await queues.prepare()` 与
`await scheduler.prepare()`。DBOS launch 完成后，在 `start()` 调用
`queues.start()` 与 `scheduler.start()`，最后监听健康端口。

新增业务处理器放在 `apps/jobs/src/queues` 或 `cron`；Node 的注册放在
`src/node/runtime.ts` 或 `registration.ts`。不要修改平台引擎来装配业务。
两个 jobs 必须使用相同 handler 集、队列策略和 applicationVersion，
不同注册集的 DBOS 测试使用不同逻辑数据库。

## 新增队列

先定义消息类型与幂等键，在 Node runtime 的注册阶段添加队列：

```ts
queues.register<ReportMessage>('reports', consumeReports, {
  batchSize: 10,
  batchTimeoutMs: 5_000,
  maxRetries: 5,
  retryDelaySeconds: 30,
  maxRetryDelaySeconds: 900,
  concurrency: 2,
  rateLimit: { limit: 3, periodMs: 10_000 },
})
```

`consumeReports(batch, sink)` 接收中立 `QueueBatch<ReportMessage>` 和
`DeadLetterSink<ReportMessage>`。在消息信任边界校验输入；成功后 `ack()`，
无效消息按既定业务策略确认并告警，暂时失败调用 `retry()`。有效永久失败或
重试耗尽时，先 `await sink.failed(message, { code, retryable })` 再 `ack()`；
失败代码只用机器码，不能含正文或驱动异常。sink 写入失败必须向上传播，
避免提前确认。并行消费的 Promise 覆盖全部成员，用 allSettled 等待整批在途任务。

默认是最大 10 条、5 秒聚合窗、初次加 5 次重试、30 秒起指数退避封顶
900 秒。并发与滑动速率按消息跨 jobs 计额，批内成员和重试均占额度；
上述示例实际批次可能受并发 2 限制。消息至少一次投递，外部副作用须使用
业务幂等键；成功 checkpoint 前崩溃仍可能再次执行。

生产者在目标入口创建后，以中立接口注入业务：

```ts
const { producer, transactionalEnqueue } =
  createNodeQueueProducer<ReportMessage>(db, 'reports')
await producer.send(message)
await db.transaction(async (tx) => {
  await updateReportRequest(tx)
  await transactionalEnqueue.enqueue(tx, message)
})
```

事务示例的业务写入和消息同事务提交，回滚无可执行任务。普通 `send` 不能
替代事务 API；CF 的普通 producer 也不宣称支持此事务保证。消息沿用
`requestId/idempotencyKey`，平台分配 UUIDv7 身份和不随重试变化的 timestamp。

## 新增定时任务

在 `registerNodeJobsSchedules` 调用期间注册，handler 接收原计划时间：

```ts
scheduler.register(
  { id: 'daily-report-v1', cron: '0 2 * * *',
    timeZone: 'Asia/Singapore', missedRun: 'once' },
  async ({ scheduledAt }) => { await runReport(scheduledAt) },
)
```

Asia/Singapore 02:00 对应前一 UTC 日 18:00。既有五条任务保持 UTC，
不使用宿主机时区。`skip` 丢弃未领取的错过计划；`once` 合并为最近一次，
保留原 `scheduledAt`；已领取未完成运行仍恢复。相同 schedule 全程互斥，
业务副作用仍需幂等。修改已持久注册的 cron/时区/补跑策略不能直接覆盖数据库，
应先完成旧运行，再使用版本化任务 ID 和受控变更。

| UTC cron | 业务映射 |
|---|---|
| `*/5 * * * *` | 删除凭据缓存补偿成功后记录 heartbeat |
| `0 * * * *` | 积分过期、年付按月发放 |
| `*/10 * * * *` | hold 回收、Webhook 后处理/退款恢复、独立文件清理 |
| `0 3 * * *` | 独立空间清理和 daily metrics |
| `0 4 * * *` | 订阅/积分对账、退款联系人清理及运营告警 |

每日指标使用原 `scheduledAt` 的前一 UTC 日，重复 upsert 覆盖而不累计。
同一触发器的独立子任务保持 allSettled：即使一项失败也尝试另一项，
最终报告本次调度失败。五分钟任务由 `createNodeCronHeartbeat` 包装，
仅前置补偿成功才写实际成功时间；其他任务不刷新它。

## 功能开关与媒体边界

使用 `template.config.ts` 的 `billing.enabled`、`credits.enabled` 整体开关，
不以支付 provider 列表推断模块启用状态；默认均开启。AI hold handler 按
`ai.text.enabled` 与 image/video 分别注册，AI 依赖现有套餐授权及积分。

关闭计费、积分和 AI 时设置 `billing.enabled: false`、`credits.enabled: false`，
并关闭所有 AI。对应域业务 handler 不注册/执行，email/operations、jobs 和成功
heartbeat 仍启动，不要求支付密钥或计费 seed，也不删除历史账本。文件与空间清理
继续使用既有维护路径，Node 未装配文件能力时跳过文件清理。

## 版本、迁移、连接与停机

先由 migrator 应用业务迁移和 `pnpm --filter @product-res/platform dbos:migrate`，
再以 app DML 凭据启动，运行时关闭自动迁移。readonly 只读 metadata；
app 不取得 DDL 或 migrator 凭据。各注册步骤必须在 launch 前完成。

生产 applicationVersion 是构建固化的完整 SHA，handler/step 名和步骤顺序
保持稳定，同版本重启才复用已成功结果。当前不承诺跨代码版本热重放；
发布先完成旧任务或保留旧 handler/version。自定义工作流在注册阶段使用
`createNodeWorkflow`，step 的时间、随机值和副作用放在 `step.do` 内，结果
为 JSON；不能改旧运行的步骤次序或持久结果形状。

默认 web 业务池 10，每 jobs 业务池 10、native 池 4，双 jobs 总预算 38，
另留迁移与运维余量。`JOB_NATIVE_POOL_MAX` 最小 3；改池上限后重新核算。
双 jobs 的 `JOB_EXECUTOR_ID` 互异，ownership 目录、host/PID namespace
共享且受限；旧进程实际退出后才复用同 ID。详细约束见
[任务引擎运维](runbooks/node-job-engine.md)。

SIGTERM/SIGINT 先停止 HTTP 接收和 engine 领取，调用 queue/scheduler 的
`stopReceiving()`，与 HTTP 后台排空共用停机 deadline；随后 `engine.close()`，
最后关闭 cache 和业务池。sleep/wait/未完成 step 保留在 PG 等待同版本恢复。
`close()` 返回不能证明任意不合作 callback 的外部副作用已经停止。

## 本地验证

使用隔离 PG17、Valkey 和 app/migrator/readonly 三角色，连接值仅放被忽略、
受限的环境文件，读入后运行；不要在命令行或报告粘贴值。

```sh
pnpm --filter @product-res/jobs test:node
pnpm --filter @product-res/jobs build:node
pnpm --filter @product-res/jobs test:node:integration
pnpm --filter @product-res/platform test:job-engine
pnpm --filter @product-res/platform exec vitest run --config vitest.scheduler.config.ts
```

为新增任务在独立库先验证注册/prepare/start、消息提交与回滚、一次有效
失败进入 DLQ、原 scheduledAt 和停机后恢复。保持同注册集测试串行，
不同注册集分库。队列生产退避测试真实约 16 分钟，不能用缩短时间替代。
`/internal/live` 是进程探活；`/internal/ready` 和 web `/api/health` 需真实
DB/cache/consumer/scheduler 与有效成功 heartbeat，全新库首次心跳前返回 503。
新增任务不能替代 heartbeat，不能通过手写成功时间使探活变绿。

本批指南快验（2026-10-13）：独立 PG17 逻辑库、DBOS 5.2.11、app 无 DDL，
按上述 register → prepare → launch → start 顺序新增 `reports` 队列与
Asia/Singapore 秒级 schedule。真实事务回滚没有消息，提交消息被消费，
有效永久失败先进入 DLQ，schedule 收到与 ledger 一致的原计划 `Date`；
停止领取后关闭 engine 和业务池。此快验验证扩展接入，不替代生产退避、
同版本长跑恢复或服务器部署验收。
