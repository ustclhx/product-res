import { parseBillingQueueMessage } from '@product-res/billing'
import type { Database } from '@product-res/db'
import type { DeadLetterSink, QueueBatch, QueueFailure, QueueMessage } from '@product-res/platform'
import { isAppError } from '@product-res/shared'
import { log, newRequestId, withLogContext } from '@product-res/shared/log'
import { type BillingEnv, createBillingContext, postprocessBillingDelivery } from '../billing.ts'
import { deliverOperations, parseOperationsMessage } from '../notifications/operations.ts'
import { type JobObserver, logJobObserver, withJobObserver } from '../observer.ts'

const EVENTS_MAX_ATTEMPTS = 6

export async function handleBillingBatch(
  batch: QueueBatch<unknown>,
  env: BillingEnv,
  observer: JobObserver = logJobObserver,
  options: { deadLetters?: DeadLetterSink<unknown>; billingEnabled?: boolean } = {},
) {
  // Invalid messages never initialize a provider or touch the database.
  let context: ReturnType<typeof createBillingContext> | undefined
  let operationsDb: Database | undefined
  const failures: unknown[] = []
  for (const message of batch.messages) {
    const body = parseBillingQueueMessage(message.body)
    const operations = parseOperationsMessage(message.body)
    if (!body && !operations) {
      log.warn('billing.invalid', { id: message.id })
      message.ack()
      continue
    }
    // Restore the enqueuing request's ID; messages enqueued before it existed get a fresh one.
    try {
      await withLogContext(
        { requestId: body?.requestId ?? operations?.requestId ?? newRequestId() },
        () =>
          withJobObserver(observer, async () => {
            if (body && options.billingEnabled === false) {
              await finishFailure(
                message,
                { code: 'BILLING_DISABLED', retryable: false },
                options.deadLetters,
              )
              return
            }
            // 计费后处理与运营通知分别确认 / 重试：运营推送失败不会让计费后处理重跑，反之亦然。
            try {
              if (body) {
                context ??= createBillingContext(env)
                await postprocessBillingDelivery(context, body.deliveryId)
                log.info('billing.postprocessed', { id: message.id, deliveryId: body.deliveryId })
              } else if (operations) {
                operationsDb ??= env.db.business()
                for (const event of operations.operations)
                  await deliverOperations(operationsDb, event)
                log.info('operations.delivered', { id: message.id })
              }
              message.ack()
            } catch (error) {
              observer.captureException(error)
              // AppError 以 HTTP status 表达失败性质；普通渠道/数据库错误仍按暂时失败处理。
              const retryable =
                !isAppError(error) ||
                error.status >= 500 ||
                error.status === 408 ||
                error.status === 429
              const terminal =
                options.deadLetters && (!retryable || message.attempts >= EVENTS_MAX_ATTEMPTS)
              const kind = body ? 'billing' : 'operations'
              log.warn(`${kind}.${terminal ? 'failed' : 'retry'}`, {
                id: message.id,
                attempts: message.attempts,
                error: error instanceof Error ? error.name : typeof error,
              })
              if (terminal) {
                await finishFailure(
                  message,
                  {
                    code: `${kind.toUpperCase()}_${retryable ? 'ATTEMPTS_EXHAUSTED' : 'NON_RETRYABLE'}`,
                    retryable,
                  },
                  options.deadLetters,
                )
              } else {
                message.retry({
                  delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900),
                })
              }
            }
          }),
      )
    } catch (error) {
      // 死信失败不确认，且继续处理同批其他成员；出口统一向引擎报告失败。
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Events queue batch failed')
}

async function finishFailure(
  message: QueueMessage<unknown>,
  failure: QueueFailure,
  deadLetters: DeadLetterSink<unknown> | undefined,
) {
  if (deadLetters) await deadLetters.failed(message, failure)
  else message.ack()
}
