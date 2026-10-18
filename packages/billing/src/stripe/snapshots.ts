import type { JsonValue, SubscriptionStatus } from '@product-res/db/schema'
import type Stripe from 'stripe'
import type {
  OrderSnapshot,
  PaymentProvider,
  PaymentReference,
  PaymentSnapshot,
  SubscriptionSnapshot,
} from '../provider.ts'
import { parseStripeMetadata } from './metadata.ts'

export type StripeSnapshots = Pick<PaymentProvider, 'getSubscription' | 'getOrder' | 'getPayment'>

export function stripeObjectId(object: string | { id: string } | null): string | null {
  return typeof object === 'string' ? object : (object?.id ?? null)
}

export function stripeRaw(object: unknown): JsonValue {
  return JSON.parse(JSON.stringify(object)) as JsonValue
}

export function stripeDate(seconds: number): Date {
  if (!Number.isFinite(seconds)) throw new Error('Stripe timestamp is missing or invalid')
  return new Date(seconds * 1000)
}

export function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    case 'paused':
      return 'paused'
    case 'incomplete_expired':
      return 'expired'
    case 'incomplete':
    case 'unpaid':
      return 'paused'
    default:
      throw new Error(`Unsupported Stripe subscription status: ${status}`)
  }
}

/** Billing adjustments must be recorded separately and must never grant monthly credits. */
export function classifyStripeBillingReason(
  reason: Stripe.Invoice.BillingReason | null,
): 'initial' | 'renewal' | 'adjustment' | 'unsupported' {
  if (reason === 'subscription_create') return 'initial'
  if (reason === 'subscription_cycle') return 'renewal'
  if (reason === 'subscription_update') return 'adjustment'
  return 'unsupported'
}

