import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  billing: vi.fn(),
  cleanup: vi.fn(),
  heartbeat: vi.fn(),
  deletion: vi.fn(),
  workspace: vi.fn(),
  metrics: vi.fn(),
  db: {},
}))
vi.mock('@product-res/storage', () => ({ cleanupFiles: mocks.cleanup }))
vi.mock('../src/ai.ts', () => ({}))
vi.mock('../src/billing.ts', () => ({
  BILLING_HOURLY_CRON: '0 * * * *',
  BILLING_RETRY_CRON: '*/10 * * * *',
  BILLING_DAILY_CRON: '0 4 * * *',
  runBillingSchedule: mocks.billing,
}))
vi.mock('../src/queues/billing.ts', () => ({ handleBillingBatch: vi.fn() }))
vi.mock('../src/queues/email.ts', () => ({ handleEmailBatch: vi.fn() }))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: mocks.deletion }))
vi.mock('../src/cron/heartbeat.ts', () => ({
  HEARTBEAT_CRON: '*/5 * * * *',
  runHeartbeat: mocks.heartbeat,
}))
vi.mock('../src/cron/metrics-daily.ts', () => ({ runMetricsDaily: mocks.metrics }))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: mocks.workspace,
}))

import { type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import { logJobObserver } from '../src/observer.ts'

const bucket = { delete: vi.fn() }
const context = {
  db: { business: () => mocks.db },
  files: { available: true, value: bucket },
  observer: logJobObserver,
} as unknown as JobsContext

beforeEach(() => {
  vi.resetAllMocks()
  mocks.billing.mockResolvedValue(undefined)
  mocks.cleanup.mockResolvedValue({ deleted: 1, failed: 0 })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it.each(['billing', 'files'])('runs both ten-minute jobs when %s fails', async (failure) => {
  if (failure === 'billing') mocks.billing.mockRejectedValueOnce(new Error('Billing unavailable'))
  else mocks.cleanup.mockResolvedValueOnce({ deleted: 0, failed: 1 })
  await expect(runJobsSchedule('*/10 * * * *', new Date(), context)).rejects.toThrow(
    'Ten-minute maintenance cron failed',
  )
  expect(mocks.billing).toHaveBeenCalledOnce()
  expect(mocks.cleanup).toHaveBeenCalledWith(mocks.db, bucket)
})

it('reduced half-hour trigger runs heartbeat and ten-minute maintenance exactly once', async () => {
  await runJobsSchedule('*/30 * * * *', new Date(), context, { cronProfile: 'reduced' })
  expect(mocks.deletion).toHaveBeenCalledOnce()
  expect(mocks.heartbeat).toHaveBeenCalledOnce()
  expect(mocks.billing).toHaveBeenCalledExactlyOnceWith('*/10 * * * *', context, undefined)
  expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith(mocks.db, bucket)
  expect(mocks.workspace).not.toHaveBeenCalled()
  expect(mocks.metrics).not.toHaveBeenCalled()
})

it.each(['heartbeat', 'billing', 'files'])(
  'reduced trigger still runs the other tasks when %s fails',
  async (failure) => {
    if (failure === 'heartbeat') mocks.heartbeat.mockRejectedValueOnce(new Error('DB unavailable'))
    else if (failure === 'billing') mocks.billing.mockRejectedValueOnce(new Error('Billing failed'))
    else mocks.cleanup.mockResolvedValueOnce({ deleted: 0, failed: 1 })
    await expect(
      runJobsSchedule('*/30 * * * *', new Date(), context, { cronProfile: 'reduced' }),
    ).rejects.toThrow('Reduced maintenance cron failed')
    expect(mocks.deletion).toHaveBeenCalledOnce()
    expect(mocks.heartbeat).toHaveBeenCalledOnce()
    expect(mocks.billing).toHaveBeenCalledOnce()
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  },
)

it('default profile keeps all five original triggers and task groups', async () => {
  const scheduledAt = new Date('2026-10-13T03:00:00Z')
  for (const cron of ['*/5 * * * *', '0 3 * * *', '0 * * * *', '*/10 * * * *', '0 4 * * *'])
    await runJobsSchedule(cron, scheduledAt, context)
  expect(mocks.deletion).toHaveBeenCalledOnce()
  expect(mocks.heartbeat).toHaveBeenCalledOnce()
  expect(mocks.workspace).toHaveBeenCalledOnce()
  expect(mocks.metrics).toHaveBeenCalledExactlyOnceWith(context, scheduledAt.getTime())
  expect(mocks.billing.mock.calls.map(([cron]) => cron)).toEqual([
    '0 * * * *',
    '*/10 * * * *',
    '0 4 * * *',
  ])
  expect(mocks.cleanup).toHaveBeenCalledOnce()
})

it('reduced profile keeps hourly billing and both daily triggers', async () => {
  const scheduledAt = new Date('2026-10-13T03:00:00Z')
  for (const cron of ['0 * * * *', '0 3 * * *', '0 4 * * *'])
    await runJobsSchedule(cron, scheduledAt, context, { cronProfile: 'reduced' })
  expect(mocks.billing.mock.calls.map(([cron]) => cron)).toEqual(['0 * * * *', '0 4 * * *'])
  expect(mocks.workspace).toHaveBeenCalledOnce()
  expect(mocks.metrics).toHaveBeenCalledExactlyOnceWith(context, scheduledAt.getTime())
  expect(mocks.heartbeat).not.toHaveBeenCalled()
  expect(mocks.cleanup).not.toHaveBeenCalled()
})

it.each([
  ['unknown', '*/30 * * * *', 'cron.unknown_profile'],
  ['default', '*/30 * * * *', 'cron.unknown_trigger'],
  ['reduced', '*/5 * * * *', 'cron.unknown_trigger'],
  ['reduced', '0 0 * * *', 'cron.unknown_trigger'],
])('rejects and logs unsupported profile %s or trigger %s', async (cronProfile, cron, event) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(runJobsSchedule(cron, new Date(), context, { cronProfile })).rejects.toThrow(
    'Unknown cron',
  )
  expect(error).toHaveBeenCalledTimes(2)
  expect(JSON.parse(error.mock.calls[1]?.[0] as string)).toMatchObject({ event: 'jobs.exception' })
  expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({
    event,
    profile: cronProfile,
    cron,
  })
  for (const run of [
    mocks.deletion,
    mocks.heartbeat,
    mocks.billing,
    mocks.cleanup,
    mocks.workspace,
  ])
    expect(run).not.toHaveBeenCalled()
})

it('rejects unavailable file storage before opening a database or deleting rows', async () => {
  const business = vi.fn()
  const { runFilesCleanup } = await import('../src/cron/files-cleanup.ts')
  await expect(
    runFilesCleanup({ db: { business, public: business }, files: { available: false } }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', status: 503 })
  expect(business).not.toHaveBeenCalled()
  expect(mocks.cleanup).not.toHaveBeenCalled()
})
