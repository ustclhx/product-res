import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { JsonValue } from '@product-res/db/schema'
import { describe, expect, it } from 'vitest'
import { createStripeProvider, createStripeWebhookNormalizer } from './adapter.ts'
import provenance from './fixtures/recorded/provenance.json'

function fixtureBody(fixture: string) {
  return readFileSync(new URL(`./fixtures/recorded/${fixture}`, import.meta.url), 'utf8')
}

function fixturePayload(fixture: string): JsonValue {
  return JSON.parse(fixtureBody(fixture))
}

function offlineFetch(
  replies: {
    fixture: string
    path: string
    query: Record<string, string>
    status: number
    apiVersion: string
  }[],
) {
  let requests = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const reply = replies[requests++]
    if (!reply) throw new Error(`Unexpected offline request: ${url.pathname}${url.search}`)
    expect(init?.method).toBe('GET')
    expect(url.origin).toBe('https://api.stripe.com')
    expect(url.pathname).toBe(reply.path)
    // GET 录制使用 expand[]；Stripe SDK 对同一个单值数组编码为 expand[0]。
    const query = Object.entries(reply.query).map(([key, value]) => [
      key === 'expand[]' ? 'expand[0]' : key,
      value,
    ])
    expect([...url.searchParams.entries()].sort()).toEqual(query.sort())
    expect(new Headers(init?.headers).get('stripe-version')).toBe(reply.apiVersion)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_offline_only')
    return new Response(fixtureBody(reply.fixture), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, complete: () => expect(requests).toBe(replies.length) }
}

const monthlySubscription = {
  subscriptionId: 'sub_1UOYdgL3UTpBAoXoZxQZO7Ti',
  customerId: 'cus_VPNOl9hPPPmDPj',
  priceId: 'price_1UOSygL3UTpBAoXoQKRdSIBc',
  amount: 1900,
  metadata: {
    workspaceId: '01a11fa8-08da-71f1-9c8d-a0ab10568800',
    userId: '01a11fa8-08da-71f1-9c8d-a0ab10568800',
    planPriceId: '01a11bac-8a18-7786-a6cf-d84dd209ef99',
  },
}

