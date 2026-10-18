import type { PlanPrice } from '@product-res/db/schema'
import { describe, expect, it } from 'vitest'
import type { CheckoutInput, PlanSyncInput } from '../provider.ts'
import { decodePayPalMetadata, encodePayPalMetadata } from './metadata.ts'
import { fromPayPalDecimal, toPayPalDecimal } from './money.ts'
import { createPayPalOperations } from './operations.ts'
import { createPayPalTransport, PayPalHttpError, type PayPalTokenCache } from './transport.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const priceId = '33333333-3333-4333-8333-333333333333'
const planId = '44444444-4444-4444-8444-444444444444'
const metadata = { workspaceId, userId, planPriceId: priceId }
const price: PlanPrice = {
  id: priceId,
  planId,
  provider: 'paypal',
  providerPriceId: 'P-TEST',
  interval: 'month',
  amount: 1234,
  currency: 'usd',
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}
const checkout: CheckoutInput = {
  workspaceId,
  userId,
  price,
  mode: 'subscription',
  customerEmail: 'buyer@example.test',
  successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel',
  idempotencyKey: 'checkout-1',
}
const sync: PlanSyncInput = {
  plan: { id: planId, key: 'pro', name: 'Pro', type: 'subscription', active: true },
  price,
  idempotencyKey: 'sync-attempt-1',
}

type Step = {
  path: string
  method?: string
  status?: number
  response?: unknown
  inspect?: (body: Record<string, unknown>, headers: Headers) => void
}
function harness(
  steps: Step[],
  options: { environment?: 'sandbox' | 'live'; clientId?: string; cache?: PayPalTokenCache } = {},
) {
  let time = 0
  const values = new Map<string, string>()
  const writes: { key: string; ttl: number }[] = []
  const cache = options.cache ?? {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string, opts: { expirationTtl: number }) => {
      values.set(key, value)
      writes.push({ key, ttl: opts.expirationTtl })
    },
  }
  const calls: { url: string; headers: Headers }[] = []
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input)
    const step = steps.shift()
    if (!step) throw new Error(`Unexpected HTTP request: ${url}`)
    expect(new URL(url).pathname).toBe(step.path)
    expect(init?.method).toBe(step.method ?? 'POST')
    const headers = new Headers(init?.headers)
    calls.push({ url, headers })
    if (step.path === '/v1/oauth2/token') {
      expect(init?.body).toBe('grant_type=client_credentials')
      expect(headers.get('Authorization')).toBe(
        `Basic ${btoa(`${options.clientId ?? 'client'}:secret`)}`,
      )
    } else {
      expect(headers.get('Authorization')).toBe('Bearer test-token')
      step.inspect?.(init?.body ? JSON.parse(String(init.body)) : {}, headers)
    }
    const status = step.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(step.response ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const transport = createPayPalTransport({
    environment: options.environment ?? 'sandbox',
    clientId: options.clientId ?? 'client',
    clientSecret: 'secret',
    fetch: fetchMock,
    cache,
    now: () => time,
  })
  return {
    transport,
    operations: createPayPalOperations(transport),
    calls,
    values,
    writes,
    time: (value: number) => {
      time = value
    },
    done: () => expect(steps).toHaveLength(0),
  }
}
const token = (): Step => ({
  path: '/v1/oauth2/token',
  response: { access_token: 'test-token', expires_in: 3600 },
})
const approval = {
  id: 'I-TEST',
  links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }],
}
const remotePlan = () => ({
  id: 'P-TEST',
  product_id: 'PROD-TEST',
  status: 'ACTIVE',
  description: `saas:v1:${planId}:${priceId}`,
  billing_cycles: [
    {
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: 'USD', value: '12.34' } },
    },
  ],
})

