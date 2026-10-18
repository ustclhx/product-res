import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { afterEach, expect, it, vi } from 'vitest'
import type { BillingEnv } from '../src/billing.ts'
import { parseOperationsMessage, sendOperationsChannel } from '../src/notifications/operations.ts'
import { logJobObserver } from '../src/observer.ts'
import { handleBillingBatch } from '../src/queues/billing.ts'

const deliver = vi.hoisted(() => vi.fn())
vi.mock('../src/notifications/operations.ts', async (original) => ({
  ...(await original<typeof import('../src/notifications/operations.ts')>()),
  deliverOperations: deliver,
}))
afterEach(() => vi.restoreAllMocks())
it('accepts all four event types but rejects malformed envelopes and drops unrecognized private fields', () => {
  for (const event of [
    'payment.succeeded',
    'refund.requested',
    'webhook.failed',
    'reconciliation.failed',
  ]) {
    expect(
      parseOperationsMessage({
        v: 1,
        requestId: 'req-1',
        operations: [{ event, sourceId: 'id-1', token: 'private' }],
      }),
    ).toEqual({ requestId: 'req-1', operations: [{ event, sourceId: 'id-1' }] })
  }
  expect(parseOperationsMessage({ v: 1, deliveryId: 'old-message' })).toBeNull()
  expect(
    parseOperationsMessage({ v: 1, operations: [{ event: 'unknown', sourceId: '1' }] }),
  ).toBeNull()
  expect(
    parseOperationsMessage({
      v: 1,
      operations: [{ event: 'payment.succeeded', sourceId: '1', amount: -1 }],
    }),
  ).toBeNull()
})
it('treats Telegram API rejection and Discord HTTP failure as retryable without exposing endpoint secrets', async () => {
  const channels = {
    telegramBotToken: 'private-token',
    telegramChatId: '-1',
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/private-webhook',
  }
  const event = { event: 'webhook.failed' as const, sourceId: 'delivery-1' }
  const http = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ ok: false }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  await expect(sendOperationsChannel('telegram', channels, event)).rejects.toThrow(
    'Operations telegram delivery failed',
  )
  await expect(sendOperationsChannel('discord', channels, event)).rejects.toThrow(
    'Operations discord delivery failed',
  )
  expect(http.mock.calls[1]?.[0]).toBe(`${channels.discordWebhookUrl}?wait=true`)
})

it('retries ordinary operations errors then records exhaustion while billing is disabled', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const event = { event: 'webhook.failed', sourceId: 'delivery-1' }
  const entry: QueueMessage<unknown> = {
    id: 'operations',
    body: { v: 1, operations: [event], requestId: 'original-request' },
    attempts: 2,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  }
  const batch = { messages: [entry] } as unknown as QueueBatch<unknown>
  const db = {}
  const env = { db: { business: () => db } } as unknown as BillingEnv
  deliver.mockRejectedValue(new Error('Operations telegram delivery failed'))
  const failed = vi.fn().mockResolvedValue(undefined)
  const options = { billingEnabled: false, deadLetters: { failed } }
  await handleBillingBatch(batch, env, logJobObserver, options)
  expect(entry.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  expect(failed).not.toHaveBeenCalled()
  const exhausted = { ...entry, attempts: 6, retry: vi.fn() }
  await handleBillingBatch(
    { messages: [exhausted] } as unknown as QueueBatch<unknown>,
    env,
    logJobObserver,
    options,
  )
  expect(failed).toHaveBeenCalledWith(exhausted, {
    code: 'OPERATIONS_ATTEMPTS_EXHAUSTED',
    retryable: true,
  })
  expect(exhausted.retry).not.toHaveBeenCalled()
  expect(entry.ack).not.toHaveBeenCalled()
  expect(deliver).toHaveBeenCalledWith(db, event)
  expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain(
    '"requestId":"original-request"',
  )
})
