import type { JsonValue } from '@product-res/db/schema'
import {
  type NormalizedEvent,
  type VerifiedWebhook,
  WebhookVerificationError,
} from '../provider.ts'
import { fromPayPalDecimal } from './money.ts'
import {
  createPayPalSnapshots,
  getPayPalSalePayment,
  type PayPalSaleLookup,
  payPalDate,
  payPalRaw,
} from './snapshots.ts'
import {
  createPayPalTransport,
  type PayPalTransport,
  type PayPalTransportOptions,
} from './transport.ts'

type ObjectPayload = Record<string, unknown>
function object(value: unknown): ObjectPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed PayPal webhook object')
  return value as ObjectPayload
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid PayPal webhook resource ID')
  return value
}
function money(value: unknown, sale = false): number {
  const amount = object(value)
  const currency = sale ? amount.currency : amount.currency_code
  const decimal = sale ? amount.total : amount.value
  if (typeof currency !== 'string' || typeof decimal !== 'string')
    throw new Error('Malformed PayPal webhook amount')
  const result = fromPayPalDecimal(decimal, currency)
  if (result <= 0) throw new Error('Expected positive PayPal webhook amount')
  return result
}
/** Extract IDs only; never fetch the supplied URL. Production/sandbox API aliases are documented. */
function linkedId(resource: ObjectPayload, path: string, environment: 'sandbox' | 'live'): string {
  if (!Array.isArray(resource.links)) throw new Error('PayPal refund lacks payment association')
  const origins =
    environment === 'live'
      ? ['https://api.paypal.com', 'https://api-m.paypal.com']
      : ['https://api.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com']
  const ids = resource.links
    .filter((item) => object(item).rel === 'up')
    .map((item) => {
      const link = object(item)
      if (typeof link.href !== 'string') throw new Error('Malformed PayPal association link')
      const url = new URL(link.href)
      if (
        !origins.includes(url.origin) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(`${path}/`)
      )
        throw new Error('Unsafe PayPal association link')
      return id(url.pathname.slice(path.length + 1))
    })
  if (ids.length !== 1) throw new Error('Ambiguous PayPal refund payment association')
  return ids[0] as string
}
function parsePayload(payload: unknown): ObjectPayload {
  return object(typeof payload === 'string' ? JSON.parse(payload) : payload)
}

