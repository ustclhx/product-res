import { withLogContext } from '@product-res/shared/log'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), postprocess: vi.fn(), client: true }))
vi.mock('@sentry/cloudflare', () => ({
  captureException: mocks.capture,
  getClient: () => (mocks.client ? {} : undefined),
  getIsolationScope: () => ({ setTags: vi.fn() }),
}))
vi.mock('../src/billing.ts', () => ({
  createBillingContext: () => ({}),
  postprocessBillingDelivery: mocks.postprocess,
}))

import { handleBillingBatch } from '../src/queues/billing.ts'
import { captureJobException, sentryEnabled } from '../src/sentry.ts'

afterEach(() => {
  mocks.client = true
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

it('only enables Sentry with a DSN in staging, production or smoke', () => {
  const dsn = 'https://fixture@example.com/1'
  expect(sentryEnabled({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'development' })).toBe(false)
  expect(sentryEnabled({ SENTRY_DSN: dsn })).toBe(false)
  expect(sentryEnabled({ SENTRY_ENVIRONMENT: 'staging' })).toBe(false)
  expect(sentryEnabled({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'staging' })).toBe(true)
  expect(sentryEnabled({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'production' })).toBe(true)
  expect(sentryEnabled({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'smoke' })).toBe(true)
  expect(sentryEnabled({ SENTRY_ENVIRONMENT: 'smoke' })).toBe(false)
  mocks.client = false
  captureJobException(new Error('local failure'))
  expect(mocks.capture).not.toHaveBeenCalled()
})

it('reports a caught queue failure with the enqueuing request ID and preserves retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = new Error('fixture provider failure')
  mocks.postprocess.mockRejectedValueOnce(error)
  const message = {
    id: 'message-1',
    attempts: 2,
    body: { v: 1, deliveryId: '93f577ac-e28b-4ca3-9768-05d4e2aa5649', requestId: 'request-1' },
    ack: vi.fn(),
    retry: vi.fn(),
  }
  await withLogContext({ requestId: 'batch-id', queue: 'product-res-events' }, () =>
    handleBillingBatch({ queue: 'product-res-events', messages: [message] } as never, {} as never, {
      tagContext() {},
      captureException: captureJobException,
    }),
  )
  expect(mocks.capture).toHaveBeenCalledWith(error, {
    tags: { requestId: 'request-1', workspaceId: undefined, userId: undefined },
  })
  expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  expect(message.ack).not.toHaveBeenCalled()
})
