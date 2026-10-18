import {
  type BillingProviders,
  createBillingEventHandler,
  createCompensationFailureHandler,
  processWebhook,
  WebhookVerificationError,
} from '@product-res/billing'
import type { Database, PaymentProviderId } from '@product-res/db'
import type { QueueProducer } from '@product-res/platform'
import { log, withRequestId } from '@product-res/shared/log'
import { enqueueOperations } from '../notifications/operations.ts'

export async function handleBillingWebhook(
  request: Request,
  providerId: string,
  options: {
    db: Database
    subscriptionCreditGraceHours: number
    providers: BillingProviders
    queue: Pick<QueueProducer<unknown>, 'send'>
  },
) {
  if (providerId !== 'stripe' && providerId !== 'paypal')
    return new Response('Not Found', { status: 404 })
  const provider = options.providers[providerId as PaymentProviderId]
  if (!provider) return new Response('Payments unavailable', { status: 503 })
  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).length > 1_048_576)
    return new Response('Payload too large', { status: 413 })
  try {
    JSON.parse(rawBody)
  } catch {
    return new Response('Invalid payload', { status: 400 })
  }
  try {
    const result = await processWebhook({
      db: options.db,
      provider,
      request,
      rawBody,
      ...createBillingEventHandler({
        db: options.db,
        providers: options.providers,
        subscriptionCreditGraceHours: options.subscriptionCreditGraceHours,
      }),
      onFailure: createCompensationFailureHandler(options.db),
      notify: async ({ delivery, events }) => {
        const operations = (events ?? []).flatMap((event) =>
          event.type === 'payment.succeeded'
            ? [
                {
                  event: 'payment.succeeded' as const,
                  sourceId: `${event.provider}:${event.payment.providerPaymentId}`,
                  ...(event.payment.metadata
                    ? { workspaceId: event.payment.metadata.workspaceId }
                    : {}),
                  amount: event.payment.amount,
                  currency: event.payment.currency,
                },
              ]
            : [],
        )
        // 计费后处理消息保持原样，投递失败沿用原有管线的失败状态与恢复机制。
        await options.queue.send(withRequestId({ v: 1, deliveryId: delivery.id }))
        // 运营通知单独成消息：投递或推送失败只记日志 / 按自身重试，不影响计费后处理与回调结果。
        for (const operation of operations)
          await enqueueOperations({ send: (message) => options.queue.send(message) }, operation)
      },
    })
    // DB failure must trigger platform retry. Queue failure is recovered from the durable row by Jobs.
    if (result.status === 'failed') {
      log.error('billing.webhook_failed', {
        provider: providerId,
        deliveryId: result.delivery?.id,
        error: result.error,
      })
      if (result.delivery)
        await enqueueOperations(
          { send: (message) => options.queue.send(message) },
          {
            event: 'webhook.failed',
            sourceId: `${result.delivery.id}:${result.delivery.attempts}`,
          },
        )
      return new Response('Processing failed', { status: 500 })
    }
    log.info('billing.webhook_processed', {
      provider: providerId,
      deliveryId: result.delivery?.id,
      status: result.status,
      ...('notification' in result ? { notification: result.notification?.status } : {}),
    })
    return Response.json({ received: true })
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      log.warn('billing.webhook_rejected', { provider: providerId, error })
    else log.error('billing.webhook_failed', { provider: providerId, error })
    return new Response(
      error instanceof WebhookVerificationError ? 'Invalid signature' : 'Processing failed',
      { status: error instanceof WebhookVerificationError ? 400 : 500 },
    )
  }
}
