import { createDb, jobDeadLetter, jobMessage } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import {
  createEventsDeadLetterSink,
  handleEventsDeadLetterBatch,
} from '../src/queues/events-dead-letter.ts'

it('records CF terminal failure with app permissions and deduplicates redelivery in Postgres', async () => {
  const url = readLocalEnv('DATABASE_URL')
  if (!url || !new URL(url).pathname.startsWith('/product_res_wt_'))
    throw new Error('Isolated worktree database required')
  const db = createDb(url)
  const cleanup = createDb(readLocalEnv('MIGRATION_DATABASE_URL') ?? '')
  const sourceId = `cf-${crypto.randomUUID()}`
  const timestamp = new Date('2026-10-24T00:00:00Z')
  const source: QueueMessage<unknown> = {
    id: sourceId,
    body: { v: 1, operations: [] },
    attempts: 6,
    timestamp,
    ack: vi.fn(),
    retry: vi.fn(),
  }
  const send = vi.fn()
  await createEventsDeadLetterSink('product-res-events-production', {
    send,
    sendBatch: vi.fn(),
  }).failed(source, { code: 'OPERATIONS_TELEGRAM_DELIVERY_FAILED', retryable: true })
  const message: QueueMessage<unknown> = {
    ...source,
    body: send.mock.calls[0]?.[0],
    ack: vi.fn(),
    retry: vi.fn(),
  }
  const batch = {
    queue: 'product-res-events-dlq-production',
    messages: [message],
  } as unknown as QueueBatch<unknown>
  const alert = vi.fn().mockResolvedValue(undefined)
  try {
    await handleEventsDeadLetterBatch(batch, db, alert)
    await handleEventsDeadLetterBatch(batch, db, alert)
    expect(message.ack).toHaveBeenCalledTimes(2)
    expect(message.retry).not.toHaveBeenCalled()
    const rows = await db
      .select()
      .from(jobDeadLetter)
      .innerJoin(jobMessage, eq(jobMessage.id, jobDeadLetter.messageId))
      .where(eq(jobMessage.idempotencyKey, sourceId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dead_letter).toMatchObject({
      queue: 'product-res-events-production',
      attempts: 6,
      code: 'OPERATIONS_TELEGRAM_DELIVERY_FAILED',
      retryable: 1,
    })
    expect(rows[0]?.message.body).toMatchObject({
      messageId: sourceId,
      timestamp: timestamp.toISOString(),
      body: source.body,
    })
    expect(Number.parseInt(rows[0]?.message.id.replaceAll('-', '').slice(0, 12) ?? '', 16)).toBe(
      timestamp.getTime(),
    )
  } finally {
    const rows = await db
      .select({ id: jobMessage.id })
      .from(jobMessage)
      .where(eq(jobMessage.idempotencyKey, sourceId))
    for (const row of rows) {
      await cleanup.delete(jobDeadLetter).where(eq(jobDeadLetter.messageId, row.id))
      await cleanup.delete(jobMessage).where(eq(jobMessage.id, row.id))
    }
    await Promise.all([db.close(), cleanup.close()])
  }
})