describe('PayPal transport', () => {
  it('creates checkout with a native fetch receiver for both OAuth and the API request', async () => {
    const paths: string[] = []
    const fetchMock: typeof fetch = async function (this: unknown, input) {
      // 模拟 Workers 原生 fetch：不能把 transport options 当作接收者。
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      const path = new URL(String(input)).pathname
      paths.push(path)
      return Response.json(
        path === '/v1/oauth2/token' ? { access_token: 'test-token', expires_in: 3600 } : approval,
      )
    }
    const transport = createPayPalTransport({
      environment: 'sandbox',
      clientId: 'client',
      clientSecret: 'secret',
      fetch: fetchMock,
      cache: { get: async () => null, put: async () => {} },
    })

    const result = await createPayPalOperations(transport).createCheckout(checkout)

    expect(result.providerRef).toBe('I-TEST')
    expect(paths).toEqual(['/v1/oauth2/token', '/v1/billing/subscriptions'])
  })

  it('defers missing credentials until a call', async () => {
    let called = false
    const transport = createPayPalTransport({
      environment: 'sandbox',
      fetch: async () => {
        called = true
        throw new Error('Unexpected HTTP')
      },
      cache: { get: async () => null, put: async () => {} },
    })
    await expect(transport.request('GET', '/v1/billing/plans/P-TEST')).rejects.toThrow(
      'not configured',
    )
    expect(called).toBe(false)
  })

  it('shares concurrent OAuth acquisition, caches with expiry margin, refreshes even if KV has stale value', async () => {
    const h = harness([
      token(),
      { path: '/v1/billing/plans/P-TEST', method: 'GET' },
      { path: '/v1/billing/plans/P-TEST', method: 'GET' },
      { path: '/v1/billing/plans/P-TEST', method: 'GET' },
      token(),
      { path: '/v1/billing/plans/P-TEST', method: 'GET' },
    ])
    await Promise.all([
      h.transport.request('GET', '/v1/billing/plans/P-TEST'),
      h.transport.request('GET', '/v1/billing/plans/P-TEST'),
    ])
    expect(h.writes[0]).toEqual({ key: 'paypal:oauth:v1:sandbox:client', ttl: 3540 })
    h.time(3539999)
    await h.transport.request('GET', '/v1/billing/plans/P-TEST')
    h.time(3540000)
    await h.transport.request('GET', '/v1/billing/plans/P-TEST')
    h.done()
  })

  it('isolates cache by environment and client and uses the live host only when selected', async () => {
    const values = new Map<string, string>()
    const cache: PayPalTokenCache = {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => {
        values.set(key, value)
      },
    }
    for (const [environment, clientId] of [
      ['sandbox', 'a'],
      ['sandbox', 'b'],
      ['live', 'a'],
    ] as const) {
      const h = harness([token(), { path: '/v1/billing/plans/P-TEST', method: 'GET' }], {
        environment,
        clientId,
        cache,
      })
      await h.transport.request('GET', '/v1/billing/plans/P-TEST')
      expect(new URL(h.calls[0]?.url ?? '').host).toBe(
        environment === 'live' ? 'api-m.paypal.com' : 'api-m.sandbox.paypal.com',
      )
      h.done()
    }
    expect(values.size).toBe(3)
  })

  it('exposes safe HTTP status without reflecting OAuth secrets or remote bodies', async () => {
    const h = harness([
      { path: '/v1/oauth2/token', status: 401, response: { client_secret: 'secret' } },
    ])
    h.values.set('paypal:oauth:v1:sandbox:client', 'malformed cached secret')
    await expect(h.transport.request('GET', '/v1/billing/plans/P-TEST')).rejects.toEqual(
      new PayPalHttpError(401),
    )
    h.done()
  })
})

