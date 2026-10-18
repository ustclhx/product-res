import { defineTemplateConfig } from '@product-res/config'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hold: vi.fn((_type: string, _handler: unknown) => vi.fn()),
  billing: vi.fn(),
  files: vi.fn(),
  deletion: vi.fn(),
  workspace: vi.fn(),
  metrics: vi.fn(),
  heartbeat: vi.fn(),
  chat: vi.fn(() => vi.fn()),
  media: vi.fn(() => vi.fn()),
}))
vi.mock('@product-res/ai', () => ({
  chatHoldSweeper: mocks.chat,
  mediaTaskHoldSweeper: mocks.media,
}))
vi.mock('@product-res/billing', () => ({ registerHoldSweeper: mocks.hold }))
vi.mock('@product-res/db', async (original) => ({
  ...(await original<typeof import('@product-res/db')>()),
  recordLastCronAt: mocks.heartbeat,
}))
vi.mock('../src/billing.ts', () => ({
  BILLING_HOURLY_CRON: '0 * * * *',
  BILLING_RETRY_CRON: '*/10 * * * *',
  BILLING_DAILY_CRON: '0 4 * * *',
  runBillingSchedule: mocks.billing,
}))
vi.mock('../src/queues/billing.ts', () => ({ handleBillingBatch: vi.fn() }))
vi.mock('../src/queues/email.ts', () => ({ handleEmailBatch: vi.fn() }))
vi.mock('../src/cron/files-cleanup.ts', () => ({ runFilesCleanup: mocks.files }))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: mocks.deletion }))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: mocks.workspace,
}))
vi.mock('../src/cron/metrics-daily.ts', () => ({ runMetricsDaily: mocks.metrics }))

import { registerAiHoldSweepers } from '../src/ai.ts'
import type { JobsContext } from '../src/handlers.ts'
import { getNodeJobFeatures, registerNodeJobsSchedules } from '../src/node/registration.ts'

const disabled = defineTemplateConfig({
  app: { name: 'test', url: 'https://example.test', supportEmail: 'support@example.test' },
  billing: { enabled: false },
  credits: { enabled: false },
  ai: { text: { enabled: false }, image: false, video: false },
})
const business = vi.fn(() => ({}) as ReturnType<JobsContext['db']['business']>)
const context = {
  db: { business },
  files: { available: false },
  observer: { tagContext: vi.fn(), captureException: vi.fn() },
} as unknown as JobsContext
function scheduler() {
  const runs = new Map<string, ScheduledHandler>()
  const definitions: ScheduleDefinition[] = []
  return {
    runs,
    definitions,
    register(definition, handler) {
      definitions.push(definition)
      runs.set(definition.id, handler)
    },
    health: vi.fn(),
  } satisfies Scheduler & { runs: Map<string, ScheduledHandler>; definitions: ScheduleDefinition[] }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('keeps core UTC schedules and heartbeat with billing, credits and AI disabled', async () => {
  const registered = scheduler()
  const dispose = registerNodeJobsSchedules(registered, context, disabled)
  expect(registered.definitions.map(({ cron }) => cron)).toEqual([
    '*/5 * * * *',
    '0 3 * * *',
    '*/10 * * * *',
  ])
  for (const definition of registered.definitions) {
    expect(definition).toMatchObject({ timeZone: 'UTC', missedRun: 'skip' })
    expect(definition.id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/)
  }
  const scheduledAt = new Date('2026-09-08T03:00:00Z')
  for (const handler of registered.runs.values()) await handler({ scheduledAt })
  expect(mocks.hold).not.toHaveBeenCalled()
  expect(mocks.billing).not.toHaveBeenCalled()
  expect(mocks.files).not.toHaveBeenCalled()
  expect(mocks.deletion).toHaveBeenCalledWith(context)
  expect(mocks.heartbeat).toHaveBeenCalledOnce()
  expect(mocks.metrics).toHaveBeenCalledWith(context, scheduledAt.getTime())
  dispose()
})

it('keeps text and media hold registrations explicit and removable without a media workflow', () => {
  expect(getNodeJobFeatures(disabled)).toEqual({
    billing: false,
    credits: false,
    text: false,
    media: false,
  })
  const dispose = registerAiHoldSweepers({ text: true, media: true })
  expect(mocks.hold.mock.calls.map(([type]) => type)).toEqual(['ai_message', 'ai_task'])
  dispose()
  for (const result of mocks.hold.mock.results) expect(result.value).toHaveBeenCalledOnce()
})

it('does not advance the Node heartbeat when deletion cache compensation fails', async () => {
  const registered = scheduler()
  const dispose = registerNodeJobsSchedules(registered, context, disabled)
  mocks.deletion.mockRejectedValueOnce(new Error('cache unavailable'))
  await expect(
    registered.runs.get('jobs-heartbeat-v1')?.({ scheduledAt: new Date() }),
  ).rejects.toThrow('cache unavailable')
  expect(mocks.heartbeat).not.toHaveBeenCalled()
  dispose()
})

it('retains enabled media hold recovery while unavailable files skip object cleanup', async () => {
  const config = {
    ...disabled,
    billing: { ...disabled.billing, enabled: true },
    credits: { enabled: true },
    ai: { ...disabled.ai, image: true },
  }
  const registered = scheduler()
  const dispose = registerNodeJobsSchedules(registered, context, config)
  await registered.runs.get('jobs-ten-minute-maintenance-v1')?.({ scheduledAt: new Date() })
  expect(mocks.hold.mock.calls.map(([type]) => type)).toEqual(['ai_task'])
  expect(mocks.billing).toHaveBeenCalledWith('*/10 * * * *', context, {
    billing: true,
    credits: true,
    text: false,
    media: true,
  })
  expect(mocks.files).not.toHaveBeenCalled()
  dispose()
})

it('enables ten-minute object cleanup only for assembled file capability', async () => {
  const registered = scheduler()
  const available = { ...context, files: { available: true as const, value: { delete: vi.fn() } } }
  const dispose = registerNodeJobsSchedules(registered, available, disabled)
  await registered.runs.get('jobs-ten-minute-maintenance-v1')?.({ scheduledAt: new Date() })
  expect(mocks.files).toHaveBeenCalledExactlyOnceWith(available)
  expect(mocks.billing).not.toHaveBeenCalled()
  dispose()
})

it('uses explicit module and text.enabled flags rather than payment provider presence', () => {
  const config = defineTemplateConfig({
    app: disabled.app,
    billing: { enabled: true, providers: [], signupBonusCredits: 0 },
    ai: { text: { enabled: true }, image: false, video: false },
  })
  expect(getNodeJobFeatures(config)).toEqual({
    billing: true,
    credits: true,
    text: true,
    media: false,
  })
})
