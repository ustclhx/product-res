import type { PaymentMode } from '@product-res/config'
import type { JsonValue } from '@product-res/db/schema'
import Stripe from 'stripe'
import {
  type NormalizedEvent,
  type PaymentProvider,
  type VerifiedWebhook,
  WebhookVerificationError,
} from '../provider.ts'
import { createStripeClient, STRIPE_API_VERSION } from './client.ts'
import { parseStripeMetadata } from './metadata.ts'
import { createStripeOperations } from './operations.ts'
import {
  classifyStripeBillingReason,
  createStripeSnapshots,
  mapStripeSubscription,
  stripeDate,
  stripeInvoiceSubscription,
  stripeObjectId,
  stripeRaw,
} from './snapshots.ts'

export interface StripeProviderOptions {
  secretKey: string
  webhookSecret: string
  fetch?: typeof fetch
  expectedMode?: PaymentMode
}

/** All enrichment finishes before the caller opens its consumer transaction. */
async function normalizeStripeEvent(
  stripe: Stripe,
  event: Stripe.Event,
  expectedMode?: PaymentMode,
): Promise<VerifiedWebhook> {
  // 验签后的回调与可信载荷重放共用此边界，避免跨模式事件触发远端补充查询。
  if (expectedMode && event.livemode !== (expectedMode === 'live'))
    throw new WebhookVerificationError('Stripe event does not match the payment mode')
  const base = {
    provider: 'stripe' as const,
    occurredAt: stripeDate(event.created),
    raw: stripeRaw(event),
  }
  const events: NormalizedEvent[] = []
  const snapshots = createStripeSnapshots(stripe)
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      if (session.mode !== 'subscription' && session.mode !== 'payment') break
      const metadata = parseStripeMetadata(session.metadata)
      if (!metadata) throw new Error('Checkout association requires valid source metadata')
      const association = {
        ...base,
        type: 'checkout.completed' as const,
        providerCheckoutId: session.id,
        providerCustomerId: stripeObjectId(session.customer),
        metadata,
      }
      if (session.mode === 'subscription') {
        const subscriptionId = stripeObjectId(session.subscription)
        if (!subscriptionId) throw new Error('Checkout has no subscription association')
        events.push({
          ...association,
          mode: 'subscription',
          providerSubscriptionId: subscriptionId,
        })
      } else {
        events.push({ ...association, mode: 'one_time', providerOrderId: session.id })
        if (session.payment_status === 'paid') {
          const intentId = stripeObjectId(session.payment_intent)
          if (!intentId) throw new Error('Paid Checkout has no PaymentIntent')
          const payment = await snapshots.getPayment({
            providerPaymentId: intentId,
            kind: 'one_time',
          })
          if (payment.kind !== 'one_time' || payment.providerOrderId !== session.id) {
            throw new Error('Payment does not match Checkout association')
          }
          events.push({ ...base, type: 'payment.succeeded', payment })
        }
      }
      break
    }
    case 'invoice.paid': {
      const invoice = event.data.object
      const subscriptionId = stripeInvoiceSubscription(invoice)
      const kind = classifyStripeBillingReason(invoice.billing_reason)
      if (!subscriptionId || kind === 'unsupported') break
      const payments = await stripe.invoicePayments.list({
        invoice: invoice.id,
        status: 'paid',
        limit: 2,
      })
      if (payments.has_more || payments.data.length > 1) {
        throw new Error('Subscription invoices require one identifiable payment')
      }
      const invoicePayment = payments.data[0]
      // Zero-value invoices and invoices settled without a PaymentIntent grant no paid credits.
      if (invoicePayment?.payment.type !== 'payment_intent') break
      const intentId = stripeObjectId(invoicePayment.payment.payment_intent ?? null)
      if (!intentId || stripeObjectId(invoicePayment.invoice) !== invoice.id) {
        throw new Error('InvoicePayment has no matching invoice or PaymentIntent')
      }
      const payment = await snapshots.getPayment({ providerPaymentId: intentId, kind })
      if (payment.kind === 'one_time' || payment.providerSubscriptionId !== subscriptionId) {
        throw new Error('Payment does not match invoice subscription')
      }
      events.push({ ...base, type: 'payment.succeeded', payment })
      if (kind === 'renewal') {
        events.push({
          ...base,
          type: 'subscription.renewed',
          providerSubscriptionId: subscriptionId,
          providerPaymentId: intentId,
          periodStart: payment.period.start,
          periodEnd: payment.period.end,
        })
      }
      break
    }
    case 'invoice.payment_failed': {
      const subscriptionId = stripeInvoiceSubscription(event.data.object)
      if (subscriptionId)
        events.push({
          ...base,
          type: 'subscription.past_due',
          providerSubscriptionId: subscriptionId,
          status: 'past_due',
          pastDueSince: base.occurredAt,
        })
      break
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = mapStripeSubscription(event.data.object)
      events.push({
        ...base,
        type:
          event.type === 'customer.subscription.created' &&
          (subscription.status === 'active' || subscription.status === 'trialing')
            ? 'subscription.activated'
            : 'subscription.updated',
        subscription,
      })
      if (event.type === 'customer.subscription.deleted') {
        if (subscription.status !== 'canceled' && subscription.status !== 'expired') {
          throw new Error('Deleted subscription has an incompatible remote status')
        }
        events.push({
          ...base,
          type: 'subscription.canceled',
          providerSubscriptionId: subscription.providerSubscriptionId,
          status: subscription.status,
          canceledAt: subscription.canceledAt ?? base.occurredAt,
          currentPeriodEnd: subscription.currentPeriodEnd,
        })
      }
      break
    }
    case 'charge.refunded': {
      const charge = event.data.object
      const intentId = stripeObjectId(charge.payment_intent)
      if (!intentId) throw new Error('Refunded charge has no stable PaymentIntent')
      const completeSnapshot = charge.refunds && !charge.refunds.has_more ? charge.refunds : null
      // 新版事件省略列表，截断列表也需经认证 API 补齐；SDK 迭代器读取全部分页。
      const refunds = completeSnapshot
        ? completeSnapshot.data
        : stripe.refunds.list({ charge: charge.id, limit: 100 })
      const seen = new Set<string>()
      for await (const refund of refunds) {
        if (refund.status !== 'succeeded' || !refund.id || seen.has(refund.id)) continue
        if (
          stripeObjectId(refund.charge) !== charge.id ||
          stripeObjectId(refund.payment_intent) !== intentId
        ) {
          throw new Error('Refund does not match its charge and PaymentIntent')
        }
        seen.add(refund.id)
        events.push({
          ...base,
          type: 'payment.refunded',
          providerPaymentId: intentId,
          providerRefundId: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          // API 可能返回较新的退款，不能搭配旧事件累计额；业务层按退款身份累计。
          refundedAmount: completeSnapshot ? charge.amount_refunded : null,
        })
      }
      break
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object
      let intentId = stripeObjectId(dispute.payment_intent)
      if (!intentId) {
        const charge =
          typeof dispute.charge === 'string'
            ? await stripe.charges.retrieve(dispute.charge)
            : dispute.charge
        intentId = stripeObjectId(charge.payment_intent)
      }
      if (!intentId) throw new Error('Dispute has no stable PaymentIntent')
      events.push({
        ...base,
        type: 'payment.disputed',
        providerPaymentId: intentId,
        providerDisputeId: dispute.id,
        amount: dispute.amount,
        currency: dispute.currency,
      })
      break
    }
  }
  // The consumer deduplicates this entire delivery, including all split events.
  return { providerEventId: event.id, type: event.type, events }
}

