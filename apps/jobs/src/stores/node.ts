import { isStoreRoundMessage, STORE_TRACKING_QUEUE } from '@product-res/follow'
import type { DeadLetterSink, QueueBatch, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import type { DataSyncContext } from '../datasources/sync.ts'
import { runStoreTrackingRound, STORE_TRACKING_SCHEDULE } from './round.ts'

/** 手动触发的一轮出错（数据库等）时的最大重试次数 */
export const STORE_ROUND_MAX_RETRIES = 3

interface QueueRegistrar {
  register<T>(
    name: string,
    handler: (batch: QueueBatch<T>, sink: DeadLetterSink<T>) => Promise<void>,
    overrides?: { concurrency?: number },
  ): void
}

/**
 * 手动触发的一轮店铺追踪（“立即跑一轮”）：不经过定时计划，所以
 * `DATA_PIPELINE_SCHEDULES=paused` 时仍可执行，用于暂停状态下的验收（tasks 5.1）。
 */
export async function consumeStoreRounds(
  batch: QueueBatch<unknown>,
  context: DataSyncContext,
  sink: DeadLetterSink<unknown>,
) {
  for (const message of batch.messages) {
    if (!isStoreRoundMessage(message.body)) {
      log.warn('stores.round_invalid_message', { messageId: message.id })
      message.ack()
      continue
    }
    try {
      await runStoreTrackingRound(context, {
        scheduledAt: context.now?.() ?? new Date(),
        workspaceId: message.body.workspaceId,
        manual: true,
        requestId: message.id,
      })
      message.ack()
    } catch (error) {
      log.error('stores.round_failed', {
        messageId: message.id,
        workspaceId: message.body.workspaceId,
        error,
      })
      if (message.attempts > STORE_ROUND_MAX_RETRIES) {
        await sink.failed(message, { code: 'STORE_ROUND_FAILED', retryable: true })
        message.ack()
      } else message.retry()
    }
  }
}

/**
 * Node 装配店铺追踪：每日 03:00 SGT 的定时计划（传入的 scheduler 已按
 * DATA_PIPELINE_SCHEDULES 包装，暂停时到点直接返回）与手动触发队列。
 */
export function registerNodeStoreTracking(input: {
  readonly scheduler: Scheduler
  readonly queues: QueueRegistrar
  readonly dataSync: DataSyncContext
}) {
  input.scheduler.register(STORE_TRACKING_SCHEDULE, async ({ scheduledAt }) => {
    await runStoreTrackingRound(input.dataSync, { scheduledAt })
  })
  // 一轮会投递较多任务并读写多张表，串行执行
  input.queues.register(
    STORE_TRACKING_QUEUE,
    (batch, sink) => consumeStoreRounds(batch, input.dataSync, sink),
    { concurrency: 1 },
  )
}
