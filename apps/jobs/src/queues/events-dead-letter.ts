// biome-ignore-all lint/plugin: 死信属于跨租户运维数据，不使用业务租户过滤器。
import { createHash } from 'node:crypto'
import { type Database, jobDeadLetter, jobMessage, jobQueue } from '@product-res/db'
import type { DeadLetterSink, QueueBatch, QueueFailure, QueueProducer } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { deliverOperations } from '../notifications/operations.ts'

export type EventsDeadLetter = {
  kind: 'events.dead-letter'
  messageId: string
  queue: string
  attempts: number
  timestamp: string
  failedAt: string
  failure: QueueFailure
  body: unknown
}

export function createEventsDeadLetterSink(
  queue: string,
  producer: QueueProducer<EventsDeadLetter>,
): DeadLetterSink<unknown> {
  return {
    async failed(message, failure) {
      try {
        await producer.send({
          kind: 'events.dead-letter',
          messageId: message.id,
          queue,
          attempts: message.attempts,
          timestamp: message.timestamp.toISOString(),
          failedAt: new Date().toISOString(),
          failure,
          body: message.body,
        })
        message.ack()
      } catch (error) {
        message.retry()
        throw error
      }
    },
  }
}

/** 平台自动 DLQ 是消费者崩溃的兜底；平台未提供的错误信息明确标记为不可用。 */
function readDeadLetter(
  batch: QueueBatch<unknown>,
  message: QueueBatch<unknown>['messages'][number],
): EventsDeadLetter {
  const body = message.body as Partial<EventsDeadLetter> | null
  const queue = batch.queue.replace('product-res-events-dlq', 'product-res-events')
  if (
    body?.kind === 'events.dead-letter' &&
    body.queue === queue &&
    typeof body.messageId === 'string' &&
    Number.isSafeInteger(body.attempts) &&
    (body.attempts ?? 0) > 0 &&
    typeof body.failure?.code === 'string' &&
    typeof body.failure.retryable === 'boolean' &&
    typeof body.timestamp === 'string' &&
    Number.isFinite(Date.parse(body.timestamp)) &&
    typeof body.failedAt === 'string' &&
    Number.isFinite(Date.parse(body.failedAt))
  )
    return body as EventsDeadLetter
  return {
    kind: 'events.dead-letter',
    messageId: message.id,
    queue,
    attempts: 6,
    timestamp: message.timestamp.toISOString(),
    failedAt: new Date().toISOString(),
    failure: { code: 'EVENTS_CONSUMER_CRASH_REASON_UNAVAILABLE', retryable: true },
    body: message.body,
  }
}

export async function handleEventsDeadLetterBatch(
  batch: QueueBatch<unknown>,
  db: Database,
  alert: typeof deliverOperations = deliverOperations,
) {
  for (const message of batch.messages) {
    try {
      const dead = readDeadLetter(batch, message)
      // 平台消息标识不保证为 UUID；确定性内部 ID 使重复投递不增加死信行。
      const hash = createHash('sha256')
        .update(`cloudflare:${dead.queue}:${dead.messageId}`)
        .digest('hex')
      const time = new Date(dead.timestamp).getTime().toString(16).padStart(12, '0')
      const id = `${time.slice(0, 8)}-${time.slice(8)}-7${hash.slice(0, 3)}-8${hash.slice(3, 6)}-${hash.slice(6, 18)}`
      const queue = `cloudflare:${dead.queue}`
      await db.transaction(async (tx) => {
        await tx
          .insert(jobQueue)
          .values({ name: queue, policy: { source: 'cloudflare' } })
          .onConflictDoNothing()
        await tx
          .insert(jobMessage)
          .values({
            id,
            queue,
            body: dead,
            idempotencyKey: dead.messageId,
            state: 'dead',
            attempts: dead.attempts,
            createdAt: new Date(dead.timestamp),
            finishedAt: new Date(dead.failedAt),
          })
          .onConflictDoNothing()
        await tx
          .insert(jobDeadLetter)
          .values({
            messageId: id,
            queue: dead.queue,
            attempts: dead.attempts,
            code: dead.failure.code,
            retryable: dead.failure.retryable ? 1 : 0,
            createdAt: new Date(dead.failedAt),
          })
          .onConflictDoNothing()
      })
      // 直接告警，避免运营渠道故障再次进入 events 队列形成循环；渠道成功标记支持重投去重。
      await alert(db, { event: 'queue.dead_letter', sourceId: id })
      log.error('events.dead_letter', {
        messageId: dead.messageId,
        queue: dead.queue,
        attempts: dead.attempts,
        code: dead.failure.code,
      })
      message.ack()
    } catch {
      log.error('events.dead_letter_failed', { messageId: message.id })
      message.retry({ delaySeconds: 60 })
    }
  }
}
