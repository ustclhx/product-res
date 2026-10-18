import type { CheckoutInput, PaymentProvider, PlanSyncInput, RefundInput } from '../provider.ts'
import { encodePayPalMetadata } from './metadata.ts'
import { fromPayPalDecimal, paypalCurrency, toPayPalDecimal } from './money.ts'
import type { PayPalTransport } from './transport.ts'

export type PayPalOperations = Required<
  Pick<
    PaymentProvider,
    | 'createCheckout'
    | 'confirmCheckout'
    | 'cancelSubscription'
    | 'resumeSubscription'
    | 'refund'
    | 'syncPlan'
  >
>

type RemoteResource = { id: string; links?: { rel: string; href: string }[] }
type RemotePlan = {
  id: string
  product_id: string
  description?: string
  status: string
  quantity_supported?: boolean
  billing_cycles: {
    tenure_type: string
    sequence: number
    total_cycles: number
    frequency: { interval_unit: string; interval_count: number }
    pricing_scheme: { fixed_price?: { value: string; currency_code: string }; tiers?: unknown[] }
  }[]
  payment_preferences?: { setup_fee?: { value: string; currency_code: string } }
  taxes?: { percentage: string }
}

function remoteId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid PayPal resource ID')
  return id
}

function creditPackId(priceId: string): string {
  return `paypal:credit_pack:${priceId}`
}
function planMarker(input: PlanSyncInput): string {
  return `saas:v1:${input.plan.id}:${input.price.id}`
}

function checkoutMapping(input: CheckoutInput) {
  const { price } = input
  if (
    price.provider !== 'paypal' ||
    !price.active ||
    (input.mode === 'subscription') !== (price.interval !== null)
  )
    throw new Error('Expected an active matching PayPal price')
  if (input.mode === 'subscription') {
    if (!/^P-[A-Z0-9]+$/.test(price.providerPriceId))
      throw new Error('Expected a PayPal subscription plan ID')
  } else if (price.providerPriceId !== creditPackId(price.id))
    throw new Error('Invalid PayPal credit pack mapping')
}

async function createCheckout(transport: PayPalTransport, input: CheckoutInput) {
  checkoutMapping(input)
  const value = toPayPalDecimal(input.price.amount, input.price.currency)
  const customId = encodePayPalMetadata({
    workspaceId: input.workspaceId,
    planPriceId: input.price.id,
    userId: input.userId,
  })
  const subscription = input.mode === 'subscription'
  const resource = await transport.request<RemoteResource>(
    'POST',
    subscription ? '/v1/billing/subscriptions' : '/v2/checkout/orders',
    {
      idempotencyKey: input.idempotencyKey,
      body: subscription
        ? {
            plan_id: input.price.providerPriceId,
            custom_id: customId,
            subscriber: { email_address: input.customerEmail },
            application_context: {
              shipping_preference: 'NO_SHIPPING',
              user_action: 'SUBSCRIBE_NOW',
              return_url: input.successUrl,
              cancel_url: input.cancelUrl,
            },
          }
        : {
            intent: 'CAPTURE',
            purchase_units: [{ custom_id: customId, amount: { currency_code: 'USD', value } }],
            payment_source: {
              paypal: {
                experience_context: {
                  shipping_preference: 'NO_SHIPPING',
                  user_action: 'PAY_NOW',
                  return_url: input.successUrl,
                  cancel_url: input.cancelUrl,
                },
              },
            },
          },
    },
  )
  const url = resource.links?.find(
    (link) => link.rel === 'approve' || link.rel === 'payer-action',
  )?.href
  if (!url || !resource.id) throw new Error('PayPal checkout response lacks approval URL or ID')
  return { url, providerRef: resource.id }
}

async function refund(transport: PayPalTransport, input: RefundInput) {
  const currency = paypalCurrency(input.currency)
  if (input.amount !== undefined && input.amount <= 0)
    throw new Error('Refund amount must be positive')
  const value = input.amount === undefined ? undefined : toPayPalDecimal(input.amount, currency)
  const sale = input.kind === 'initial' || input.kind === 'renewal'
  if (!sale && input.kind !== 'one_time') throw new Error('Invalid payment kind')
  if (sale && value !== undefined && value.length > 10)
    throw new Error('Sale refund exceeds PayPal amount limit')
  const result = await transport.request<RemoteResource>(
    'POST',
    sale
      ? `/v1/payments/sale/${remoteId(input.providerPaymentId)}/refund`
      : `/v2/payments/captures/${remoteId(input.providerPaymentId)}/refund`,
    {
      idempotencyKey: input.idempotencyKey,
      body:
        value === undefined
          ? {}
          : { amount: sale ? { total: value, currency } : { value, currency_code: currency } },
    },
  )
  if (!result.id) throw new Error('PayPal refund response lacks an ID')
  return { providerRefundId: result.id }
}