export function payPalWebhookNormalizer(
  transport: PayPalTransport,
  environment: 'sandbox' | 'live',
  lookupRecordedSale?: PayPalSaleLookup,
) {
  const snapshots = createPayPalSnapshots(transport, lookupRecordedSale)
  return async (payload: unknown): Promise<VerifiedWebhook> => {
    const envelope = parsePayload(payload)
    const raw = payPalRaw(envelope)
    const providerEventId = id(envelope.id)
    if (typeof envelope.event_type !== 'string' || !envelope.event_type)
      throw new Error('Malformed PayPal webhook event type')
    const type = envelope.event_type
    const occurredAt = payPalDate(envelope.create_time)
    const base = { provider: 'paypal' as const, occurredAt, raw }
    const events: NormalizedEvent[] = []
    const supported = new Set([
      'CHECKOUT.ORDER.APPROVED',
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'BILLING.SUBSCRIPTION.UPDATED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.EXPIRED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      'PAYMENT.SALE.COMPLETED',
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.SALE.REFUNDED',
      'PAYMENT.CAPTURE.REFUNDED',
      'CUSTOMER.DISPUTE.CREATED',
    ])
    if (!supported.has(type)) return { providerEventId, type, events }
    const resource = object(envelope.resource)
    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const order = await snapshots.getOrder(id(resource.id))
      if (!order.metadata) throw new Error('PayPal checkout lacks verified metadata')
      events.push({
        ...base,
        type: 'checkout.completed',
        mode: 'one_time',
        providerCheckoutId: order.providerOrderId,
        providerOrderId: order.providerOrderId,
        providerCustomerId: order.providerCustomerId,
        metadata: order.metadata,
      })
    } else if (type.startsWith('BILLING.SUBSCRIPTION.')) {
      const providerSubscriptionId = id(resource.id)
      if (
        type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' ||
        type === 'BILLING.SUBSCRIPTION.SUSPENDED'
      ) {
        events.push({
          ...base,
          type: 'subscription.past_due',
          providerSubscriptionId,
          pastDueSince: occurredAt,
          status: type.endsWith('SUSPENDED') ? 'paused' : 'past_due',
        })
      } else {
        const subscription = await snapshots.getSubscription(providerSubscriptionId)
        if (type.endsWith('CANCELLED') || type.endsWith('EXPIRED')) {
          events.push({
            ...base,
            type: 'subscription.canceled',
            providerSubscriptionId,
            status: type.endsWith('EXPIRED') ? 'expired' : 'canceled',
            canceledAt: occurredAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
          })
        } else {
          if (type.endsWith('ACTIVATED')) {
            if (!subscription.metadata) throw new Error('PayPal activation lacks verified metadata')
            events.push({
              ...base,
              type: 'checkout.completed',
              mode: 'subscription',
              providerCheckoutId: providerSubscriptionId,
              providerSubscriptionId,
              providerCustomerId: subscription.providerCustomerId,
              metadata: subscription.metadata,
            })
          }
          events.push({
            ...base,
            type: type.endsWith('ACTIVATED') ? 'subscription.activated' : 'subscription.updated',
            subscription,
          })
        }
      }
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.SALE.COMPLETED') {
      const paymentId = id(resource.id)
      const saleEvent = type === 'PAYMENT.SALE.COMPLETED'
      const eventAmount = money(resource.amount, saleEvent)
      const eventPaidAt = payPalDate(resource.create_time)
      // 沙箱快速退款后，COMPLETED 投递的正文可能已反映退款；付款状态以随后核验的快照为准。
      const paidState = saleEvent
        ? resource.state === 'completed'
        : typeof resource.status === 'string' &&
          ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(resource.status)
      if (!paidState) throw new Error('Malformed PayPal completed payment state')
      const payment =
        type === 'PAYMENT.CAPTURE.COMPLETED'
          ? await snapshots.getPayment({ kind: 'one_time', providerPaymentId: paymentId })
          : await getPayPalSalePayment(transport, paymentId, lookupRecordedSale)
      if (
        type === 'PAYMENT.SALE.COMPLETED' &&
        id(resource.billing_agreement_id) !== payment.providerSubscriptionId
      )
        throw new Error('PayPal Sale subscription association mismatch')
      if (payment.amount !== eventAmount || payment.paidAt.getTime() !== eventPaidAt.getTime())
        throw new Error('PayPal payment payload differs from verified remote payment')
      const paymentBase = { ...base, occurredAt: payment.paidAt }
      events.push({ ...paymentBase, type: 'payment.succeeded', payment })
      if (payment.kind === 'renewal')
        events.push({
          ...paymentBase,
          type: 'subscription.renewed',
          providerSubscriptionId: payment.providerSubscriptionId,
          providerPaymentId: payment.providerPaymentId,
          periodStart: payment.period.start,
          periodEnd: payment.period.end,
        })
    } else if (type.endsWith('.REFUNDED')) {
      const sale = type === 'PAYMENT.SALE.REFUNDED'
      const providerRefundId = id(resource.id)
      const amount = money(resource.amount, sale)
      const remote = object(
        await transport.request(
          'GET',
          sale
            ? `/v1/payments/refund/${providerRefundId}`
            : `/v2/payments/refunds/${providerRefundId}`,
        ),
      )
      payPalRaw(remote)
      if (
        remote.id !== providerRefundId ||
        (sale ? remote.state !== 'completed' : remote.status !== 'COMPLETED') ||
        money(remote.amount, sale) !== amount
      )
        throw new Error('Unconfirmed or inconsistent PayPal refund')
      const association = (value: ObjectPayload) =>
        sale ? id(value.sale_id) : linkedId(value, '/v2/payments/captures', environment)
      const providerPaymentId = association(remote)
      if (association(resource) !== providerPaymentId)
        throw new Error('PayPal refund payment association mismatch')
      // v2 refund breakdown explicitly exposes a cumulative capture total; v1 does not.
      const cumulative =
        !sale && remote.seller_payable_breakdown !== undefined
          ? object(remote.seller_payable_breakdown).total_refunded_amount
          : undefined
      const refundedAmount = cumulative === undefined ? null : money(cumulative)
      if (refundedAmount !== null && refundedAmount < amount)
        throw new Error('Invalid cumulative PayPal refund amount')
      events.push({
        ...base,
        type: 'payment.refunded',
        providerPaymentId,
        providerRefundId,
        amount,
        currency: 'USD',
        refundedAmount,
      })
    } else if (type === 'CUSTOMER.DISPUTE.CREATED') {
      const providerDisputeId = id(resource.dispute_id)
      if (
        !Array.isArray(resource.disputed_transactions) ||
        resource.disputed_transactions.length !== 1
      )
        throw new Error('PayPal dispute requires one stable seller transaction')
      const transaction = object(resource.disputed_transactions[0])
      events.push({
        ...base,
        type: 'payment.disputed',
        providerDisputeId,
        providerPaymentId: id(transaction.seller_transaction_id),
        amount: money(resource.dispute_amount),
        currency: 'USD',
      })
    }
    return { providerEventId, type, events }
  }
}

/** Only for raw payloads already verified at ingestion and stored in trusted persistence. */
export function createPayPalWebhookNormalizer(
  options: PayPalTransportOptions & { lookupRecordedSale?: PayPalSaleLookup },
): (payload: JsonValue | string) => Promise<VerifiedWebhook> {
  return payPalWebhookNormalizer(
    createPayPalTransport(options),
    options.environment,
    options.lookupRecordedSale,
  )
}

export async function verifyPayPalWebhook(
  transport: PayPalTransport,
  req: Request,
  rawBody: string,
  webhookId: string | undefined,
  normalize: (payload: unknown) => Promise<VerifiedWebhook>,
): Promise<VerifiedWebhook> {
  if (!webhookId?.trim()) throw new Error('PayPal webhook ID is not configured')
  const fields = {
    auth_algo: 'paypal-auth-algo',
    cert_url: 'paypal-cert-url',
    transmission_id: 'paypal-transmission-id',
    transmission_sig: 'paypal-transmission-sig',
    transmission_time: 'paypal-transmission-time',
  }
  const body: Record<string, unknown> = { webhook_id: webhookId }
  for (const [field, header] of Object.entries(fields)) {
    const value = req.headers.get(header)
    if (!value?.trim())
      throw new WebhookVerificationError(`Missing PayPal transmission header: ${header}`)
    body[field] = value
  }
  const payload = parsePayload(rawBody)
  body.webhook_event = payload
  const result = await transport.request<{ verification_status?: string }>(
    'POST',
    '/v1/notifications/verify-webhook-signature',
    { body },
  )
  if (result?.verification_status !== 'SUCCESS')
    throw new WebhookVerificationError('PayPal webhook signature verification failed')
  return normalize(payload)
}