export function mapStripeSubscription(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const item = subscription.items.data[0]
  if (!item || subscription.items.has_more || subscription.items.data.length !== 1) {
    throw new Error('Subscription snapshots require a single subscription item')
  }
  return {
    providerSubscriptionId: subscription.id,
    providerCustomerId: stripeObjectId(subscription.customer),
    providerPriceId: item.price.id,
    status: mapStripeSubscriptionStatus(subscription.status),
    remoteStatus: subscription.status,
    currentPeriodStart: stripeDate(item.current_period_start),
    currentPeriodEnd: stripeDate(item.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at === null ? null : stripeDate(subscription.canceled_at),
    trialEnd: subscription.trial_end === null ? null : stripeDate(subscription.trial_end),
    // Stripe has no timestamp for the transition to past_due; don't invent a grace-period start.
    pastDueSince: null,
    metadata: parseStripeMetadata(subscription.metadata),
    raw: stripeRaw(subscription),
  }
}

export function stripeInvoiceSubscription(invoice: Stripe.Invoice): string | null {
  return invoice.parent?.type === 'subscription_details'
    ? stripeObjectId(invoice.parent.subscription_details?.subscription ?? null)
    : null
}

/** Use the historical invoice's recurring line, never the subscription's current period. */
export function stripeInvoicePeriod(
  invoice: Stripe.Invoice,
  lines: Stripe.InvoiceLineItem[] = invoice.lines.data,
): { start: Date; end: Date } {
  if (lines === invoice.lines.data && invoice.lines.has_more) {
    throw new Error('Invoice period requires complete line items')
  }
  const subscriptionId = stripeInvoiceSubscription(invoice)
  const adjustment = classifyStripeBillingReason(invoice.billing_reason) === 'adjustment'
  const metadata = parseStripeMetadata(invoice.parent?.subscription_details?.metadata)
  const relevant = lines.filter((line) => {
    const details = line.parent?.subscription_item_details
    return (
      line.parent?.type === 'subscription_item_details' &&
      details?.subscription === subscriptionId &&
      (adjustment ? details?.proration && line.amount > 0 : !details?.proration)
    )
  })
  const line = relevant[0]
  if (!subscriptionId || !line || relevant.length !== 1 || line.period.end <= line.period.start) {
    throw new Error('Invoice requires one unambiguous recurring subscription period')
  }
  if (
    adjustment &&
    (!metadata || line.pricing?.type !== 'price_details' || !line.pricing.price_details?.price)
  ) {
    throw new Error('Adjustment requires an unambiguous metadata target price')
  }
  return { start: stripeDate(line.period.start), end: stripeDate(line.period.end) }
}

export function mapStripeOrder(session: Stripe.Checkout.Session): OrderSnapshot {
  if (session.mode !== 'payment' || session.ui_mode !== 'hosted_page') {
    throw new Error('Orders require a hosted payment Checkout Session')
  }
  if (session.amount_total === null || !session.currency) {
    throw new Error('Checkout Session is missing order amount or currency')
  }
  if (!session.line_items || session.line_items.has_more || session.line_items.data.length !== 1) {
    throw new Error('Orders require a single Checkout line item')
  }
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null
  const charge = intent && typeof intent.latest_charge === 'object' ? intent.latest_charge : null
  const status = charge?.refunded
    ? 'refunded'
    : session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
      ? 'paid'
      : session.status === 'expired' || intent?.status === 'canceled'
        ? 'failed'
        : 'pending'
  return {
    providerOrderId: session.id,
    providerCustomerId: stripeObjectId(session.customer),
    providerPriceId: session.line_items.data[0]?.price?.id ?? null,
    status,
    amount: session.amount_total,
    currency: session.currency,
    metadata: parseStripeMetadata(session.metadata),
    raw: stripeRaw(session),
  }
}

/** Charge.amount_refunded is cumulative, even when charge.refunds is paginated. */
export function mapStripePaidIntent(intent: Stripe.PaymentIntent, charge: Stripe.Charge) {
  if (
    intent.status !== 'succeeded' ||
    !charge.paid ||
    !charge.captured ||
    stripeObjectId(charge.payment_intent) !== intent.id
  ) {
    throw new Error('PaymentIntent is not paid')
  }
  return {
    providerPaymentId: intent.id,
    providerCustomerId: stripeObjectId(intent.customer),
    amount: intent.amount_received,
    currency: intent.currency,
    paidAt: stripeDate(charge.created),
    refundedAmount: charge.amount_refunded,
    status: charge.disputed
      ? ('disputed' as const)
      : charge.amount_refunded >= intent.amount_received
        ? ('refunded' as const)
        : charge.amount_refunded > 0
          ? ('partially_refunded' as const)
          : ('succeeded' as const),
    metadata: parseStripeMetadata(intent.metadata),
    raw: stripeRaw(intent),
  }
}

export async function getStripeSubscription(
  stripe: Stripe,
  id: string,
): Promise<SubscriptionSnapshot> {
  return mapStripeSubscription(await stripe.subscriptions.retrieve(id))
}

export async function getStripeOrder(stripe: Stripe, id: string): Promise<OrderSnapshot> {
  return mapStripeOrder(
    await stripe.checkout.sessions.retrieve(id, {
      expand: ['line_items.data.price', 'payment_intent.latest_charge'],
    }),
  )
}

export async function getStripePayment(
  stripe: Stripe,
  reference: PaymentReference,
): Promise<PaymentSnapshot> {
  const intent = await stripe.paymentIntents.retrieve(reference.providerPaymentId, {
    expand: ['latest_charge'],
  })
  if (intent.status !== 'succeeded' || !intent.latest_charge) {
    throw new Error('PaymentIntent is not paid')
  }
  const charge =
    typeof intent.latest_charge === 'string'
      ? await stripe.charges.retrieve(intent.latest_charge)
      : intent.latest_charge
  const paid = mapStripePaidIntent(intent, charge)
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: intent.id },
    status: 'paid',
    limit: 2,
  })
  if (payments.has_more || payments.data.length > 1) {
    throw new Error('PaymentIntent attached to multiple invoices is unsupported')
  }
  const invoicePayment = payments.data[0]
  if (invoicePayment) {
    if (
      invoicePayment.payment.type !== 'payment_intent' ||
      stripeObjectId(invoicePayment.payment.payment_intent ?? null) !== intent.id
    ) {
      throw new Error('InvoicePayment does not match PaymentIntent')
    }
    const invoiceId = stripeObjectId(invoicePayment.invoice)
    if (!invoiceId) throw new Error('InvoicePayment has no invoice')
    const invoice = await stripe.invoices.retrieve(invoiceId)
    const subscriptionId = stripeInvoiceSubscription(invoice)
    if (subscriptionId) {
      const kind = classifyStripeBillingReason(invoice.billing_reason)
      if (kind !== 'initial' && kind !== 'renewal' && kind !== 'adjustment') {
        throw new Error(`Unsupported subscription payment classification: ${kind}`)
      }
      if (reference.kind !== kind)
        throw new Error(`Payment kind does not match invoice billing reason: ${kind}`)
      if (invoice.status !== 'paid' || invoicePayment.status_transitions.paid_at === null) {
        throw new Error('Subscription invoice is not paid')
      }
      const lines = invoice.lines.has_more
        ? await stripe.invoices.listLineItems(invoice.id).autoPagingToArray({ limit: 100 })
        : invoice.lines.data
      const period = stripeInvoicePeriod(invoice, lines)
      const priceLines = lines.filter(
        (line) =>
          line.amount > 0 &&
          line.parent?.type === 'subscription_item_details' &&
          line.parent.subscription_item_details?.subscription === subscriptionId &&
          line.parent.subscription_item_details.proration === (kind === 'adjustment'),
      )
      const priceIds = new Set(
        priceLines.map((line) => stripeObjectId(line.pricing?.price_details?.price ?? null)),
      )
      if (priceIds.size !== 1 || priceIds.has(null))
        throw new Error('Payment requires one historical subscription price')
      const providerPriceId = [...priceIds][0] as string
      if (kind === 'adjustment') {
        const target = lines.find(
          (line) =>
            line.amount > 0 &&
            line.parent?.type === 'subscription_item_details' &&
            line.parent.subscription_item_details?.subscription === subscriptionId &&
            line.parent.subscription_item_details.proration,
        )
        const targetPriceId = stripeObjectId(target?.pricing?.price_details?.price ?? null)
        if (!targetPriceId) throw new Error('Adjustment has no target price')
        const targetPrice = await stripe.prices.retrieve(targetPriceId)
        if (
          targetPrice.metadata.planPriceId !==
          invoice.parent?.subscription_details?.metadata?.planPriceId
        ) {
          throw new Error('Adjustment price does not match invoice target metadata')
        }
      }
      return {
        ...paid,
        kind,
        providerSubscriptionId: subscriptionId,
        providerPriceId,
        period,
        paidAt: stripeDate(invoicePayment.status_transitions.paid_at),
        metadata: parseStripeMetadata(invoice.parent?.subscription_details?.metadata),
        raw: stripeRaw({ paymentIntent: intent, invoicePayment, invoice }),
      }
    }
  }
  if (reference.kind !== 'one_time')
    throw new Error('Payment has no subscription invoice association')
  const sessions = await stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 2 })
  const session = sessions.data[0]
  if (
    sessions.has_more ||
    sessions.data.length !== 1 ||
    !session ||
    session.mode !== 'payment' ||
    session.ui_mode !== 'hosted_page' ||
    session.payment_status !== 'paid' ||
    stripeObjectId(session.payment_intent) !== intent.id
  ) {
    throw new Error('Payment requires one paid hosted Checkout Session association')
  }
  return {
    ...paid,
    kind: 'one_time',
    providerOrderId: session.id,
    period: null,
    metadata: parseStripeMetadata(session.metadata),
    raw: stripeRaw({ paymentIntent: intent, session }),
  }
}

/** Compose with operations and verified webhook normalization in the next adapter slice. */
export function createStripeSnapshots(stripe: Stripe): StripeSnapshots {
  return {
    getSubscription: (id) => getStripeSubscription(stripe, id),
    getOrder: (id) => getStripeOrder(stripe, id),
    getPayment: (reference) => getStripePayment(stripe, reference),
  }
}