async function syncPlan(transport: PayPalTransport, input: PlanSyncInput) {
  const value = toPayPalDecimal(input.price.amount, input.price.currency)
  if (!input.idempotencyKey.trim()) throw new Error('A stable sync idempotency key is required')
  if ((input.plan.type === 'subscription') !== (input.price.interval !== null))
    throw new Error('Plan type must match the price interval')
  if (input.plan.type === 'credit_pack') {
    const id = creditPackId(input.price.id)
    if (input.providerPriceId && input.providerPriceId !== id)
      throw new Error('Credit pack mapping drift')
    return { providerPriceId: id }
  }
  const marker = planMarker(input)
  const unit = input.price.interval === 'year' ? 'YEAR' : 'MONTH'
  if (input.providerPriceId) {
    const existing = await transport.request<RemotePlan>(
      'GET',
      `/v1/billing/plans/${remoteId(input.providerPriceId)}`,
    )
    const cycle = existing.billing_cycles?.[0]
    const fixed = cycle?.pricing_scheme.fixed_price
    if (
      existing.id !== input.providerPriceId ||
      existing.description !== marker ||
      existing.billing_cycles.length !== 1 ||
      !cycle ||
      cycle.tenure_type !== 'REGULAR' ||
      cycle.sequence !== 1 ||
      cycle.total_cycles !== 0 ||
      cycle.frequency.interval_unit !== unit ||
      cycle.frequency.interval_count !== 1 ||
      !fixed ||
      fixed.currency_code !== 'USD' ||
      fromPayPalDecimal(fixed.value, fixed.currency_code) !== input.price.amount ||
      cycle.pricing_scheme.tiers?.length ||
      existing.quantity_supported ||
      (existing.payment_preferences?.setup_fee &&
        fromPayPalDecimal(
          existing.payment_preferences.setup_fee.value,
          existing.payment_preferences.setup_fee.currency_code,
        ) !== 0) ||
      (existing.taxes && !/^0(?:\.0+)?$/.test(existing.taxes.percentage))
    )
      throw new Error('Immutable PayPal plan mapping drift')
    const product = await transport.request<{ id: string; description?: string }>(
      'GET',
      `/v1/catalogs/products/${remoteId(existing.product_id)}`,
    )
    if (product.description !== `saas:v1:${input.plan.id}`)
      throw new Error('PayPal product mapping drift')
    const active = input.plan.active && input.price.active
    if (active !== (existing.status === 'ACTIVE')) {
      await transport.request<void>(
        'POST',
        `/v1/billing/plans/${remoteId(existing.id)}/${active ? 'activate' : 'deactivate'}`,
        { body: {} },
      )
    }
    return { providerPriceId: existing.id }
  }
  // Supplied retry key belongs to this sync attempt; persist the returned mapping.
  // PayPal retains creation keys for a limited time, not forever.
  const product = await transport.request<RemoteResource>('POST', '/v1/catalogs/products', {
    idempotencyKey: `${input.idempotencyKey}:product`,
    body: { name: input.plan.name, type: 'SERVICE', description: `saas:v1:${input.plan.id}` },
  })
  const plan = await transport.request<RemoteResource>('POST', '/v1/billing/plans', {
    idempotencyKey: `${input.idempotencyKey}:plan`,
    body: {
      product_id: remoteId(product.id),
      name: input.plan.name,
      description: marker,
      status: input.plan.active && input.price.active ? 'ACTIVE' : 'CREATED',
      billing_cycles: [
        {
          frequency: { interval_unit: unit, interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { currency_code: 'USD', value } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
  })
  return { providerPriceId: remoteId(plan.id) }
}

/** Compose with snapshots and verified webhooks later; this is deliberately not a PaymentProvider. */
export function createPayPalOperations(transport: PayPalTransport): PayPalOperations {
  return {
    createCheckout: (input) => createCheckout(transport, input),
    confirmCheckout: async (id, options) => {
      if (id.startsWith('I-')) throw new Error('Subscription approval does not use Orders capture')
      await transport.request('POST', `/v2/checkout/orders/${remoteId(id)}/capture`, {
        body: {},
        idempotencyKey: options.idempotencyKey,
      })
      // Never grant credits: only the verified payment event consumer can do that.
    },
    cancelSubscription: async (id, options) => {
      // No remote period-end scheduling in Subscriptions v1. Local entitlements
      // must remain valid through the paid period; reconciler later terminal-cancels.
      await transport.request(
        'POST',
        `/v1/billing/subscriptions/${remoteId(id)}/${options.atPeriodEnd ? 'suspend' : 'cancel'}`,
        {
          body: {
            reason: options.atPeriodEnd
              ? 'Stop collection; local paid period remains valid'
              : 'Immediate cancellation requested',
          },
        },
      )
    },
    resumeSubscription: async (id) => {
      await transport.request('POST', `/v1/billing/subscriptions/${remoteId(id)}/activate`, {
        body: { reason: 'Resume collection requested' },
      })
    },
    refund: (input) => refund(transport, input),
    syncPlan: (input) => syncPlan(transport, input),
  }
}
