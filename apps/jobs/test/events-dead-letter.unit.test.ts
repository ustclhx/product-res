import type { Database } from '@product-res/db'
import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { expect, it, vi } from 'vitest'
import {
  createEventsDeadLetterSink,
  handleEventsDeadLetterBatch,
} from '../src/queues/events-dead-letter.ts'

function message(body: unknown = { v: 1, deliveryId: 'fixture' }): QueueMessage<unknown> {
  return {
    id: 'original-id',
    body,
    attempts: 6,
    timestamp: new Date('2026-10-24T00:00:00Z'),
    ack: vi.fn(),
    retry: vi.fn(),
  }
}
it('forwards original identity and failure before acknowledging, and retries failed sends', async () => {
  const original = message()
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
  const sink = createEventsDeadLetterSink('product-res-events-production', {
    send,
    sendBatch: vi.fn(),
  })
  await expect(
    sink.failed(original, { code: 'UPSTREAM_TIMEOUT', retryable: true }),
  ).rejects.toThrow('offline')
  expect(original.ack).not.toHaveBeenCalled()
  expect(original.retry).toHaveBeenCalledOnce()
  await sink.failed(original, { code: 'UPSTREAM_TIMEOUT', retryable: true })
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      messageId: original.id,
      queue: 'product-res-events-production',
      attempts: 6,
      failure: { code: 'UPSTREAM_TIMEOUT', retryable: true },
      body: original.body,
    }),
  )
  expect(original.ack).toHaveBeenCalledOnce()
})
it('persists before alerting and acknowledges only after both succeed; retries independently', async () => {
  const source = message()
  const send = vi.fn()
  await createEventsDeadLetterSink('product-res-events-production', {
    send,
    sendBatch: vi.fn(),
  }).failed(source, { code: 'UPSTREAM_TIMEOUT', retryable: true })
  const first = message(send.mock.calls[0]?.[0])
  const second = message(send.mock.calls[0]?.[0])
  const commit = vi
    .fn()
    .mockRejectedValueOnce(new Error('database offline'))
    .mockResolvedValue(undefined)
  const db = { transaction: commit } as unknown as Database
  const alert = vi.fn().mockRejectedValueOnce(new Error('alert offline'))
  const batch = {
    queue: 'product-res-events-dlq-production',
    messages: [first, second],
  } as unknown as QueueBatch<unknown>
  await handleEventsDeadLetterBatch(batch, db, alert)
  expect(commit).toHaveBeenCalledTimes(2)
  expect(alert).toHaveBeenCalledOnce()
  expect(first.ack).not.toHaveBeenCalled()
  expect(first.retry).toHaveBeenCalledOnce()
  expect(second.ack).not.toHaveBeenCalled()
  expect(second.retry).toHaveBeenCalledOnce()
  alert.mockResolvedValue(undefined)
  await handleEventsDeadLetterBatch({ ...batch, messages: [second] }, db, alert)
  expect(second.ack).toHaveBeenCalledOnce()
})

it('retains raw native DLQ messages and explicitly marks unavailable platform failure details', async () => {
  const original = message({ v: 1, operations: [{ event: 'webhook.failed', sourceId: 'fixture' }] })
  const values = vi.fn(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }))
  const tx = { insert: vi.fn(() => ({ values })) }
  const db = {
    transaction: (run: (value: typeof tx) => Promise<void>) => run(tx),
  } as unknown as Database
  const alert = vi.fn().mockResolvedValue(undefined)
  await handleEventsDeadLetterBatch(
    {
      queue: 'product-res-events-dlq-staging',
      messages: [original],
    } as unknown as QueueBatch<unknown>,
    db,
    alert,
  )
  expect(values).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: original.id,
      body: expect.objectContaining({
        queue: 'product-res-events-staging',
        messageId: original.id,
        attempts: 6,
        body: original.body,
      }),
    }),
  )
  expect(values).toHaveBeenCalledWith(
    expect.objectContaining({
      queue: 'product-res-events-staging',
      attempts: 6,
      code: 'EVENTS_CONSUMER_CRASH_REASON_UNAVAILABLE',
    }),
  )
  expect(alert).toHaveBeenCalledOnce()
  expect(original.ack).toHaveBeenCalledOnce()
})
