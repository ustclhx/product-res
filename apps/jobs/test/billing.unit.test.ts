import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  runtime: vi.fn(),
  flush: vi.fn(),
  compensation: vi.fn(),
  expiration: vi.fn(),
  annual: vi.fn(),
  hold: vi.fn(),
  subscription: vi.fn(),
  credits: vi.fn(),
  cleanup: vi.fn(),
  heartbeat: vi.fn(),
  workspace: vi.fn(),
  deletion: vi.fn(),
}))
// 计费调度测试固定启用两个 Provider，不依赖生成项目的功能选择。
vi.mock('../../../template.config.ts', async (original) => {
  const { default: config } = await original<typeof import('../../../template.config.ts')>()
  return { default: { ...config, billing: { ...config.billing, providers: ['stripe', 'paypal'] } } }
})
vi.mock('@product-res/billing', async (original) => ({
  ...(await original<typeof import('@product-res/billing')>()),
  createPaymentRuntime: mocks.runtime,
  flushRefundNotifications: mocks.flush,
  runPendingCompensations: mocks.compensation,
  runCreditExpiration: mocks.expiration,
  runAnnualGrants: mocks.annual,
  runHoldSweep: mocks.hold,
  runSubscriptionReconciliation: mocks.subscription,
  runCreditReconciliation: mocks.credits,
  clearResolvedRefundContacts: mocks.cleanup,
}))
vi.mock('@product-res/db', async (original) => ({
  ...(await original<typeof import('@product-res/db')>()),
  createDb: mocks.createDb,
}))

vi.mock('../src/cron/heartbeat.ts', () => ({
  HEARTBEAT_CRON: '*/5 * * * *',
  runHeartbeat: vi.fn(),
}))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: vi.fn() }))
vi.mock('../src/cron/metrics-daily.ts', () => ({ runMetricsDaily: vi.fn() }))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: vi.fn(),
}))

import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  createBillingContext,
  postprocessBillingDelivery,
  recoverBillingDeliveries,
  runBillingSchedule,
} from '../src/billing.ts'
import { runDeletionCleanup } from '../src/cron/deletion-cleanup.ts'
import { runHeartbeat } from '../src/cron/heartbeat.ts'
import { runMetricsDaily } from '../src/cron/metrics-daily.ts'
import { runWorkspaceCleanup } from '../src/cron/workspace-cleanup.ts'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import { logJobObserver } from '../src/observer.ts'
import { handleBillingBatch } from '../src/queues/billing.ts'

