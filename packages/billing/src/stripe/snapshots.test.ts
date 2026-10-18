import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { createStripeClient, STRIPE_API_VERSION } from './client.ts'
import { classifyStripeBillingReason, createStripeSnapshots } from './snapshots.ts'

const metadata = {
  workspaceId: '019a0000-0000-7000-8000-000000000001',
  userId: '019a0000-0000-7000-8000-000000000002',
  planPriceId: '019a0000-0000-7000-8000-000000000003',
}
const start = 1800000000
const end = 1802592000
const charge = {
  id: 'ch_test',
  object: 'charge',
  amount: 2000,
  amount_captured: 2000,
  amount_refunded: 0,
  captured: true,
  paid: true,
  disputed: false,
  refunded: false,
  currency: 'usd',
  created: start + 5,
  customer: 'cus_test',
  payment_intent: 'pi_test',
  refunds: { object: 'list', data: [], has_more: false, url: '/v1/charges/ch_test/refunds' },
}
const intent = {
  id: 'pi_test',
  object: 'payment_intent',
  status: 'succeeded',
  amount: 2000,
  amount_received: 2000,
  currency: 'usd',
  customer: 'cus_test',
  created: start,
  metadata: {},
  latest_charge: charge,
}
const session = {
  id: 'cs_test',
  object: 'checkout.session',
  mode: 'payment',
  ui_mode: 'hosted_page',
  status: 'complete',
  payment_status: 'paid',
  payment_intent: 'pi_test',
  customer: 'cus_test',
  amount_total: 2000,
  currency: 'usd',
  metadata,
  line_items: {
    object: 'list',
    data: [{ id: 'li_test', object: 'item', quantity: 1, price: { id: 'price_test' } }],
    has_more: false,
    url: '/v1/checkout/sessions/cs_test/line_items',
  },
}
const subscription = {
  id: 'sub_test',
  object: 'subscription',
  customer: { id: 'cus_test', object: 'customer' },
  status: 'active',
  metadata,
  cancel_at_period_end: true,
  canceled_at: start + 100,
  trial_end: null,
  items: {
    object: 'list',
    data: [
      {
        id: 'si_test',
        object: 'subscription_item',
        subscription: 'sub_test',
        price: { id: 'price_test' },
        quantity: 1,
        current_period_start: start,
        current_period_end: end,
      },
    ],
    has_more: false,
    url: '/v1/subscription_items?subscription=sub_test',
  },
}
const line = {
  id: 'il_test',
  object: 'line_item',
  amount: 2000,
  currency: 'usd',
  period: { start, end },
  parent: {
    type: 'subscription_item_details',
    invoice_item_details: null,
    subscription_item_details: {
      subscription: 'sub_test',
      subscription_item: 'si_test',
      invoice_item: null,
      proration: false,
      proration_details: null,
    },
  },
  pricing: { type: 'price_details', price_details: { price: 'price_test', product: 'prod_test' } },
}
const invoice = {
  id: 'in_old',
  object: 'invoice',
  status: 'paid',
  billing_reason: 'subscription_cycle',
  currency: 'usd',
  amount_paid: 2000,
  parent: {
    type: 'subscription_details',
    quote_details: null,
    subscription_details: { subscription: 'sub_test', metadata },
  },
  lines: { object: 'list', data: [line], has_more: false, url: '/v1/invoices/in_old/lines' },
}
const invoicePayment = {
  id: 'inpay_test',
  object: 'invoice_payment',
  invoice: 'in_old',
  status: 'paid',
  amount_paid: 2000,
  amount_requested: 2000,
  currency: 'usd',
  created: start,
  is_default: true,
  livemode: false,
  payment: { type: 'payment_intent', payment_intent: 'pi_test' },
  status_transitions: { paid_at: start + 6, canceled_at: null },
} satisfies Stripe.InvoicePayment
function list(data: unknown[], url: string, has_more = false) {
  return { object: 'list', data, has_more, url }
}
interface Reply {
  path: string
  body: unknown
  status?: number
}
function mockStripe(replies: Reply[]) {
  const requests: { url: URL; headers: Headers }[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const reply = replies[requests.length]
    requests.push({ url, headers: new Headers(init?.headers) })
    if (!reply || reply.path !== url.pathname || init?.method !== 'GET') {
      throw new Error(`Unexpected offline request: ${init?.method} ${url.pathname}`)
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const stripe = createStripeClient('sk_test_offline_only', fetchFn)
  return {
    snapshots: createStripeSnapshots(stripe),
    requests,
    complete: () => expect(requests).toHaveLength(replies.length),
  }
}
function invoiceReplies(invoiceBody: unknown = invoice, intentBody: unknown = intent): Reply[] {
  return [
    { path: '/v1/payment_intents/pi_test', body: intentBody },
    { path: '/v1/invoice_payments', body: list([invoicePayment], '/v1/invoice_payments') },
    { path: '/v1/invoices/in_old', body: invoiceBody },
  ]
}

describe('Stripe subscription snapshots', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'trialing'],
    ['past_due', 'past_due'],
    ['canceled', 'canceled'],
    ['paused', 'paused'],
    ['unpaid', 'paused'],
    ['incomplete', 'paused'],
    ['incomplete_expired', 'expired'],
  ])('preserves %s and maps to %s with item period dates', async (remoteStatus, status) => {
    const mock = mockStripe([
      { path: '/v1/subscriptions/sub_test', body: { ...subscription, status: remoteStatus } },
    ])
    expect(await mock.snapshots.getSubscription('sub_test')).toMatchObject({
      providerSubscriptionId: 'sub_test',
      providerCustomerId: 'cus_test',
      providerPriceId: 'price_test',
      remoteStatus,
      status,
      currentPeriodStart: new Date(start * 1000),
      currentPeriodEnd: new Date(end * 1000),
      cancelAtPeriodEnd: true,
      canceledAt: new Date((start + 100) * 1000),
      trialEnd: null,
      pastDueSince: null,
      metadata,
    })
    expect(mock.requests[0]?.headers.get('stripe-version')).toBe(STRIPE_API_VERSION)
    mock.complete()
  })
  it.each([
    { ...subscription, items: { ...subscription.items, data: [] } },
    { ...subscription, items: { ...subscription.items, has_more: true } },
    { ...subscription, status: 'future_status' },
  ])('rejects unsupported subscription shapes', async (body) => {
    const mock = mockStripe([{ path: '/v1/subscriptions/sub_test', body }])
    await expect(mock.snapshots.getSubscription('sub_test')).rejects.toThrow()
    mock.complete()
  })
})

