import { isReplayMessage, KEEPA_SOURCE_ID, runReplayStep } from '@product-res/follow'
import { createDbArchive } from '@product-res/marketdata'
import type { DeadLetterSink, QueueBatch } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import type { DataSyncContext } from '../datasources/sync.ts'

/** 基础设施错误（数据库等）的最大重试次数；额度顺延不计入失败 */
export const REPLAY_MAX_RETRIES = 5

/**
 * Keepa 历史回放消费者（add-shadow-validation tasks 3.1）：
 * - 完成或失败（含没有凭据）确认消息，原因记在回放父记录
 * - 额度不足顺延：按额度重置时刻延迟重投，不超额调用
 * - 数据库等异常按队列策略重试，耗尽后进入死信
 */
export async function consumeReplay(
  batch: QueueBatch<unknown>,
  context: DataSyncContext,
  sink: DeadLetterSink<unknown>,
) {
  const archive = createDbArchive(context.db, context.archiveRetentionDays)
  const now = context.now ?? (() => new Date())
  for (const message of batch.messages) {
    if (!isReplayMessage(message.body)) {
      log.warn('selection.replay_invalid_message', { messageId: message.id })
      message.ack()
      continue
    }
    const connector = context.registry.get(KEEPA_SOURCE_ID)
    if (!connector) {
      await sink.failed(message, { code: 'UNKNOWN_SOURCE', retryable: false })
      message.ack()
      continue
    }
    try {
      const result = await runReplayStep(
        {
          db: context.db,
          connector,
          archive,
          ctx: { fetch: context.fetch ?? fetch, secret: context.secret, now },
        },
        message.body,
      )
      if (result.status === 'deferred') {
        const delaySeconds = Math.max(
          1,
          Math.ceil((result.retryAt.getTime() - now().getTime()) / 1000),
        )
        log.info('selection.replay_deferred', {
          replayId: message.body.replayId,
          reason: result.reason,
          delaySeconds,
        })
        message.retry({ delaySeconds })
        continue
      }
      message.ack()
    } catch (error) {
      log.error('selection.replay_consume_failed', {
        messageId: message.id,
        replayId: message.body.replayId,
        error,
      })
      if (message.attempts > REPLAY_MAX_RETRIES) {
        await sink.failed(message, { code: 'REPLAY_INTERNAL', retryable: true })
        message.ack()
      } else message.retry()
    }
  }
}