export function createStripeProvider(options: StripeProviderOptions): PaymentProvider {
  const stripe = createStripeClient(options.secretKey, options.fetch)
  const cryptoProvider = Stripe.createSubtleCryptoProvider()
  return {
    id: 'stripe',
    capabilities: { portal: true, changePlan: true, refundsViaApi: true, merchantOfRecord: false },
    ...createStripeOperations(stripe),
    ...createStripeSnapshots(stripe),
    async verifyWebhook(request, rawBody) {
      const signature = request.headers.get('stripe-signature')
      if (!signature) throw new WebhookVerificationError('Missing Stripe-Signature header')
      let event: Stripe.Event
      try {
        event = await stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          options.webhookSecret,
          undefined,
          cryptoProvider,
        )
      } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError)
          throw new WebhookVerificationError('Invalid Stripe webhook signature')
        throw error
      }
      if (event.api_version !== STRIPE_API_VERSION) {
        throw new Error(`Incompatible Stripe event API version: ${event.api_version}`)
      }
      return normalizeStripeEvent(stripe, event, options.expectedMode)
    },
  }
}

/** Trusted persisted-payload replay only; HTTP ingress always uses verifyWebhook. */
export function createStripeWebhookNormalizer(
  options: Pick<StripeProviderOptions, 'secretKey' | 'fetch' | 'expectedMode'>,
) {
  const stripe = createStripeClient(options.secretKey, options.fetch)
  return async (payload: JsonValue): Promise<VerifiedWebhook> => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.id !== 'string' ||
      typeof payload.type !== 'string' ||
      payload.api_version !== STRIPE_API_VERSION
    )
      throw new Error('Invalid stored Stripe event')
    return normalizeStripeEvent(stripe, payload as unknown as Stripe.Event, options.expectedMode)
  }
}