describe('Stripe order snapshots', () => {
  it.each([
    [session, 'paid'],
    [{ ...session, status: 'open', payment_status: 'unpaid', payment_intent: null }, 'pending'],
    [{ ...session, status: 'expired', payment_status: 'unpaid', payment_intent: null }, 'failed'],
    [
      {
        ...session,
        payment_intent: {
          ...intent,
          latest_charge: { ...charge, amount_refunded: 2000, refunded: true },
        },
      },
      'refunded',
    ],
    [
      {
        ...session,
        payment_intent: { ...intent, latest_charge: { ...charge, amount_refunded: 500 } },
      },
      'paid',
    ],
  ] as const)('maps hosted Checkout state %#', async (body, status) => {
    const mock = mockStripe([{ path: '/v1/checkout/sessions/cs_test', body }])
    expect(await mock.snapshots.getOrder('cs_test')).toMatchObject({
      providerOrderId: 'cs_test',
      providerCustomerId: 'cus_test',
      providerPriceId: 'price_test',
      amount: 2000,
      currency: 'usd',
      status,
      metadata,
    })
    expect(mock.requests[0]?.url.searchParams.get('expand[1]')).toBe('payment_intent.latest_charge')
    mock.complete()
  })
  it('rejects a subscription Checkout as an order', async () => {
    const mock = mockStripe([
      { path: '/v1/checkout/sessions/cs_test', body: { ...session, mode: 'subscription' } },
    ])
    await expect(mock.snapshots.getOrder('cs_test')).rejects.toThrow('hosted payment')
    mock.complete()
  })
})