describe('PayPal checkout and management', () => {
  it('sends versioned three-UUID metadata within custom_id limits for subscription and Orders checkout', async () => {
    const h = harness([
      token(),
      {
        path: '/v1/billing/subscriptions',
        response: approval,
        inspect: (body) => {
          expect(body.plan_id).toBe('P-TEST')
          expect(decodePayPalMetadata(body.custom_id)).toEqual(metadata)
          expect(String(body.custom_id).length).toBeLessThanOrEqual(127)
        },
      },
      {
        path: '/v2/checkout/orders',
        response: {
          ...approval,
          id: 'ORDER-TEST',
          links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/approve' }],
        },
        inspect: (body) => {
          expect(body.intent).toBe('CAPTURE')
          expect(body.purchase_units).toEqual([
            {
              custom_id: encodePayPalMetadata(metadata),
              amount: { currency_code: 'USD', value: '12.34' },
            },
          ])
          expect(body.payment_source).toEqual({
            paypal: {
              experience_context: {
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: checkout.successUrl,
                cancel_url: checkout.cancelUrl,
              },
            },
          })
        },
      },
    ])
    expect((await h.operations.createCheckout(checkout)).providerRef).toBe('I-TEST')
    expect(
      (
        await h.operations.createCheckout({
          ...checkout,
          mode: 'one_time',
          price: { ...price, interval: null, providerPriceId: `paypal:credit_pack:${priceId}` },
        })
      ).providerRef,
    ).toBe('ORDER-TEST')
    h.done()
  })

  it('rejects malformed, unversioned and oversized metadata and untrusted UUID inputs', () => {
    expect(decodePayPalMetadata(encodePayPalMetadata(metadata))).toEqual(metadata)
    for (const bad of [
      null,
      '{}',
      '[2,1,2,3]',
      JSON.stringify([1, workspaceId, priceId, 'bad']),
      JSON.stringify([1, workspaceId, priceId, userId, 'extra']),
      ' '.repeat(128),
    ])
      expect(decodePayPalMetadata(bad)).toBeNull()
    expect(() => encodePayPalMetadata({ ...metadata, userId: 'bad' })).toThrow('UUIDs')
  })

  it('captures only through Orders HTTP and reuses stable operation-scoped request IDs', async () => {
    const requestIds: string[] = []
    const h = harness([
      token(),
      ...[1, 2].map(() => ({
        path: '/v2/checkout/orders/ORDER-TEST/capture',
        response: { status: 'COMPLETED' },
        inspect: (body: Record<string, unknown>, headers: Headers) => {
          expect(body).toEqual({})
          requestIds.push(headers.get('PayPal-Request-Id') ?? '')
        },
      })),
    ])
    await h.operations.confirmCheckout('ORDER-TEST', { idempotencyKey: 'capture-stable' })
    await h.operations.confirmCheckout('ORDER-TEST', { idempotencyKey: 'capture-stable' })
    await expect(h.operations.confirmCheckout('I-TEST', { idempotencyKey: 'bad' })).rejects.toThrow(
      'does not use Orders capture',
    )
    expect(requestIds[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(requestIds[1]).toBe(requestIds[0])
    h.done()
  })

  it('suspends logical period-end cancellation, activates resume, and cancels immediately using reason only', async () => {
    const h = harness([
      token(),
      ...['suspend', 'activate', 'cancel'].map((action) => ({
        path: `/v1/billing/subscriptions/I-TEST/${action}`,
        status: 204,
        inspect: (body: Record<string, unknown>) => {
          expect(Object.keys(body)).toEqual(['reason'])
          expect(body.reason).toBeTypeOf('string')
        },
      })),
    ])
    await h.operations.cancelSubscription('I-TEST', { atPeriodEnd: true })
    await h.operations.resumeSubscription('I-TEST')
    await h.operations.cancelSubscription('I-TEST', { atPeriodEnd: false })
    h.done()
  })

  it('refunds Capture v2 and subscription Sale v1 with exact minor units and stable IDs', async () => {
    const ids: string[] = []
    const h = harness([
      token(),
      ...[1, 2].map(() => ({
        path: '/v2/payments/captures/CAPTURE-TEST/refund',
        response: { id: 'REFUND-TEST' },
        inspect: (body: Record<string, unknown>, headers: Headers) => {
          expect(body).toEqual({ amount: { value: '0.29', currency_code: 'USD' } })
          ids.push(headers.get('PayPal-Request-Id') ?? '')
        },
      })),
      {
        path: '/v1/payments/sale/SALE-TEST/refund',
        response: { id: 'REFUND-SALE' },
        inspect: (body) => expect(body).toEqual({ amount: { total: '0.29', currency: 'USD' } }),
      },
      {
        path: '/v1/payments/sale/SALE-TEST/refund',
        response: { id: 'REFUND-FULL' },
        inspect: (body) => expect(body).toEqual({}),
      },
    ])
    for (let i = 0; i < 2; i++)
      expect(
        await h.operations.refund({
          providerPaymentId: 'CAPTURE-TEST',
          kind: 'one_time',
          amount: 29,
          currency: 'usd',
          idempotencyKey: 'refund-stable',
        }),
      ).toEqual({ providerRefundId: 'REFUND-TEST' })
    expect(ids[0]).toBe(ids[1])
    await h.operations.refund({
      providerPaymentId: 'SALE-TEST',
      kind: 'initial',
      amount: 29,
      currency: 'USD',
      idempotencyKey: 'refund-sale',
    })
    await h.operations.refund({
      providerPaymentId: 'SALE-TEST',
      kind: 'renewal',
      currency: 'USD',
      idempotencyKey: 'refund-full',
    })
    for (const amount of [0, -1, 1.5, Number.NaN])
      await expect(
        h.operations.refund({
          providerPaymentId: 'SALE-TEST',
          kind: 'renewal',
          amount,
          currency: 'USD',
          idempotencyKey: 'bad',
        }),
      ).rejects.toThrow()
    await expect(
      h.operations.refund({
        providerPaymentId: 'SALE-TEST',
        kind: 'renewal',
        currency: 'JPY',
        idempotencyKey: 'bad',
      }),
    ).rejects.toThrow('USD only')
    h.done()
  })
})

describe('PayPal price sync and money', () => {
  it('creates Product and recurring Plan using the supplied sync attempt key', async () => {
    const ids: string[] = []
    const h = harness([
      token(),
      {
        path: '/v1/catalogs/products',
        response: { id: 'PROD-TEST' },
        inspect: (body, headers) => {
          expect(body).toEqual({ name: 'Pro', type: 'SERVICE', description: `saas:v1:${planId}` })
          ids.push(headers.get('PayPal-Request-Id') ?? '')
        },
      },
      {
        path: '/v1/billing/plans',
        response: { id: 'P-TEST' },
        inspect: (body, headers) => {
          expect(body.product_id).toBe('PROD-TEST')
          expect(body.status).toBe('ACTIVE')
          expect(body.billing_cycles).toEqual(remotePlan().billing_cycles)
          ids.push(headers.get('PayPal-Request-Id') ?? '')
        },
      },
    ])
    expect(await h.operations.syncPlan(sync)).toEqual({ providerPriceId: 'P-TEST' })
    expect(ids[0]).not.toBe(ids[1])
    h.done()
  })

  it('reuses recorded providerPriceId after creation-key expiry and rejects remote price drift', async () => {
    const h = harness([
      token(),
      { path: '/v1/billing/plans/P-TEST', method: 'GET', response: remotePlan() },
      {
        path: '/v1/catalogs/products/PROD-TEST',
        method: 'GET',
        response: { id: 'PROD-TEST', description: `saas:v1:${planId}` },
      },
      {
        path: '/v1/billing/plans/P-TEST',
        method: 'GET',
        response: {
          ...remotePlan(),
          billing_cycles: [
            {
              ...remotePlan().billing_cycles[0],
              pricing_scheme: { fixed_price: { currency_code: 'USD', value: '12.35' } },
            },
          ],
        },
      },
    ])
    h.time(4 * 86400000)
    expect(await h.operations.syncPlan({ ...sync, providerPriceId: 'P-TEST' })).toEqual({
      providerPriceId: 'P-TEST',
    })
    await expect(h.operations.syncPlan({ ...sync, providerPriceId: 'P-TEST' })).rejects.toThrow(
      'drift',
    )
    h.done()
  })

  it('maps credit packs locally with no platform calls and detects mapping drift', async () => {
    const h = harness([])
    const input: PlanSyncInput = {
      ...sync,
      plan: { ...sync.plan, type: 'credit_pack' },
      price: { ...sync.price, interval: null },
    }
    expect(await h.operations.syncPlan(input)).toEqual({
      providerPriceId: `paypal:credit_pack:${priceId}`,
    })
    await expect(h.operations.syncPlan({ ...input, providerPriceId: 'wrong' })).rejects.toThrow(
      'drift',
    )
    h.done()
  })

  it('deactivates an existing mapped plan without creating another remote price', async () => {
    const h = harness([
      token(),
      { path: '/v1/billing/plans/P-TEST', method: 'GET', response: remotePlan() },
      {
        path: '/v1/catalogs/products/PROD-TEST',
        method: 'GET',
        response: { id: 'PROD-TEST', description: `saas:v1:${planId}` },
      },
      { path: '/v1/billing/plans/P-TEST/deactivate', status: 204 },
    ])
    expect(
      await h.operations.syncPlan({
        ...sync,
        providerPriceId: 'P-TEST',
        price: { ...price, active: false },
      }),
    ).toEqual({ providerPriceId: 'P-TEST' })
    h.done()
  })

  it('converts exact USD cents without rounding and rejects other currencies or fractional minor units', () => {
    expect(toPayPalDecimal(29, 'usd')).toBe('0.29')
    expect(fromPayPalDecimal('12.3', 'USD')).toBe(1230)
    expect(fromPayPalDecimal(toPayPalDecimal(Number.MAX_SAFE_INTEGER, 'USD'), 'USD')).toBe(
      Number.MAX_SAFE_INTEGER,
    )
    for (const invalid of ['0.001', '-1', '1e2', '1.'])
      expect(() => fromPayPalDecimal(invalid, 'USD')).toThrow()
    expect(() => toPayPalDecimal(1.5, 'USD')).toThrow()
    expect(() => toPayPalDecimal(100, 'EUR')).toThrow('USD only')
  })
})
