import type { PlanPrice } from '@product-res/db/schema'
import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import type { CheckoutInput, PlanSyncInput, RefundInput } from '../provider.ts'
import { createStripeClient, STRIPE_API_VERSION } from './client.ts'
import { parseStripeMetadata } from './metadata.ts'
import { createStripeOperations } from './operations.ts'

const workspaceId = '019a0000-0000-7000-8000-000000000001'
const userId = '019a0000-0000-7000-8000-000000000002'
const planId = '019a0000-0000-7000-8000-000000000003'
const planPriceId = '019a0000-0000-7000-8000-000000000004'
const nextPriceId = '019a0000-0000-7000-8000-000000000005'
const metadata = { workspaceId, userId, planPriceId }
const price: PlanPrice = {
  id: planPriceId,
  planId,
  provider: 'stripe',
  providerPriceId: 'price_current',
  interval: 'month',
  amount: 2000,
  currency: 'usd',
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}
const checkout: CheckoutInput = {
  workspaceId,
  userId,
  price,
  mode: 'subscription',
  customerEmail: 'buyer@example.com',
  successUrl: 'https://app.example/success',
  cancelUrl: 'https://app.example/cancel',
  idempotencyKey: 'checkout-request-1',
}
const targetPrice = { ...price, id: nextPriceId, providerPriceId: 'price_next' }
const subscription = {
  id: 'sub_test',
  object: 'subscription',
  schedule: null,
  metadata,
  cancel_at_period_end: false,
  pending_update: null,
  trial_end: null,
  discounts: ['di_test'],
  default_tax_rates: [{ id: 'txr_test' }],
  items: {
    has_more: false,
    data: [
      {
        id: 'si_test',
        price: { id: 'price_current' },
        quantity: 2,
        current_period_start: 1800000000,
        current_period_end: 1802592000,
      },
    ],
  },
}
const schedule = {
  id: 'sub_sched_test',
  object: 'subscription_schedule',
  metadata: {},
  current_phase: { start_date: 1800000000, end_date: 1802592000 },
  phases: [
    {
      start_date: 1800000000,
      end_date: 1802592000,
      add_invoice_items: [],
      application_fee_percent: null,
      automatic_tax: { enabled: false, liability: null },
      billing_cycle_anchor: null,
      billing_thresholds: null,
      collection_method: 'charge_automatically',
      currency: 'usd',
      default_payment_method: { id: 'pm_test' },
      default_tax_rates: [{ id: 'txr_test' }],
      description: 'Billing terms',
      discounts: [{ discount: 'di_test', coupon: null, promotion_code: null }],
      invoice_settings: {
        account_tax_ids: null,
        custom_fields: null,
        days_until_due: null,
        description: null,
        footer: 'Invoice footer',
        issuer: { type: 'self' },
      },
      on_behalf_of: null,
      transfer_data: null,
      trial_end: null,
      items: [
        {
          price: 'price_current',
          quantity: 2,
          metadata: {},
          billing_thresholds: null,
          discounts: [{ discount: 'di_item', coupon: null, promotion_code: null }],
          tax_rates: [{ id: 'txr_item' }],
        },
      ],
    },
  ],
}

interface MockReply {
  method: string
  path: string
  body: unknown
  status?: number
}

