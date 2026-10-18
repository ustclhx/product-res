import type {
  DatabaseTransaction,
  JsonValue,
  PlatformEnv,
  QueueProducer,
  Scheduler,
  TaskHealth,
  TransactionalEnqueue,
  Workflow,
  WorkflowStep,
} from '../src/index.ts'

// @ts-expect-error 不允许把流传入 Workflow 参数。
export type InvalidWorkflowParams = Workflow<{ stream: { read(): Promise<string> } }>
// @ts-expect-error 不允许把二进制持久化为 Workflow 结果。
export type InvalidWorkflowResult = Workflow<{ taskId: string }, Uint8Array>
// @ts-expect-error 业务 env 不能重新暴露原始 binding 对象。
export type InvalidPlatformEnv = PlatformEnv<{ CACHE: { get(key: string): Promise<string> } }>

/** B spike 的接入形状：只有平台/现有 DB 事务类型，没有引擎类型。 */
export interface JobEnginePort {
  queue: QueueProducer<{ taskId: string }>
  transactional: TransactionalEnqueue<{ taskId: string }>
  workflow: Workflow<{ taskId: string }>
  step: WorkflowStep
  scheduler: Scheduler
  health: TaskHealth
}

export async function submitInTransaction(port: JobEnginePort, tx: DatabaseTransaction) {
  await port.transactional.enqueue(tx, { taskId: 'stable-business-id' })
  const instance = await port.workflow.create({
    id: 'stable-business-id',
    params: { taskId: 'stable-business-id' },
  })
  await instance.sendEvent({ type: 'media-done', payload: { ready: true } })
  await port.step.do(
    'submit',
    { retries: { limit: 3, delayMs: 10_000, backoff: 'exponential' }, timeoutMs: 120_000 },
    async () => ({ jobId: 'provider-id' }),
  )
  await port.step.sleep('poll', 30_000)
  const event = await port.step.waitForEvent('media-result', {
    type: 'media-done',
    timeoutMs: 900_000,
  })
  const payload: Readonly<JsonValue> = event.payload
  port.scheduler.register(
    { id: 'heartbeat', cron: '*/5 * * * *', timeZone: 'UTC', missedRun: 'skip' },
    async ({ scheduledAt }) => {
      scheduledAt.toISOString()
    },
  )
  return { payload, queue: await port.health.queue(), scheduler: await port.health.scheduler() }
}