describe('Stripe payment associations', () => {
  it.each([
    ['subscription_create', 'initial'],
    ['subscription_cycle', 'renewal'],
  ] as const)(
    'maps %s using the old invoice period and immutable source metadata',
    async (reason, kind) => {
      const mock = mockStripe(invoiceReplies({ ...invoice, billing_reason: reason }))
      expect(await mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind })).toMatchObject(
        {
          providerPaymentId: 'pi_test',
          kind,
          providerSubscriptionId: 'sub_test',
          period: { start: new Date(start * 1000), end: new Date(end * 1000) },
          paidAt: new Date((start + 6) * 1000),
          metadata,
        },
      )
      expect(mock.requests[1]?.url.searchParams.get('payment[payment_intent]')).toBe('pi_test')
      expect(mock.requests[1]?.url.searchParams.get('payment[type]')).toBe('payment_intent')
      mock.complete() // No current-subscription retrieve can overwrite the historical invoice period.
    },
  )
  it('classifies upgrades without ever calling them renewal', async () => {
    expect(classifyStripeBillingReason('subscription_update')).toBe('adjustment')
    expect(classifyStripeBillingReason('manual')).toBe('unsupported')
    const mock = mockStripe(invoiceReplies({ ...invoice, billing_reason: 'subscription_update' }))
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'renewal' }),
    ).rejects.toThrow('adjustment')
    mock.complete()
  })
  it('rejects incorrect initial/renewal association supplied by the caller', async () => {
    const mock = mockStripe(invoiceReplies())
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'initial' }),
    ).rejects.toThrow('billing reason')
    mock.complete()
  })
  it('loads paginated invoice lines and skips an unrelated proration', async () => {
    const mock = mockStripe([
      ...invoiceReplies({ ...invoice, lines: { ...invoice.lines, has_more: true } }),
      {
        path: '/v1/invoices/in_old/lines',
        body: list(
          [
            {
              ...line,
              id: 'il_prorate',
              parent: {
                ...line.parent,
                subscription_item_details: {
                  ...line.parent.subscription_item_details,
                  proration: true,
                },
              },
            },
            line,
          ],
          '/v1/invoices/in_old/lines',
        ),
      },
    ])
    expect(
      (await mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'renewal' })).period,
    ).toEqual({ start: new Date(start * 1000), end: new Date(end * 1000) })
    mock.complete()
  })
  it.each([
    [500, 'partially_refunded'],
    [2000, 'refunded'],
  ] as const)(
    'uses cumulative refunded amount %s despite incomplete embedded refunds',
    async (amount, status) => {
      const mock = mockStripe([
        {
          path: '/v1/payment_intents/pi_test',
          body: {
            ...intent,
            latest_charge: {
              ...charge,
              amount_refunded: amount,
              refunds: {
                ...charge.refunds,
                has_more: true,
                data: [{ id: 're_latest', object: 'refund', amount: 100, status: 'succeeded' }],
              },
            },
          },
        },
        { path: '/v1/invoice_payments', body: list([], '/v1/invoice_payments') },
        { path: '/v1/checkout/sessions', body: list([session], '/v1/checkout/sessions') },
      ])
      expect(
        await mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'one_time' }),
      ).toMatchObject({
        kind: 'one_time',
        providerOrderId: 'cs_test',
        period: null,
        refundedAmount: amount,
        status,
        metadata,
      })
      expect(mock.requests[2]?.url.searchParams.get('payment_intent')).toBe('pi_test')
      mock.complete()
    },
  )
  it('rejects an unpaid PaymentIntent with no latest charge before association queries', async () => {
    const mock = mockStripe([
      {
        path: '/v1/payment_intents/pi_test',
        body: { ...intent, status: 'processing', latest_charge: null },
      },
    ])
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'one_time' }),
    ).rejects.toThrow('not paid')
    mock.complete()
  })
  it('rejects absent stable Checkout association', async () => {
    const mock = mockStripe([
      { path: '/v1/payment_intents/pi_test', body: intent },
      { path: '/v1/invoice_payments', body: list([], '/v1/invoice_payments') },
      { path: '/v1/checkout/sessions', body: list([], '/v1/checkout/sessions') },
    ])
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'one_time' }),
    ).rejects.toThrow('association')
    mock.complete()
  })
  it('rejects invoices without a relevant recurring line', async () => {
    const mock = mockStripe(invoiceReplies({ ...invoice, lines: { ...invoice.lines, data: [] } }))
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'renewal' }),
    ).rejects.toThrow('period')
    mock.complete()
  })

  it('records an adjustment against its positive target proration period, excluding unused credit', async () => {
    const proration = {
      ...line,
      metadata,
      period: { start: start + 100, end },
      parent: {
        ...line.parent,
        subscription_item_details: { ...line.parent.subscription_item_details, proration: true },
      },
    }
    const target = {
      ...invoice,
      billing_reason: 'subscription_update',
      lines: {
        ...invoice.lines,
        data: [
          { ...proration, id: 'il_credit', amount: -500 },
          { ...proration, amount: 2500 },
        ],
      },
    }
    const mock = mockStripe([
      ...invoiceReplies(target),
      { path: '/v1/prices/price_test', body: { id: 'price_test', metadata } },
    ])
    expect(
      await mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'adjustment' }),
    ).toMatchObject({
      kind: 'adjustment',
      providerSubscriptionId: 'sub_test',
      period: { start: new Date((start + 100) * 1000), end: new Date(end * 1000) },
    })
    mock.complete()
  })
  it.each(['negative_only', 'ambiguous', 'foreign_subscription', 'invalid_period'] as const)(
    'rejects adjustment period %s',
    async (condition) => {
      const positive = {
        ...line,
        metadata,
        parent: {
          ...line.parent,
          subscription_item_details: {
            ...line.parent.subscription_item_details,
            proration: true,
            subscription: condition === 'foreign_subscription' ? 'sub_other' : 'sub_test',
          },
        },
        amount: condition === 'negative_only' ? -500 : 2500,
        period: condition === 'invalid_period' ? { start: end, end: start } : line.period,
      }
      const mock = mockStripe(
        invoiceReplies({
          ...invoice,
          billing_reason: 'subscription_update',
          lines: {
            ...invoice.lines,
            data:
              condition === 'ambiguous' ? [positive, { ...positive, id: 'il_other' }] : [positive],
          },
        }),
      )
      await expect(
        mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'adjustment' }),
      ).rejects.toThrow('period')
      mock.complete()
    },
  )
  it('rejects an adjustment whose remote price disagrees with the invoice target metadata', async () => {
    const positive = {
      ...line,
      metadata,
      parent: {
        ...line.parent,
        subscription_item_details: { ...line.parent.subscription_item_details, proration: true },
      },
    }
    const mock = mockStripe([
      ...invoiceReplies({
        ...invoice,
        billing_reason: 'subscription_update',
        lines: { ...invoice.lines, data: [positive] },
      }),
      {
        path: '/v1/prices/price_test',
        body: { id: 'price_test', metadata: { planPriceId: 'other' } },
      },
    ])
    await expect(
      mock.snapshots.getPayment({ providerPaymentId: 'pi_test', kind: 'adjustment' }),
    ).rejects.toThrow('target metadata')
    mock.complete()
  })
  it('propagates SDK errors and rejects unexpected HTTP attempts offline', async () => {
    const missing = mockStripe([
      {
        path: '/v1/subscriptions/sub_missing',
        status: 404,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'No such subscription',
          },
        },
      },
    ])
    await expect(missing.snapshots.getSubscription('sub_missing')).rejects.toBeInstanceOf(
      Stripe.errors.StripeInvalidRequestError,
    )
    missing.complete()
    const unexpected = mockStripe([])
    await expect(unexpected.snapshots.getOrder('cs_unexpected')).rejects.toBeInstanceOf(
      Stripe.errors.StripeConnectionError,
    )
  })
})
