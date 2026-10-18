import type { JsonValue } from '@product-res/db/schema'
import { describe, expect, it } from 'vitest'
import {
  createPayPalProvider,
  createPayPalWebhookNormalizer,
  type PayPalProviderOptions,
} from './index.ts'
import { encodePayPalMetadata } from './metadata.ts'
import type { PayPalRecordedSale } from './snapshots.ts'

const jan = '2026-01-01T00:00:00.000Z'
const feb = '2026-02-01T00:00:00.000Z'
const money = { value: '12.34', currency_code: 'USD' }
const meta = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  planPriceId: '33333333-3333-4333-8333-333333333333',
}
const sub = {
  id: 'I-SUB',
  plan_id: 'P-PLAN',
  status: 'ACTIVE',
  start_time: jan,
  custom_id: encodePayPalMetadata(meta),
  billing_info: {},
}
const capture = {
  id: 'CAPTURE',
  status: 'COMPLETED',
  amount: money,
  create_time: jan,
  supplementary_data: { related_ids: { order_id: 'ORDER' } },
}
const order = {
  id: 'ORDER',
  status: 'COMPLETED',
  purchase_units: [
    { amount: money, custom_id: encodePayPalMetadata(meta), payments: { captures: [capture] } },
  ],
}
const sale = {
  id: 'SALE',
  state: 'completed',
  amount: { total: '12.34', currency: 'USD' },
  create_time: jan,
  billing_agreement_id: 'I-SUB',
}
const plan = {
  id: 'P-PLAN',
  billing_cycles: [
    {
      tenure_type: 'REGULAR',
      total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: money, version: 1 },
    },
  ],
}
const event = (type: string, resource: JsonValue) => ({
  id: 'WH-EVENT',
  event_type: type,
  create_time: feb,
  resource,
})
const headers = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT',
  'paypal-transmission-id': 'TRANSMISSION',
  'paypal-transmission-sig': 'SIGNATURE',
  'paypal-transmission-time': feb,
}
const request = (values = headers) =>
  new Request('https://local.example/webhook', {
    method: 'POST',
    headers: values,
    body: 'DO NOT READ THIS BODY',
  })