const id = '93f577ac-e28b-4ca3-9768-05d4e2aa5649'
const env = {
  config: { PAYMENT_MODE: 'test' },
  db: { business: mocks.createDb },
  cache: {},
  emailQueue: { send: vi.fn() },
  emailTransport: { transport: 'log' },
  files: { available: true, value: { delete: vi.fn() } },
  observer: logJobObserver,
} as unknown as JobsContext
let db: ReturnType<typeof database>
function database() {
  const results: unknown[][] = []
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: Model Drizzle awaitable query builders.
    then: (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve),
  }
  return {
    results,
    query,
    select: vi.fn(() => query),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  }
}
function message(body: unknown) {
  return {
    body,
    id: 'queue-message',
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as QueueMessage<unknown>
}
beforeEach(() => {
  vi.clearAllMocks()
  db = database()
  mocks.createDb.mockReturnValue(db)
  mocks.runtime.mockReturnValue({ providers: {} })
  mocks.flush.mockResolvedValue({ queued: 0, failures: [] })
  mocks.compensation.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 })
  for (const run of [mocks.expiration, mocks.annual, mocks.hold, mocks.subscription, mocks.credits])
    run.mockResolvedValue({ processed: 0, failures: [] })
  mocks.cleanup.mockResolvedValue({ cleared: 0 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
describe('billing jobs', () => {
  it('runs credit maintenance without initializing disabled payment providers', async () => {
    const features = { billing: false, credits: true }
    for (const cron of [BILLING_HOURLY_CRON, BILLING_RETRY_CRON, BILLING_DAILY_CRON])
      await runBillingSchedule(cron, env, features)
    expect(mocks.expiration).toHaveBeenCalledOnce()
    expect(mocks.hold).toHaveBeenCalledOnce()
    expect(mocks.credits).toHaveBeenCalledOnce()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.annual).not.toHaveBeenCalled()
    expect(mocks.compensation).not.toHaveBeenCalled()
    expect(mocks.subscription).not.toHaveBeenCalled()
  })
  it('routes hourly, ten-minute and daily jobs and propagates service failures without secrets', async () => {
    await runBillingSchedule(BILLING_HOURLY_CRON, env)
    expect(mocks.expiration).toHaveBeenCalledOnce()
    expect(mocks.annual).toHaveBeenCalledOnce()
    await runBillingSchedule(BILLING_RETRY_CRON, env)
    expect(mocks.hold).toHaveBeenCalledOnce()
    expect(mocks.compensation).toHaveBeenCalledOnce()
    expect(mocks.flush).toHaveBeenCalledOnce()
    mocks.subscription.mockResolvedValue({ processed: 0, failures: [{ error: 'secret=unsafe' }] })
    await expect(runBillingSchedule(BILLING_DAILY_CRON, env)).rejects.toThrow(
      'Billing jobs failed: subscription_reconciliation (1)',
    )
    expect(mocks.credits).toHaveBeenCalledOnce()
    expect(mocks.cleanup).toHaveBeenCalledOnce()
    expect(mocks.runtime).toHaveBeenCalledWith(env.config, ['stripe', 'paypal'], {
      cache: env.cache,
      db,
    })
  })
  it('acks invalid envelopes without initializing providers or touching the database', async () => {
    const messages = [
      message(null),
      message({ v: 2, deliveryId: id }),
      message({ v: 1, deliveryId: 'not-uuid' }),
    ]
    await handleBillingBatch({ messages } as unknown as QueueBatch<unknown>, env)
    for (const entry of messages) {
      expect(entry.ack).toHaveBeenCalledOnce()
      expect(entry.retry).not.toHaveBeenCalled()
    }
    expect(mocks.createDb).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it.each([
    { status: 400, attempts: 2, code: 'BILLING_NON_RETRYABLE', retryable: false },
    { status: 503, attempts: 6, code: 'BILLING_ATTEMPTS_EXHAUSTED', retryable: true },
  ])('records Node terminal failure $code before confirming', async (failure) => {
    mocks.runtime.mockImplementationOnce(() => {
      throw new AppError('BILLING_FAILURE', 'Unavailable', { status: failure.status })
    })
    const entry = { ...message({ v: 1, deliveryId: id }), attempts: failure.attempts }
    let finish!: () => void
    const persisted = new Promise<void>((resolve) => {
      finish = resolve
    })
    const failed = vi.fn(async () => {
      await persisted
      entry.ack()
    })
    const consuming = handleBillingBatch(
      { messages: [entry] } as unknown as QueueBatch<unknown>,
      env,
      logJobObserver,
      { deadLetters: { failed } },
    )
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledWith(entry, {
        code: failure.code,
        retryable: failure.retryable,
      }),
    )
    expect(entry.ack).not.toHaveBeenCalled()
    finish()
    await consuming
    expect(entry.ack).toHaveBeenCalledOnce()
    expect(entry.retry).not.toHaveBeenCalled()
  })
  it('keeps CF failures retryable even on the final attempt', async () => {
    mocks.runtime.mockImplementationOnce(() => {
      throw new AppError('BAD_INPUT', 'Invalid', { status: 400 })
    })
    const entry = { ...message({ v: 1, deliveryId: id }), attempts: 6 }
    await handleBillingBatch({ messages: [entry] } as unknown as QueueBatch<unknown>, env)
    expect(entry.retry).toHaveBeenCalledWith({ delaySeconds: 900 })
    expect(entry.ack).not.toHaveBeenCalled()
  })
  it('reports failed dead-letter persistence only after processing the remaining messages', async () => {
    mocks.runtime.mockImplementationOnce(() => {
      throw new AppError('BAD_INPUT', 'Invalid', { status: 400 })
    })
    const invalid = message(null)
    const failedEntry = message({ v: 1, deliveryId: id })
    const success = message({ v: 1, deliveryId: id })
    db.results.push([{ id, status: 'ignored' }], [{ id: 'marker' }])
    const failed = vi.fn().mockRejectedValue(new Error('Persistence unavailable'))
    await expect(
      handleBillingBatch(
        { messages: [invalid, failedEntry, success] } as unknown as QueueBatch<unknown>,
        env,
        logJobObserver,
        { deadLetters: { failed } },
      ),
    ).rejects.toThrow('Events queue batch failed')
    expect(failed).toHaveBeenCalledOnce()
    expect(failedEntry.ack).not.toHaveBeenCalled()
    expect(failedEntry.retry).not.toHaveBeenCalled()
    expect(invalid.ack).toHaveBeenCalledOnce()
    expect(success.ack).toHaveBeenCalledOnce()
  })
  it('records disabled billing without initializing payment providers', async () => {
    const entry = message({ v: 1, deliveryId: id })
    const failed = vi.fn().mockResolvedValue(undefined)
    await handleBillingBatch(
      { messages: [entry] } as unknown as QueueBatch<unknown>,
      env,
      logJobObserver,
      { billingEnabled: false, deadLetters: { failed } },
    )
    expect(failed).toHaveBeenCalledWith(entry, { code: 'BILLING_DISABLED', retryable: false })
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
    expect(entry.ack).not.toHaveBeenCalled()
    expect(entry.retry).not.toHaveBeenCalled()
  })
  it('leaves notification failures unmarked and retries the same persisted delivery successfully', async () => {
    const entry = message({ v: 1, deliveryId: id })
    db.results.push([{ id, status: 'processed' }], [])
    mocks.flush.mockResolvedValueOnce({ queued: 0, failures: ['refund-id'] })
    await handleBillingBatch({ messages: [entry] } as unknown as QueueBatch<unknown>, env)
    expect(entry.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(entry.ack).not.toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
    db.results.push([{ id, status: 'processed' }], [])
    await handleBillingBatch({ messages: [entry] } as unknown as QueueBatch<unknown>, env)
    expect(entry.ack).toHaveBeenCalledOnce()
    expect(db.insert).toHaveBeenCalledOnce()
    expect(mocks.compensation).toHaveBeenCalledTimes(2)
    expect(mocks.flush.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.compensation.mock.invocationCallOrder[1] ?? 0,
    )
  })
  it('rejects uncommitted deliveries and skips marked deliveries', async () => {
    const context = createBillingContext(env)
    db.results.push([{ id, status: 'failed' }])
    await expect(postprocessBillingDelivery(context, id)).rejects.toThrow('not committed')
    db.results.push([{ id, status: 'ignored' }], [{ id: 'marker' }])
    await postprocessBillingDelivery(context, id)
    expect(mocks.flush).not.toHaveBeenCalled()
  })
  it('bounds notification-gap recovery and records only successful postprocessing', async () => {
    db.results.push([{ id }], [{ id, status: 'processed' }], [])
    expect(await recoverBillingDeliveries(createBillingContext(env))).toEqual({ failures: [] })
    expect(db.query.limit).toHaveBeenCalledWith(100)
    expect(db.insert).toHaveBeenCalledOnce()
    const mail = mocks.flush.mock.calls[0]?.[0]
    await mail.queue.send({ v: 1 }, { contentType: 'json' })
    expect(env.emailQueue.send).toHaveBeenCalledWith({ v: 1 })
  })
})

it('preserves P1 dispatcher schedules and routes both billing queues', async () => {
  await runJobsSchedule('*/5 * * * *', new Date(), env)
  expect(runDeletionCleanup).toHaveBeenCalledOnce()
  expect(runHeartbeat).toHaveBeenCalledOnce()
  await runJobsSchedule('0 3 * * *', new Date(), env)
  expect(runWorkspaceCleanup).toHaveBeenCalledOnce()
  // 每日指标汇总与空间清理共用 03:00 触发器
  expect(runMetricsDaily).toHaveBeenCalledOnce()
  await runJobsSchedule(BILLING_HOURLY_CRON, new Date(), env)
  expect(mocks.annual).toHaveBeenCalledOnce()
  for (const queue of [
    'product-res-events',
    'product-res-events-staging',
    'product-res-events-production',
  ]) {
    const entry = message({ v: 1, deliveryId: id })
    db.results.push([{ id, status: 'ignored' }], [{ id: 'marker' }])
    await consumeJobsBatch({ queue, messages: [entry] } as unknown as QueueBatch<unknown>, env)
    expect(entry.ack).toHaveBeenCalledOnce()
  }
})

it('reports failed compensation and still flushes durable notifications on the retry schedule', async () => {
  mocks.compensation.mockResolvedValueOnce({ claimed: 1, completed: 0, failed: 1 })
  await expect(runBillingSchedule(BILLING_RETRY_CRON, env)).rejects.toThrow('compensation (1)')
  expect(mocks.flush).toHaveBeenCalledOnce()
})

it('missing payment credentials keep both providers unavailable without remote requests', async () => {
  const billing =
    await vi.importActual<typeof import('@product-res/billing')>('@product-res/billing')
  const remote = vi.fn()
  const runtime = billing.createPaymentRuntime({ PAYMENT_MODE: 'test' }, ['stripe', 'paypal'], {
    fetch: remote,
  })
  expect(runtime.providers).toEqual({})
  expect(runtime.readiness).toEqual([
    { id: 'stripe', available: false },
    { id: 'paypal', available: false },
  ])
  expect(remote).not.toHaveBeenCalled()
})

it('enqueues reconciliation failures after the existing durable audit and preserves cron failure reporting', async () => {
  const send = vi.fn().mockRejectedValue(new Error('queue offline'))
  const workspaceId = '93f577ac-e28b-4ca3-9768-05d4e2aa5649'
  mocks.credits.mockImplementationOnce(async (_db, { alert }) => {
    await alert({
      job: 'credit_reconciliation',
      workspaceId,
      targetId: workspaceId,
      error: 'private',
    })
    return { processed: 0, failures: [{ workspaceId }] }
  })
  await expect(
    runBillingSchedule(BILLING_DAILY_CRON, { ...env, eventsQueue: { send, sendBatch: vi.fn() } }),
  ).rejects.toThrow('credit_reconciliation (1)')
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    v: 1,
    operations: [{ event: 'reconciliation.failed', workspaceId }],
  })
  expect(JSON.stringify(send.mock.calls)).not.toContain('private')
  expect(mocks.cleanup).toHaveBeenCalledOnce()
})

it('payment configuration failure prevents scheduled work and keeps billing deliveries retryable', async () => {
  mocks.runtime.mockImplementation(() => {
    throw new AppError('BILLING_UNAVAILABLE', 'Payment configuration unavailable', { status: 503 })
  })
  await expect(runBillingSchedule(BILLING_DAILY_CRON, env)).rejects.toMatchObject({ status: 503 })
  expect(mocks.subscription).not.toHaveBeenCalled()
  expect(mocks.credits).not.toHaveBeenCalled()
  const entry = message({ v: 1, deliveryId: id })
  await handleBillingBatch({ messages: [entry] } as unknown as QueueBatch<unknown>, env)
  expect(entry.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  expect(entry.ack).not.toHaveBeenCalled()
  expect(db.select).not.toHaveBeenCalled()
  expect(db.insert).not.toHaveBeenCalled()
})

it.each(['workspace', 'metrics'] as const)(
  'runs both daily maintenance jobs when %s fails',
  async (failure) => {
    const workspace = vi.mocked(runWorkspaceCleanup)
    const metrics = vi.mocked(runMetricsDaily)
    workspace.mockResolvedValueOnce(undefined)
    metrics.mockResolvedValueOnce(undefined)
    if (failure === 'workspace')
      workspace.mockReset().mockRejectedValueOnce(new Error('Workspace unavailable'))
    else metrics.mockReset().mockRejectedValueOnce(new Error('Metrics unavailable'))
    await expect(runJobsSchedule('0 3 * * *', new Date(), env)).rejects.toThrow(
      'Daily maintenance cron failed',
    )
    expect(workspace).toHaveBeenCalledOnce()
    expect(metrics).toHaveBeenCalledOnce()
  },
)
