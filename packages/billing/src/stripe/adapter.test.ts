import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { createPaymentRuntime } from '../runtime.ts'
import { createStripeProvider, createStripeWebhookNormalizer } from './adapter.ts'
import { STRIPE_API_VERSION } from './client.ts'

// Synthetic current-API fixtures, not recorded Stripe deliveries.
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

const webhookSecret = 'whsec_offline_synthetic'
async function signed(
  type: string,
  object: unknown,
  options: {
    timestamp?: number
    version?: string
    signingSecret?: string
    livemode?: boolean
  } = {},
) {
  const rawBody = JSON.stringify({
    id: 'evt_test',
    object: 'event',
    type,
    created: start + 42,
    api_version: options.version ?? STRIPE_API_VERSION,
    data: { object },
    livemode: options.livemode ?? false,
  })
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(options.signingSecret ?? webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`))
  const signature = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  )
  return {
    rawBody,
    request: new Request('https://offline.test/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
      body: rawBody,
    }),
  }
}
function mockProvider(replies: { path: string; body: unknown }[] = []) {
  const requests: URL[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const reply = replies[requests.length]
    requests.push(url)
    if (!reply || url.pathname !== reply.path || init?.method !== 'GET') {
      throw new Error(`Unexpected offline HTTP: ${init?.method} ${url.pathname}`)
    }
    return new Response(JSON.stringify(reply.body), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const provider = createStripeProvider({
    secretKey: 'sk_test_offline_only',
    webhookSecret,
    fetch: fetchFn,
  })
  return {
    provider,
    requests,
    complete: () => expect(requests).toHaveLength(replies.length),
    async verify(type: string, object: unknown) {
      const payload = await signed(type, object)
      return provider.verifyWebhook(payload.request, payload.rawBody)
    },
  }
}
function paymentReplies(invoiceBody?: unknown) {
  return [
    { path: '/v1/payment_intents/pi_test', body: intent },
    {
      path: '/v1/invoice_payments',
      body: list(invoiceBody ? [invoicePayment] : [], '/v1/invoice_payments'),
    },
    ...(invoiceBody
      ? [{ path: '/v1/invoices/in_old', body: invoiceBody }]
      : [{ path: '/v1/checkout/sessions', body: list([session], '/v1/checkout/sessions') }]),
  ]
}
describe('Stripe adapter with cryptographically signed synthetic fixtures', () => {
  it.each(['test', 'live'] as const)(
    'accepts signed and persisted events matching runtime mode %s',
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const runtime = createPaymentRuntime(
        {
          PAYMENT_MODE: mode,
          STRIPE_SECRET_KEY: mode === 'test' ? 'sk_test_offline_only' : 'rk_live_offline_only',
          STRIPE_WEBHOOK_SECRET: webhookSecret,
        },
        ['stripe'],
        { fetch },
      )
      const payload = await signed('customer.subscription.updated', subscription, {
        livemode: mode === 'live',
      })
      const verified = await runtime.providers.stripe?.verifyWebhook(
        payload.request,
        payload.rawBody,
      )
      expect(verified?.events[0]).toMatchObject({ type: 'subscription.updated' })
      expect(await runtime.normalizers.stripe?.(JSON.parse(payload.rawBody))).toEqual(verified)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['test', 'live'] as const)(
    'rejects signed and persisted cross-mode events before enrichment in %s runtime',
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const runtime = createPaymentRuntime(
        {
          PAYMENT_MODE: mode,
          STRIPE_SECRET_KEY: mode === 'test' ? 'sk_test_offline_only' : 'sk_live_offline_only',
          STRIPE_WEBHOOK_SECRET: webhookSecret,
        },
        ['stripe'],
        { fetch },
      )
      // invoice.paid 正常映射会先查询 invoice_payments，错配必须阻止该查询。
      const payload = await signed('invoice.paid', invoice, { livemode: mode !== 'live' })
      await expect(
        runtime.providers.stripe?.verifyWebhook(payload.request, payload.rawBody),
      ).rejects.toThrow('Stripe event does not match the payment mode')
      await expect(runtime.normalizers.stripe?.(JSON.parse(payload.rawBody))).rejects.toThrow(
        'Stripe event does not match the payment mode',
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('replays trusted persisted payloads with the same identity and normalization', async () => {
    const payload = await signed('customer.subscription.updated', subscription)
    const verified = await mockProvider().provider.verifyWebhook(payload.request, payload.rawBody)
    const replay = createStripeWebhookNormalizer({
      secretKey: 'sk_test_offline_only',
      fetch: async () => {
        throw new Error('Replay must not fetch this event')
      },
    })
    expect(await replay(JSON.parse(payload.rawBody))).toEqual(verified)
    await expect(
      replay({ ...JSON.parse(payload.rawBody), api_version: 'unknown' }),
    ).rejects.toThrow('Invalid stored Stripe event')
  })

  it('composes the full typed provider contract', () => {
    const { provider } = mockProvider()
    expect(provider.id).toBe('stripe')
    expect(provider.capabilities).toEqual({
      portal: true,
      changePlan: true,
      refundsViaApi: true,
      merchantOfRecord: false,
    })
    for (const method of [
      'createCheckout',
      'getPortalUrl',
      'cancelSubscription',
      'resumeSubscription',
      'changePlan',
      'refund',
      'syncPlan',
      'getSubscription',
      'getOrder',
      'getPayment',
      'verifyWebhook',
    ] as const) {
      expect(provider[method]).toBeTypeOf('function')
    }
  })
  it('requires a signature before parsing JSON or making any HTTP request', async () => {
    const mock = mockProvider()
    await expect(
      mock.provider.verifyWebhook(new Request('https://offline.test'), '{bad json'),
    ).rejects.toThrow('Missing Stripe-Signature')
    mock.complete()
  })
  it.each(['wrong_secret', 'stale', 'tampered', 'version'] as const)(
    'rejects %s before any network enrichment',
    async (condition) => {
      const mock = mockProvider()
      const payload = await signed('invoice.paid', invoice, {
        ...(condition === 'wrong_secret' ? { signingSecret: 'whsec_wrong' } : {}),
        ...(condition === 'stale' ? { timestamp: Math.floor(Date.now() / 1000) - 600 } : {}),
        ...(condition === 'version' ? { version: '2025-01-27.acacia' } : {}),
      })
      await expect(
        mock.provider.verifyWebhook(
          payload.request,
          condition === 'tampered'
            ? payload.rawBody.replace('in_old', 'in_altered')
            : payload.rawBody,
        ),
      ).rejects.toThrow()
      mock.complete()
    },
  )
  it('keeps unsupported original event names with zero normalized events', async () => {
    const mock = mockProvider()
    expect(await mock.verify('customer.created', { id: 'cus_test', object: 'customer' })).toEqual({
      providerEventId: 'evt_test',
      type: 'customer.created',
      events: [],
    })
    mock.complete()
  })
  it('subscription Checkout establishes only one association and never grants a payment', async () => {
    const mock = mockProvider()
    const result = await mock.verify('checkout.session.completed', {
      ...session,
      mode: 'subscription',
      subscription: 'sub_test',
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'checkout.completed',
      mode: 'subscription',
      providerSubscriptionId: 'sub_test',
      metadata,
    })
    mock.complete()
  })
  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])(
    '%s emits one-time association and payment with stable PaymentIntent identity',
    async (type) => {
      const mock = mockProvider(paymentReplies())
      const result = await mock.verify(type, session)
      expect(result.events.map((event) => event.type)).toEqual([
        'checkout.completed',
        'payment.succeeded',
      ])
      expect(result.events[1]).toMatchObject({
        payment: { kind: 'one_time', providerPaymentId: 'pi_test', providerOrderId: 'cs_test' },
      })
      expect(result.providerEventId).toBe('evt_test')
      mock.complete()
    },
  )
  it('unpaid delayed Checkout records only the association', async () => {
    const mock = mockProvider()
    const result = await mock.verify('checkout.session.completed', {
      ...session,
      payment_status: 'unpaid',
    })
    expect(result.events.map((event) => event.type)).toEqual(['checkout.completed'])
    mock.complete()
  })
  it.each([
    ['subscription_create', 'initial', ['payment.succeeded']],
    ['subscription_cycle', 'renewal', ['payment.succeeded', 'subscription.renewed']],
    ['subscription_update', 'adjustment', ['payment.succeeded']],
  ] as const)('classifies %s and renews only on renewal', async (reason, kind, types) => {
    const target = {
      ...invoice,
      billing_reason: reason,
      lines: {
        ...invoice.lines,
        data:
          reason === 'subscription_update'
            ? [
                {
                  ...line,
                  id: 'il_credit',
                  amount: -500,
                  metadata,
                  parent: {
                    ...line.parent,
                    subscription_item_details: {
                      ...line.parent.subscription_item_details,
                      proration: true,
                    },
                  },
                },
                {
                  ...line,
                  amount: 2500,
                  metadata,
                  period: { start: start + 100, end },
                  parent: {
                    ...line.parent,
                    subscription_item_details: {
                      ...line.parent.subscription_item_details,
                      proration: true,
                    },
                  },
                },
              ]
            : [line],
      },
    }
    const mock = mockProvider([
      { path: '/v1/invoice_payments', body: list([invoicePayment], '/v1/invoice_payments') },
      ...paymentReplies(target),
      ...(kind === 'adjustment'
        ? [{ path: '/v1/prices/price_test', body: { id: 'price_test', metadata } }]
        : []),
    ])
    const result = await mock.verify('invoice.paid', target)
    expect(result.events.map((event) => event.type)).toEqual(types)
    expect(result.events[0]).toMatchObject({
      payment: {
        kind,
        providerPaymentId: 'pi_test',
        providerSubscriptionId: 'sub_test',
        period: {
          start: new Date((kind === 'adjustment' ? start + 100 : start) * 1000),
          end: new Date(end * 1000),
        },
      },
    })
    expect(mock.requests[0]?.searchParams.get('invoice')).toBe('in_old')
    mock.complete()
  })
  it('unsupported invoice reasons do not become paid subscription credits', async () => {
    const mock = mockProvider()
    expect(
      (await mock.verify('invoice.paid', { ...invoice, billing_reason: 'manual' })).events,
    ).toEqual([])
    mock.complete()
  })
  it('failed invoice anchors past-due grace to event creation time', async () => {
    const mock = mockProvider()
    expect((await mock.verify('invoice.payment_failed', invoice)).events[0]).toMatchObject({
      type: 'subscription.past_due',
      pastDueSince: new Date((start + 42) * 1000),
    })
    mock.complete()
  })
  it.each(['active', 'trialing', 'incomplete', 'unpaid'] as const)(
    'created %s preserves remote status and activates only active/trialing',
    async (status) => {
      const mock = mockProvider()
      const event = (
        await mock.verify('customer.subscription.created', { ...subscription, status })
      ).events[0]
      expect(event).toMatchObject({
        type:
          status === 'active' || status === 'trialing'
            ? 'subscription.activated'
            : 'subscription.updated',
        subscription: {
          remoteStatus: status,
          currentPeriodStart: new Date(start * 1000),
          currentPeriodEnd: new Date(end * 1000),
        },
      })
      mock.complete()
    },
  )
  it('deletion preserves the snapshot and emits terminal cancellation with the real period', async () => {
    const mock = mockProvider()
    const result = await mock.verify('customer.subscription.deleted', {
      ...subscription,
      status: 'canceled',
    })
    expect(result.events.map((event) => event.type)).toEqual([
      'subscription.updated',
      'subscription.canceled',
    ])
    expect(result.events[0]).toMatchObject({ subscription: { remoteStatus: 'canceled' } })
    expect(result.events[1]).toMatchObject({
      currentPeriodEnd: new Date(end * 1000),
      canceledAt: new Date((start + 100) * 1000),
    })
    mock.complete()
  })
  it('complete signed refunds carry unique IDs and the same cumulative refunded amount on replay', async () => {
    const mock = mockProvider()
    const refund = {
      id: 're_first',
      object: 'refund',
      charge: 'ch_test',
      payment_intent: 'pi_test',
      status: 'succeeded',
      amount: 200,
      currency: 'usd',
    }
    const payload = {
      ...charge,
      amount_refunded: 500,
      refunds: {
        ...charge.refunds,
        has_more: false,
        data: [
          refund,
          { ...refund, id: 're_second', amount: 300 },
          refund,
          { ...refund, id: 're_failed', status: 'failed' },
        ],
      },
    }
    const first = await mock.verify('charge.refunded', payload)
    expect(first.events).toHaveLength(2)
    expect(first.events[0]).toMatchObject({
      providerRefundId: 're_first',
      providerPaymentId: 'pi_test',
      amount: 200,
      refundedAmount: 500,
    })
    expect(first.events[1]).toMatchObject({
      providerRefundId: 're_second',
      amount: 300,
      refundedAmount: 500,
    })
    expect(await mock.verify('charge.refunded', payload)).toEqual(first)
    mock.complete()
  })
  it.each(['missing', 'truncated'] as const)(
    'paginates $kind refunds on an old event without pairing newer refunds with its signed total',
    async (embedded) => {
      const refund = {
        id: 're_first',
        object: 'refund',
        charge: 'ch_test',
        payment_intent: 'pi_test',
        status: 'succeeded',
        amount: 200,
        currency: 'usd',
      }
      const mock = mockProvider([
        {
          path: '/v1/refunds',
          body: list(
            [refund, { ...refund, id: 're_failed', status: 'failed' }],
            '/v1/refunds',
            true,
          ),
        },
        {
          path: '/v1/refunds',
          body: list([refund, { ...refund, id: 're_newer', amount: 300 }], '/v1/refunds'),
        },
      ])
      const result = await mock.verify('charge.refunded', {
        ...charge,
        amount_refunded: 200,
        refunds:
          embedded === 'missing' ? undefined : list([refund], '/v1/charges/ch_test/refunds', true),
      })
      expect(result.events).toMatchObject([
        {
          type: 'payment.refunded',
          providerPaymentId: 'pi_test',
          providerRefundId: 're_first',
          amount: 200,
          refundedAmount: null,
        },
        {
          type: 'payment.refunded',
          providerPaymentId: 'pi_test',
          providerRefundId: 're_newer',
          amount: 300,
          refundedAmount: null,
        },
      ])
      expect(mock.requests.map((url) => Object.fromEntries(url.searchParams))).toEqual([
        { charge: 'ch_test', limit: '100' },
        { charge: 'ch_test', limit: '100', starting_after: 're_failed' },
      ])
      mock.complete()
    },
  )
  it.each([
    { charge: 'ch_other', payment_intent: 'pi_test' },
    { charge: 'ch_test', payment_intent: 'pi_other' },
  ])('rejects API refunds with a mismatched association: %j', async (association) => {
    const mock = mockProvider([
      {
        path: '/v1/refunds',
        body: list(
          [
            {
              id: 're_mismatched',
              object: 'refund',
              ...association,
              status: 'succeeded',
              amount: 200,
              currency: 'usd',
            },
          ],
          '/v1/refunds',
        ),
      },
    ])
    await expect(
      mock.verify('charge.refunded', { ...charge, amount_refunded: 200, refunds: undefined }),
    ).rejects.toThrow('Refund does not match its charge and PaymentIntent')
    mock.complete()
  })
  it('disputes preserve PaymentIntent and dispute IDs', async () => {
    const mock = mockProvider()
    expect(
      (
        await mock.verify('charge.dispute.created', {
          id: 'dp_test',
          object: 'dispute',
          payment_intent: 'pi_test',
          charge: 'ch_test',
          amount: 2000,
          currency: 'usd',
        })
      ).events[0],
    ).toMatchObject({
      type: 'payment.disputed',
      providerPaymentId: 'pi_test',
      providerDisputeId: 'dp_test',
    })
    mock.complete()
  })
  it('rejects ambiguous invoice payments instead of granting duplicate subscription credits', async () => {
    const mock = mockProvider([
      {
        path: '/v1/invoice_payments',
        body: list(
          [
            invoicePayment,
            {
              ...invoicePayment,
              id: 'inpay_other',
              payment: { type: 'payment_intent', payment_intent: 'pi_other' },
            },
          ],
          '/v1/invoice_payments',
        ),
      },
    ])
    await expect(mock.verify('invoice.paid', invoice)).rejects.toThrow('one identifiable payment')
    mock.complete()
  })
  it('retrieves a missing dispute PaymentIntent association only after successful signature verification', async () => {
    const mock = mockProvider([{ path: '/v1/charges/ch_test', body: charge }])
    expect(
      (
        await mock.verify('charge.dispute.created', {
          id: 'dp_test',
          object: 'dispute',
          payment_intent: null,
          charge: 'ch_test',
          amount: 2000,
          currency: 'usd',
        })
      ).events[0],
    ).toMatchObject({
      type: 'payment.disputed',
      providerPaymentId: 'pi_test',
      providerDisputeId: 'dp_test',
    })
    mock.complete()
  })
})