describe('Stripe adapter with recorded test-platform fixtures', () => {
  it('maps the recorded charge.refunded without embedded refunds to its verified refund identity', async () => {
    const mock = offlineFetch([provenance['platform-partial-refunds']])
    const payload = fixturePayload('platform-partial-refund-event.json')
    const normalize = createStripeWebhookNormalizer({
      secretKey: 'sk_test_offline_only',
      fetch: mock.fetch,
    })
    const result = await normalize(payload)
    expect(result.providerEventId).toBe('evt_3UOYjIL3UTpBAoXo1KA14f1c')
    expect(result.type).toBe('charge.refunded')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'payment.refunded',
      provider: 'stripe',
      providerPaymentId: 'pi_3UOYjIL3UTpBAoXo1gvunegg',
      providerRefundId: 're_3UOYjIL3UTpBAoXo1qqwZkZA',
      amount: 400,
      currency: 'usd',
      refundedAmount: null,
      occurredAt: new Date('2026-10-09T08:05:50.000Z'),
      raw: payload,
    })
    mock.complete()
  })

  it('maps recorded cumulative partial refunds to both identities without treating the charge total as either refund', async () => {
    const mock = offlineFetch([provenance['platform-partial-recovery-refunds']])
    const payload = fixturePayload('platform-partial-recovery-event.json')
    const normalize = createStripeWebhookNormalizer({
      secretKey: 'sk_test_offline_only',
      fetch: mock.fetch,
    })
    const result = await normalize(payload)
    expect(result.providerEventId).toBe('evt_3UOYjIL3UTpBAoXo1APsl6Oi')
    expect(result.type).toBe('charge.refunded')
    expect(result.events).toMatchObject([
      { providerRefundId: 're_3UOYjIL3UTpBAoXo1O6Tc6or', amount: 200 },
      { providerRefundId: 're_3UOYjIL3UTpBAoXo1qqwZkZA', amount: 400 },
    ])
    for (const event of result.events) {
      expect(event).toMatchObject({
        type: 'payment.refunded',
        provider: 'stripe',
        providerPaymentId: 'pi_3UOYjIL3UTpBAoXo1gvunegg',
        currency: 'usd',
        refundedAmount: null,
        occurredAt: new Date('2026-10-09T11:13:30.000Z'),
        raw: payload,
      })
    }
    mock.complete()
  })

  it.each([
    {
      ...monthlySubscription,
      kind: 'initial',
      recording: 'monthly-initial',
      eventId: 'evt_1UOYdhL3UTpBAoXoDzgAEbGZ',
      paymentId: 'pi_3UOYdfL3UTpBAoXo1TssRKHa',
      occurredAt: '2026-10-09T07:54:49.000Z',
      paidAt: '2026-10-09T07:54:47.000Z',
      periodStart: '2026-10-09T07:54:46.000Z',
      periodEnd: '2026-11-09T07:54:46.000Z',
    },
    {
      ...monthlySubscription,
      kind: 'renewal',
      recording: 'monthly-renewal',
      eventId: 'evt_1UOYf4L3UTpBAoXoqVeBpjfd',
      paymentId: 'pi_3UOYf0L3UTpBAoXo0tcelvaV',
      occurredAt: '2026-10-09T07:56:14.000Z',
      paidAt: '2026-11-09T08:54:46.000Z',
      periodStart: '2026-11-09T07:54:46.000Z',
      periodEnd: '2026-12-09T07:54:46.000Z',
    },
    {
      kind: 'renewal',
      recording: 'yearly-renewal',
      eventId: 'evt_1UObl2L3UTpBAoXoIhWrCL6T',
      paymentId: 'pi_3UObkxL3UTpBAoXo0sXqeehl',
      subscriptionId: 'sub_1UOYigL3UTpBAoXoRZmjmg7x',
      customerId: 'cus_VPNTGGkltwSblW',
      priceId: 'price_1UOSyiL3UTpBAoXoQVYU90Yt',
      amount: 19000,
      metadata: {
        workspaceId: '01a11fac-af11-72da-ad52-0869ceb1c9c9',
        userId: '01a11fac-af11-72da-ad52-0869ceb1c9c9',
        planPriceId: '01a11bac-8d09-77ec-97df-634cef2f887e',
      },
      occurredAt: '2026-10-09T11:14:35.000Z',
      paidAt: '2027-10-09T08:59:55.000Z',
      periodStart: '2027-10-09T07:59:55.000Z',
      periodEnd: '2028-10-09T07:59:55.000Z',
    },
  ] as const)(
    'replays recorded $recording with its historical service period and PaymentIntent identity',
    async (recorded) => {
      const mock = offlineFetch([
        provenance[`${recorded.recording}-invoice-payments`],
        provenance[`${recorded.recording}-intent`],
        provenance[`${recorded.recording}-intent-invoices`],
        provenance[`${recorded.recording}-invoice`],
      ])
      // 完整 event 来自已验签的 staging JSONB 或 CLI 镜像；此处重放录制正文。
      const payload = fixturePayload(`${recorded.recording}-event.json`)
      const normalize = createStripeWebhookNormalizer({
        secretKey: 'sk_test_offline_only',
        fetch: mock.fetch,
      })
      const result = await normalize(payload)
      expect(result.providerEventId).toBe(recorded.eventId)
      expect(result.type).toBe('invoice.paid')
      expect(result.events.map((event) => event.type)).toEqual(
        recorded.kind === 'renewal'
          ? ['payment.succeeded', 'subscription.renewed']
          : ['payment.succeeded'],
      )
      const period = {
        start: new Date(recorded.periodStart),
        end: new Date(recorded.periodEnd),
      }
      expect(result.events[0]).toMatchObject({
        type: 'payment.succeeded',
        payment: {
          kind: recorded.kind,
          providerPaymentId: recorded.paymentId,
          providerSubscriptionId: recorded.subscriptionId,
          providerCustomerId: recorded.customerId,
          providerPriceId: recorded.priceId,
          amount: recorded.amount,
          currency: 'usd',
          status: 'succeeded',
          refundedAmount: 0,
          paidAt: new Date(recorded.paidAt),
          period,
          metadata: recorded.metadata,
        },
      })
      if (recorded.kind === 'renewal') {
        expect(result.events[1]).toMatchObject({
          type: 'subscription.renewed',
          providerSubscriptionId: recorded.subscriptionId,
          providerPaymentId: recorded.paymentId,
          periodStart: period.start,
          periodEnd: period.end,
        })
      }
      for (const event of result.events) {
        expect(event).toMatchObject({
          provider: 'stripe',
          occurredAt: new Date(recorded.occurredAt),
          raw: payload,
        })
      }
      mock.complete()
    },
  )

  it('verifies an offline signature over recorded one-time Checkout and maps association plus payment', async () => {
    const mock = offlineFetch([
      provenance['one-time-intent'],
      provenance['one-time-intent-invoices'],
      provenance['one-time-checkout'],
    ])
    const webhookSecret = 'whsec_offline_recorded'
    const rawBody = fixtureBody('one-time-event.json')
    const timestamp = Math.floor(Date.now() / 1000)
    // 脱敏后正文仅以离线 secret 重签；原投递验签证据与原文 hash 保存在 provenance。
    const signature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')
    const provider = createStripeProvider({
      secretKey: 'sk_test_offline_only',
      webhookSecret,
      fetch: mock.fetch,
    })
    const result = await provider.verifyWebhook(
      new Request('https://offline.test/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
        body: rawBody,
      }),
      rawBody,
    )
    expect(result.providerEventId).toBe('evt_1UOYjKL3UTpBAoXo6nn8x7at')
    expect(result.type).toBe('checkout.session.completed')
    expect(result.events.map((event) => event.type)).toEqual([
      'checkout.completed',
      'payment.succeeded',
    ])
    const orderId = 'cs_test_a1usheGM0GIRwSfWHCerbOydDaNrhvsOSl5YhH1Fz7yPj0R4GPQECjglBs'
    const metadata = {
      workspaceId: '01a11fad-54ef-74b1-bb49-26232712dfa4',
      userId: '01a11fad-54ef-74b1-bb49-26232712dfa4',
      planPriceId: '01a11bac-a47c-77ef-aa22-87cdc57a4339',
    }
    expect(result.events[0]).toMatchObject({
      type: 'checkout.completed',
      mode: 'one_time',
      providerCheckoutId: orderId,
      providerOrderId: orderId,
      providerCustomerId: 'cus_VPNUh1UVdsn46D',
      metadata,
    })
    expect(result.events[1]).toMatchObject({
      type: 'payment.succeeded',
      payment: {
        kind: 'one_time',
        providerPaymentId: 'pi_3UOYjIL3UTpBAoXo1gvunegg',
        providerOrderId: orderId,
        providerCustomerId: 'cus_VPNUh1UVdsn46D',
        amount: 1000,
        currency: 'usd',
        status: 'succeeded',
        refundedAmount: 0,
        paidAt: new Date('2026-10-09T08:00:37.000Z'),
        period: null,
        metadata,
      },
    })
    for (const event of result.events) {
      expect(event).toMatchObject({
        provider: 'stripe',
        occurredAt: new Date('2026-10-09T08:00:37.000Z'),
        raw: JSON.parse(rawBody),
      })
    }
    mock.complete()
  })
})