type Step = [string, string, unknown]
function harness(steps: Step[], records: PayPalRecordedSale[] = []) {
  const bodies: unknown[] = []
  const options: PayPalProviderOptions = {
    environment: 'sandbox',
    clientId: 'fixture',
    clientSecret: 'fixture',
    webhookId: 'WEBHOOK',
    lookupRecordedSale: async (id) =>
      records.find((record) => record.providerPaymentId === id) ?? null,
    cache: {
      get: async () => JSON.stringify({ accessToken: 'offline', expiresAt: 9999999999999 }),
      put: async () => {},
    },
    fetch: async (url, init) => {
      const next = steps.shift()
      if (!next) throw new Error(`Unexpected request ${String(url)}`)
      expect(String(url)).toBe(`https://api-m.sandbox.paypal.com${next[1]}`)
      expect(init?.method).toBe(next[0])
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(next[2]), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  }
  return {
    provider: createPayPalProvider(options),
    normalize: createPayPalWebhookNormalizer(options),
    bodies,
    done: () => expect(steps).toHaveLength(0),
    options,
  }
}
const verify: Step = [
  'POST',
  '/v1/notifications/verify-webhook-signature',
  { verification_status: 'SUCCESS' },
]
const subStep: Step = ['GET', '/v1/billing/subscriptions/I-SUB', sub]
const saleSteps = (paidAt = jan, renewal = false): Step[] => [
  ['GET', '/v1/payments/sale/SALE', { ...sale, create_time: paidAt }],
  [
    'GET',
    '/v1/billing/subscriptions/I-SUB',
    {
      ...sub,
      billing_info: {
        last_payment: { time: paidAt, amount: money },
        next_billing_time: renewal ? '2026-03-01T00:00:00.000Z' : feb,
      },
    },
  ],
  [
    'GET',
    `/v1/billing/subscriptions/I-SUB/transactions?start_time=${encodeURIComponent(jan)}&end_time=${encodeURIComponent(paidAt)}`,
    {
      transactions: [
        ...(renewal
          ? [
              {
                id: 'FIRST',
                status: 'COMPLETED',
                time: jan,
                amount_with_breakdown: { gross_amount: money },
              },
            ]
          : []),
        {
          id: 'SALE',
          status: 'COMPLETED',
          time: paidAt,
          amount_with_breakdown: { gross_amount: money },
        },
      ],
    },
  ],
  ['GET', '/v1/billing/plans/P-PLAN', plan],
]
describe('PayPal verified webhook normalization', () => {
  it('forwards all transmission headers and the supplied raw body, preserving unsupported ID/type', async () => {
    const payload = event('CATALOG.PRODUCT.CREATED', { id: 'PRODUCT' })
    const h = harness([verify])
    expect(await h.provider.verifyWebhook(request(), JSON.stringify(payload))).toEqual({
      providerEventId: 'WH-EVENT',
      type: 'CATALOG.PRODUCT.CREATED',
      events: [],
    })
    expect(h.bodies[0]).toEqual({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: 'TRANSMISSION',
      transmission_sig: 'SIGNATURE',
      transmission_time: feb,
      webhook_id: 'WEBHOOK',
      webhook_event: payload,
    })
    h.done()
  })
  it.each(['FAILURE', 'success', undefined])(
    'rejects verification status %s before any enrichment',
    async (verification_status) => {
      const h = harness([
        ['POST', '/v1/notifications/verify-webhook-signature', { verification_status }],
      ])
      await expect(
        h.provider.verifyWebhook(
          request(),
          JSON.stringify(event('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-SUB' })),
        ),
      ).rejects.toThrow('verification failed')
      h.done()
    },
  )
  it('requires every transmission header and configured webhook ID', async () => {
    const h = harness([])
    for (const header of Object.keys(headers)) {
      const values = { ...headers }
      delete values[header as keyof typeof headers]
      await expect(h.provider.verifyWebhook(request(values), '{}')).rejects.toThrow('Missing')
    }
    const { webhookId: _webhookId, ...withoutWebhook } = h.options
    await expect(
      createPayPalProvider(withoutWebhook).verifyWebhook(request(), '{}'),
    ).rejects.toThrow('not configured')
    h.done()
  })
  it('normalizes activation without inventing a paid period or payment event', async () => {
    const h = harness([verify, subStep])
    const result = await h.provider.verifyWebhook(
      request(),
      JSON.stringify(event('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-SUB' })),
    )
    expect(result.events.map((item) => item.type)).toEqual([
      'checkout.completed',
      'subscription.activated',
    ])
    expect(result.events[1]).toMatchObject({
      subscription: { currentPeriodStart: null, currentPeriodEnd: null, remoteStatus: 'ACTIVE' },
    })
    h.done()
  })
  it.each(['CANCELLED', 'EXPIRED'])(
    'maps subscription %s with nullable unpaid period',
    async (status) => {
      const h = harness([
        ['GET', '/v1/billing/subscriptions/I-SUB', { ...sub, status, status_update_time: feb }],
      ])
      expect(
        (await h.normalize(event(`BILLING.SUBSCRIPTION.${status}`, { id: 'I-SUB' }))).events[0],
      ).toMatchObject({
        type: 'subscription.canceled',
        currentPeriodEnd: null,
        canceledAt: new Date(feb),
        status: status === 'EXPIRED' ? 'expired' : 'canceled',
      })
      h.done()
    },
  )
  it.each(['PAYMENT.FAILED', 'SUSPENDED'])('uses event creation time for %s', async (suffix) => {
    const h = harness([])
    expect(
      (
        await h.normalize(
          event(`BILLING.SUBSCRIPTION.${suffix}`, { id: 'I-SUB', status_update_time: jan }),
        )
      ).events[0],
    ).toMatchObject({
      type: 'subscription.past_due',
      pastDueSince: new Date(feb),
      status: suffix === 'SUSPENDED' ? 'paused' : 'past_due',
    })
    h.done()
  })
  it('maps updated snapshots with actual remote SUSPENDED status', async () => {
    const h = harness([['GET', '/v1/billing/subscriptions/I-SUB', { ...sub, status: 'SUSPENDED' }]])
    expect(
      (await h.normalize(event('BILLING.SUBSCRIPTION.UPDATED', { id: 'I-SUB' }))).events[0],
    ).toMatchObject({
      type: 'subscription.updated',
      subscription: { status: 'paused', remoteStatus: 'SUSPENDED', cancelAtPeriodEnd: false },
    })
    h.done()
  })
  it('normalizes first Sale identically on verified delivery and trusted replay', async () => {
    const payload = event('PAYMENT.SALE.COMPLETED', sale)
    const records: PayPalRecordedSale[] = []
    const later = saleSteps()
    later[1] = [
      'GET',
      '/v1/billing/subscriptions/I-SUB',
      {
        ...sub,
        billing_info: {
          last_payment: { time: feb, amount: money },
          next_billing_time: '2026-03-01T00:00:00.000Z',
        },
      },
    ]
    const h = harness([verify, ...saleSteps(), ...later], records)
    const delivered = await h.provider.verifyWebhook(request(), JSON.stringify(payload))
    records.push({
      providerPaymentId: 'SALE',
      providerSubscriptionId: 'I-SUB',
      providerPriceId: 'P-PLAN',
      workspaceId: meta.workspaceId,
      planPriceId: meta.planPriceId,
      kind: 'initial',
      amount: 1234,
      currency: 'USD',
      paidAt: new Date(jan),
      period: { start: new Date(jan), end: new Date(feb) },
    })
    const replayed = await h.normalize(payload)
    expect(replayed).toEqual(delivered)
    expect(delivered.events.map((item) => item.type)).toEqual(['payment.succeeded'])
    expect(delivered.events[0]).toMatchObject({
      payment: { kind: 'initial', period: { start: new Date(jan), end: new Date(feb) } },
    })
    h.done()
  })
  it('maps renewal using complete history and emits the paid period', async () => {
    const h = harness(saleSteps(feb, true), [
      {
        providerPaymentId: 'FIRST',
        providerSubscriptionId: 'I-SUB',
        providerPriceId: 'P-PLAN',
        workspaceId: meta.workspaceId,
        planPriceId: meta.planPriceId,
        kind: 'initial',
        amount: 1234,
        currency: 'USD',
        paidAt: new Date(jan),
        period: { start: new Date(jan), end: new Date(feb) },
      },
    ])
    const result = await h.normalize(event('PAYMENT.SALE.COMPLETED', { ...sale, create_time: feb }))
    expect(result.events.map((item) => item.type)).toEqual([
      'payment.succeeded',
      'subscription.renewed',
    ])
    expect(result.events[0]).toMatchObject({ payment: { kind: 'renewal', metadata: null } })
    h.done()
  })
  it('maps Capture to its verified stable order and payment IDs', async () => {
    const h = harness([
      ['GET', '/v2/payments/captures/CAPTURE', capture],
      ['GET', '/v2/checkout/orders/ORDER', order],
    ])
    expect(
      (await h.normalize(event('PAYMENT.CAPTURE.COMPLETED', capture))).events[0],
    ).toMatchObject({
      type: 'payment.succeeded',
      payment: { kind: 'one_time', providerPaymentId: 'CAPTURE', providerOrderId: 'ORDER' },
    })
    h.done()
  })
  it.each([false, true])(
    'maps Capture refund with cumulative amount present=%s',
    async (cumulative) => {
      const refund = {
        id: 'REFUND',
        status: 'COMPLETED',
        amount: { value: '2.00', currency_code: 'USD' },
        links: [
          { rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE' },
        ],
        ...(cumulative
          ? {
              seller_payable_breakdown: {
                total_refunded_amount: { value: '3.00', currency_code: 'USD' },
              },
            }
          : {}),
      }
      const h = harness([['GET', '/v2/payments/refunds/REFUND', refund]])
      expect(
        (await h.normalize(event('PAYMENT.CAPTURE.REFUNDED', refund))).events[0],
      ).toMatchObject({
        type: 'payment.refunded',
        providerRefundId: 'REFUND',
        providerPaymentId: 'CAPTURE',
        amount: 200,
        refundedAmount: cumulative ? 300 : null,
      })
      h.done()
    },
  )
  it('maps distinct Sale refund IDs with actual delta and unknown cumulative total', async () => {
    const refund = {
      id: 'REFUND',
      state: 'completed',
      sale_id: 'SALE',
      amount: { total: '2.00', currency: 'USD' },
    }
    const h = harness([['GET', '/v1/payments/refund/REFUND', refund]])
    expect((await h.normalize(event('PAYMENT.SALE.REFUNDED', refund))).events[0]).toMatchObject({
      providerPaymentId: 'SALE',
      providerRefundId: 'REFUND',
      amount: 200,
      refundedAmount: null,
    })
    h.done()
  })
  it('rejects arbitrary refund association URLs without fetching them', async () => {
    const refund = {
      id: 'REFUND',
      status: 'COMPLETED',
      amount: money,
      links: [{ rel: 'up', href: 'https://attacker.example/v2/payments/captures/CAPTURE' }],
    }
    const h = harness([['GET', '/v2/payments/refunds/REFUND', refund]])
    await expect(h.normalize(event('PAYMENT.CAPTURE.REFUNDED', refund))).rejects.toThrow('Unsafe')
    h.done()
  })
  it('uses stable seller transaction ID for disputes', async () => {
    const h = harness([])
    expect(
      (
        await h.normalize(
          event('CUSTOMER.DISPUTE.CREATED', {
            dispute_id: 'DISPUTE',
            dispute_amount: money,
            disputed_transactions: [
              { seller_transaction_id: 'CAPTURE', buyer_transaction_id: 'BUYER-TX' },
            ],
          }),
        )
      ).events[0],
    ).toMatchObject({
      type: 'payment.disputed',
      providerPaymentId: 'CAPTURE',
      providerDisputeId: 'DISPUTE',
      amount: 1234,
    })
    h.done()
  })
  it('never silently ignores a malformed supported event', async () => {
    const h = harness([])
    await expect(h.normalize(event('PAYMENT.SALE.REFUNDED', {}))).rejects.toThrow()
    await expect(
      h.normalize(
        event('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'DISPUTE', disputed_transactions: [{}] }),
      ),
    ).rejects.toThrow()
    h.done()
  })
})