/** The SDK serializes real HTTP requests; every unexpected request fails offline. */
function mockStripe(replies: MockReply[]) {
  const requests: { method: string; path: string; headers: Headers; body: URLSearchParams }[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const reply = replies[requests.length]
    requests.push({
      method,
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: new URLSearchParams(String(init?.body ?? '')),
    })
    if (!reply || reply.path !== url.pathname || reply.method !== method) {
      throw new Error(`Unexpected offline request: ${method} ${url.pathname}`)
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    operations: createStripeOperations(createStripeClient('sk_test_offline_only', fetchFn)),
    requests,
    complete: () => expect(requests).toHaveLength(replies.length),
  }
}

describe('Stripe checkout and transport', () => {
  it.each(['subscription', 'one_time'] as const)(
    'sets trusted metadata on %s objects and stable request keys',
    async (mode) => {
      const mock = mockStripe([
        {
          method: 'POST',
          path: '/v1/checkout/sessions',
          body: { id: 'cs_test', url: 'https://checkout.stripe.com/offline' },
        },
      ])
      const input = {
        ...checkout,
        mode,
        price: { ...price, interval: mode === 'one_time' ? null : price.interval },
      }
      expect(await mock.operations.createCheckout(input)).toEqual({
        providerRef: 'cs_test',
        url: 'https://checkout.stripe.com/offline',
      })
      const request = mock.requests[0]
      expect(request?.headers.get('stripe-version')).toBe(STRIPE_API_VERSION)
      expect(request?.headers.get('idempotency-key')).toBe(input.idempotencyKey)
      expect(request?.body.get('mode')).toBe(mode === 'one_time' ? 'payment' : mode)
      expect(request?.body.get('managed_payments[enabled]')).toBe('false')
      const dataKey = mode === 'subscription' ? 'subscription_data' : 'payment_intent_data'
      for (const [key, value] of Object.entries(metadata)) {
        expect(request?.body.get(`metadata[${key}]`)).toBe(value)
        expect(request?.body.get(`${dataKey}[metadata][${key}]`)).toBe(value)
      }
      expect(request?.body.get('line_items[0][price]')).toBe(price.providerPriceId)
      expect(request?.body.get('success_url')).toBe(input.successUrl)
      expect(request?.body.get('cancel_url')).toBe(input.cancelUrl)
      expect(request?.body.get('customer_email')).toBe(input.customerEmail)
      expect(request?.body.get('customer_creation')).toBe(mode === 'one_time' ? 'always' : null)
      mock.complete()
    },
  )

  it('uses an existing customer without conflicting email or customer creation fields', async () => {
    const mock = mockStripe([
      {
        method: 'POST',
        path: '/v1/checkout/sessions',
        body: { id: 'cs_test', url: 'https://product.ezarouter.cc' },
      },
    ])
    await mock.operations.createCheckout({ ...checkout, providerCustomerId: 'cus_test' })
    expect(mock.requests[0]?.body.get('customer')).toBe('cus_test')
    expect(mock.requests[0]?.body.has('customer_email')).toBe(false)
    expect(mock.requests[0]?.body.has('customer_creation')).toBe(false)
  })

  it('rejects invalid source UUIDs and mode mismatches before making requests', async () => {
    const mock = mockStripe([])
    await expect(
      mock.operations.createCheckout({ ...checkout, userId: 'client-value' }),
    ).rejects.toThrow('UUIDs')
    await expect(mock.operations.createCheckout({ ...checkout, mode: 'one_time' })).rejects.toThrow(
      'interval',
    )
    expect(parseStripeMetadata({ ...metadata, workspaceId: 'not-uuid' })).toBeNull()
    expect(parseStripeMetadata(metadata)).toEqual(metadata)
    mock.complete()
  })
})

describe('Stripe subscription management', () => {
  it('upgrades the existing item with immediate proration and preserves quantity', async () => {
    const mock = mockStripe([
      {
        method: 'GET',
        path: '/v1/subscriptions/sub_test',
        body: { ...subscription, schedule: 'sub_sched_test' },
      },
      { method: 'POST', path: '/v1/subscription_schedules/sub_sched_test/release', body: schedule },
      { method: 'POST', path: '/v1/subscriptions/sub_test', body: subscription },
    ])
    await mock.operations.changePlan('sub_test', targetPrice, { atPeriodEnd: false })
    const body = mock.requests[2]?.body
    expect(body?.get('items[0][id]')).toBe('si_test')
    expect(body?.get('items[0][price]')).toBe('price_next')
    expect(body?.get('items[0][quantity]')).toBe('2')
    expect(body?.get('proration_behavior')).toBe('always_invoice')
    expect(body?.get('payment_behavior')).toBe('error_if_incomplete')
    expect(body?.get('metadata[planPriceId]')).toBe(nextPriceId)
    mock.complete()
  })

  it('defers downgrade to the item period end and releases after one new interval', async () => {
    const mock = mockStripe([
      { method: 'GET', path: '/v1/subscriptions/sub_test', body: subscription },
      { method: 'POST', path: '/v1/subscription_schedules', body: schedule },
      { method: 'POST', path: '/v1/subscription_schedules/sub_sched_test', body: schedule },
    ])
    await mock.operations.changePlan(
      'sub_test',
      { ...targetPrice, interval: 'year' },
      { atPeriodEnd: true },
    )
    expect(mock.requests[1]?.body.toString()).toBe('from_subscription=sub_test')
    expect(mock.requests[1]?.headers.get('idempotency-key')).toBeTruthy()
    const body = mock.requests[2]?.body
    expect(body?.get('phases[0][start_date]')).toBe('1800000000')
    expect(body?.get('phases[0][end_date]')).toBe('1802592000')
    expect(body?.get('phases[0][items][0][price]')).toBe('price_current')
    expect(body?.get('phases[1][start_date]')).toBe('1802592000')
    expect(body?.get('phases[1][items][0][price]')).toBe('price_next')
    expect(body?.get('phases[1][duration][interval]')).toBe('year')
    expect(body?.get('phases[1][metadata][planPriceId]')).toBe(nextPriceId)
    expect(body?.get('phases[0][discounts][0][discount]')).toBe('di_test')
    expect(body?.get('phases[1][default_tax_rates][0]')).toBe('txr_test')
    expect(body?.get('phases[0][default_payment_method]')).toBe('pm_test')
    expect(body?.get('phases[0][invoice_settings][footer]')).toBe('Invoice footer')
    expect(body?.get('phases[1][items][0][discounts][0][discount]')).toBe('di_item')
    expect(body?.get('phases[1][items][0][tax_rates][0]')).toBe('txr_item')
    expect(body?.get('proration_behavior')).toBe('none')
    expect(body?.get('phases[1][proration_behavior]')).toBe('none')
    expect(body?.get('end_behavior')).toBe('release')
    mock.complete()
  })

  it('reuses an adapter managed schedule for a subsequent downgrade', async () => {
    const mock = mockStripe([
      {
        method: 'GET',
        path: '/v1/subscriptions/sub_test',
        body: { ...subscription, schedule: 'sub_sched_test' },
      },
      {
        method: 'GET',
        path: '/v1/subscription_schedules/sub_sched_test',
        body: {
          ...schedule,
          metadata: { saasManaged: 'plan_change' },
          phases: [...schedule.phases, { start_date: 1802592000 }],
        },
      },
      { method: 'POST', path: '/v1/subscription_schedules/sub_sched_test', body: schedule },
    ])
    await mock.operations.changePlan('sub_test', targetPrice, { atPeriodEnd: true })
    mock.complete()
  })

  it('uses a fresh schedule request key after an earlier schedule was released', async () => {
    const replies = [
      { method: 'GET', path: '/v1/subscriptions/sub_test', body: subscription },
      { method: 'POST', path: '/v1/subscription_schedules', body: schedule },
      { method: 'POST', path: '/v1/subscription_schedules/sub_sched_test', body: schedule },
    ]
    const mock = mockStripe([...replies, ...replies])
    await mock.operations.changePlan('sub_test', targetPrice, { atPeriodEnd: true })
    // Both retrieves represent an unscheduled subscription after cancel/resume.
    await mock.operations.changePlan('sub_test', targetPrice, { atPeriodEnd: true })
    expect(mock.requests[1]?.headers.get('idempotency-key')).not.toBe(
      mock.requests[4]?.headers.get('idempotency-key'),
    )
    mock.complete()
  })

  it.each([true, false])(
    'cancels atPeriodEnd=%s after releasing a pending schedule',
    async (atPeriodEnd) => {
      const mock = mockStripe([
        {
          method: 'GET',
          path: '/v1/subscriptions/sub_test',
          body: { ...subscription, schedule: 'sub_sched_test' },
        },
        {
          method: 'POST',
          path: '/v1/subscription_schedules/sub_sched_test/release',
          body: schedule,
        },
        {
          method: atPeriodEnd ? 'POST' : 'DELETE',
          path: '/v1/subscriptions/sub_test',
          body: subscription,
        },
      ])
      await mock.operations.cancelSubscription('sub_test', { atPeriodEnd })
      if (atPeriodEnd) expect(mock.requests[2]?.body.get('cancel_at_period_end')).toBe('true')
      mock.complete()
    },
  )

  it('resumes renewal and opens the portal with the supplied return URL', async () => {
    const mock = mockStripe([
      { method: 'POST', path: '/v1/subscriptions/sub_test', body: subscription },
      {
        method: 'POST',
        path: '/v1/billing_portal/sessions',
        body: { url: 'https://billing.stripe.com/offline' },
      },
    ])
    await mock.operations.resumeSubscription('sub_test')
    expect(mock.requests[0]?.body.get('cancel_at_period_end')).toBe('false')
    expect(await mock.operations.getPortalUrl('cus_test', 'https://app.example/billing')).toBe(
      'https://billing.stripe.com/offline',
    )
    expect(mock.requests[1]?.body.get('customer')).toBe('cus_test')
    expect(mock.requests[1]?.body.get('return_url')).toBe('https://app.example/billing')
  })

  it('rejects multi-item subscriptions before a destructive plan update', async () => {
    const mock = mockStripe([
      {
        method: 'GET',
        path: '/v1/subscriptions/sub_test',
        body: {
          ...subscription,
          items: { ...subscription.items, has_more: true },
        },
      },
    ])
    await expect(
      mock.operations.changePlan('sub_test', targetPrice, { atPeriodEnd: false }),
    ).rejects.toThrow('single subscription item')
    mock.complete()
  })
})

describe('Stripe refunds and immutable plan prices', () => {
  it('rejects an empty refund request key before any money operation', async () => {
    const mock = mockStripe([])
    await expect(
      mock.operations.refund({
        providerPaymentId: 'pi_test',
        kind: 'one_time',
        currency: 'usd',
        idempotencyKey: '',
        amount: 1200,
      }),
    ).rejects.toThrow('idempotency key')
    mock.complete()
  })
  it.each([undefined, 1200])('reuses the refund request key with amount=%s', async (amount) => {
    const mock = mockStripe(
      Array.from({ length: 2 }, () => ({
        method: 'POST',
        path: '/v1/refunds',
        body: { id: 're_test' },
      })),
    )
    const input: RefundInput = {
      providerPaymentId: 'pi_test',
      kind: 'one_time',
      currency: 'usd',
      idempotencyKey: 'refund-request-1',
      ...(amount === undefined ? {} : { amount }),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await mock.operations.refund(input)).toEqual({ providerRefundId: 're_test' })
      expect(mock.requests[attempt]?.headers.get('idempotency-key')).toBe(input.idempotencyKey)
      expect(mock.requests[attempt]?.body.get('payment_intent')).toBe('pi_test')
      expect(mock.requests[attempt]?.body.get('amount')).toBe(
        amount === undefined ? null : String(amount),
      )
    }
    mock.complete()
  })

  const sync: PlanSyncInput = {
    plan: { id: planId, key: 'pro', name: 'Pro', type: 'subscription', active: true },
    price,
    idempotencyKey: 'price-sync-1',
  }
  const remotePrice = {
    id: 'price_current',
    unit_amount: 2000,
    currency: 'usd',
    recurring: { interval: 'month', interval_count: 1 },
    metadata: { planId, planPriceId },
  }

  it('reuses a matching immutable mapping with no remote mutations', async () => {
    const mock = mockStripe([
      { method: 'GET', path: '/v1/prices/price_current', body: remotePrice },
    ])
    expect(await mock.operations.syncPlan({ ...sync, providerPriceId: 'price_current' })).toEqual({
      providerPriceId: 'price_current',
    })
    mock.complete()
  })

  it('rejects mapping drift instead of changing the existing price', async () => {
    const mock = mockStripe([
      {
        method: 'GET',
        path: '/v1/prices/price_current',
        body: { ...remotePrice, unit_amount: 999 },
      },
    ])
    await expect(
      mock.operations.syncPlan({ ...sync, providerPriceId: 'price_current' }),
    ).rejects.toThrow('Immutable')
    mock.complete()
  })

  it('creates a product only when absent and creates a price under a stable sync key', async () => {
    const productId = `product_res_plan_${planId.replaceAll('-', '')}`
    const mock = mockStripe([
      {
        method: 'GET',
        path: `/v1/products/${productId}`,
        status: 404,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'Missing product',
          },
        },
      },
      { method: 'POST', path: '/v1/products', body: { id: productId } },
      { method: 'POST', path: '/v1/prices', body: { id: 'price_new' } },
    ])
    expect(await mock.operations.syncPlan(sync)).toEqual({ providerPriceId: 'price_new' })
    expect(mock.requests[1]?.headers.get('idempotency-key')).toBe(`saas:product:${planId}`)
    expect(mock.requests[2]?.headers.get('idempotency-key')).toBe(sync.idempotencyKey)
    expect(mock.requests[2]?.body.get('product')).toBe(productId)
    expect(mock.requests[2]?.body.get('unit_amount')).toBe('2000')
    expect(mock.requests[2]?.body.get('recurring[interval]')).toBe('month')
    expect(mock.requests[2]?.body.get('metadata[planPriceId]')).toBe(planPriceId)
    mock.complete()
  })

  it('reuses the product when adding a one-time credit pack price', async () => {
    const productId = `product_res_plan_${planId.replaceAll('-', '')}`
    const mock = mockStripe([
      { method: 'GET', path: `/v1/products/${productId}`, body: { id: productId } },
      { method: 'POST', path: '/v1/prices', body: { id: 'price_pack' } },
    ])
    await mock.operations.syncPlan({
      ...sync,
      plan: { ...sync.plan, type: 'credit_pack' },
      price: { ...sync.price, interval: null },
    })
    expect(mock.requests[1]?.body.get('product')).toBe(productId)
    expect(mock.requests[1]?.body.has('recurring[interval]')).toBe(false)
    mock.complete()
  })

  it('propagates Stripe errors without masking them as product absence', async () => {
    const mock = mockStripe([
      {
        method: 'GET',
        path: `/v1/products/product_res_plan_${planId.replaceAll('-', '')}`,
        status: 401,
        body: { error: { type: 'authentication_error', message: 'Invalid offline test key' } },
      },
    ])
    await expect(mock.operations.syncPlan(sync)).rejects.toBeInstanceOf(
      Stripe.errors.StripeAuthenticationError,
    )
    mock.complete()
  })
})
