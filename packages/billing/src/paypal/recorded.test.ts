import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { JsonValue } from '@product-res/db/schema'
import { describe, expect, it } from 'vitest'
import cardOrderFixture from './fixtures/recorded/card-order.json'
import subscriptionFixture from './fixtures/recorded/monthly-subscription.json'
import provenance from './fixtures/recorded/provenance.json'
import followups from './fixtures/recorded/w3-provenance.json'
import { createPayPalWebhookNormalizer } from './index.ts'
import type { PayPalRecordedSale, PayPalSaleLookup } from './snapshots.ts'

function fixtureBody(fixture: string) {
  return readFileSync(new URL(`./fixtures/recorded/${fixture}`, import.meta.url), 'utf8')
}

function fixturePayload(fixture: string): JsonValue {
  return JSON.parse(fixtureBody(fixture))
}

type RecordedSnapshot =
  | (typeof provenance.snapshots)[keyof typeof provenance.snapshots]
  | (typeof followups.snapshots)[keyof typeof followups.snapshots]
type OfflineReply = RecordedSnapshot & { body?: string }

function offlineNormalizer(replies: OfflineReply[], lookupRecordedSale?: PayPalSaleLookup) {
  let requests = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const reply = replies[requests++]
    if (!reply) throw new Error(`Unexpected offline request: ${url.pathname}${url.search}`)
    const recordedUrl = new URL(reply.path, 'https://api-m.sandbox.paypal.com')
    expect(init?.method).toBe(reply.method)
    expect(url.origin).toBe(recordedUrl.origin)
    expect(url.pathname).toBe(recordedUrl.pathname)
    expect([...url.searchParams.entries()].sort()).toEqual(
      [...recordedUrl.searchParams.entries()].sort(),
    )
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer offline_recorded_only')
    return new Response(reply.body ?? fixtureBody(reply.fixture), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    normalize: createPayPalWebhookNormalizer({
      environment: 'sandbox',
      clientId: 'offline_recorded_client',
      clientSecret: 'offline_recorded_secret',
      fetch,
      // 只用合成缓存令牌；任何 OAuth、验签或未录制请求都会被离线 fetch 拒绝。
      cache: {
        get: async () =>
          JSON.stringify({ accessToken: 'offline_recorded_only', expiresAt: 9999999999999 }),
        put: async () => {},
      },
      ...(lookupRecordedSale ? { lookupRecordedSale } : {}),
    }),
    complete: () => expect(requests).toBe(replies.length),
  }
}

const workspaceId = '424520ab-ba36-59b8-916e-78c50a2ba378'
const oneTimeMetadata = {
  workspaceId,
  userId: workspaceId,
  planPriceId: '2bed5525-91cb-5064-91ce-f9e6dafdbe7f',
}
const monthlyMetadata = {
  workspaceId,
  userId: workspaceId,
  planPriceId: '4f6638cf-bf8f-563e-9161-84f67e9a7dee',
}
const monthlyPeriod = {
  start: new Date('2026-10-11T07:17:44.000Z'),
  end: new Date('2026-11-11T10:00:00.000Z'),
}
const saleReplies = [
  provenance.snapshots['monthly-initial-sale'],
  provenance.snapshots['monthly-subscription'],
  provenance.snapshots['monthly-initial-transactions'],
  provenance.snapshots['monthly-plan'],
]

describe('PayPal adapter with recorded sandbox fixtures', () => {
  it('preserves the sanitized event and GET snapshot hashes from the recording manifest', () => {
    for (const recording of [
      ...Object.values(provenance.events),
      ...Object.values(provenance.snapshots),
      ...Object.values(followups.events),
      ...Object.values(followups.snapshots),
    ]) {
      expect(createHash('sha256').update(fixtureBody(recording.fixture)).digest('hex')).toBe(
        recording.fixtureSha256,
      )
    }
  })

  it.each([
    {
      interval: 'monthly',
      event: followups.events['w3-monthly-initial-event'],
      replies: [
        followups.snapshots['w3-monthly-initial-sale'],
        followups.snapshots['w3-monthly-subscription'],
        followups.snapshots['w3-monthly-initial-transactions'],
        followups.snapshots['w3-pro-month-plan'],
      ],
      saleId: '71D187337X5761003',
      subscriptionId: 'I-PE4VWXLXB1XP',
      amount: 1900,
      priceId: '01a11bac-8ffa-740a-b8e6-0624cd93c617',
      start: '2026-10-18T06:06:16.000Z',
      end: '2026-11-18T10:00:00.000Z',
    },
    {
      interval: 'annual',
      event: followups.events['w3-annual-initial-event'],
      replies: [
        followups.snapshots['w3-annual-initial-sale'],
        followups.snapshots['w3-annual-subscription'],
        followups.snapshots['w3-annual-initial-transactions'],
        followups.snapshots['w3-team-year-plan'],
      ],
      saleId: '5ST08785RL1551152',
      subscriptionId: 'I-TKG3FMFU9BEN',
      amount: 49000,
      priceId: '01a11bac-a018-7367-8674-f78af86ce46a',
      start: '2026-10-18T06:09:14.000Z',
      end: '2027-10-18T10:00:00.000Z',
    },
  ])(
    'maps the new $interval Sale with recorded history and actual next billing time',
    async (row) => {
      const mock = offlineNormalizer(row.replies)
      const result = await mock.normalize(fixturePayload(row.event.fixture))
      expect(result.providerEventId).toBe(row.event.providerEventId)
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toMatchObject({
        type: 'payment.succeeded',
        provider: 'paypal',
        payment: {
          kind: 'initial',
          providerPaymentId: row.saleId,
          providerSubscriptionId: row.subscriptionId,
          amount: row.amount,
          currency: 'USD',
          status: 'succeeded',
          refundedAmount: 0,
          period: { start: new Date(row.start), end: new Date(row.end) },
          metadata: {
            workspaceId: '01a12ef0-66cc-75e2-88d0-eac1f1904d3c',
            userId: '01a12ef0-66cc-75e2-88d0-eac1f1904d3c',
            planPriceId: row.priceId,
          },
        },
      })
      mock.complete()
    },
  )

  it.each([
    {
      kind: 'partial',
      event: followups.events['w3-monthly-partial-refund-event'],
      snapshot: followups.snapshots['w3-monthly-partial-refund'],
      saleId: '71D187337X5761003',
      refundId: '95R03124HK508535V',
      amount: 400,
    },
    {
      kind: 'full',
      event: followups.events['w3-annual-full-refund-event'],
      snapshot: followups.snapshots['w3-annual-full-refund'],
      saleId: '5ST08785RL1551152',
      refundId: '6JW466111B6808810',
      amount: 49000,
    },
  ])('maps a recorded $kind Sale refund to its verified refund and original Sale', async (row) => {
    const mock = offlineNormalizer([row.snapshot])
    const payload = fixturePayload(row.event.fixture)
    const result = await mock.normalize(payload)
    expect(result.providerEventId).toBe(row.event.providerEventId)
    expect(result.events).toEqual([
      {
        type: 'payment.refunded',
        provider: 'paypal',
        providerPaymentId: row.saleId,
        providerRefundId: row.refundId,
        amount: row.amount,
        currency: 'USD',
        // v1 顶层 total_refunded_amount 不套用 v2 capture 累计语义，按唯一退款 ID 累加。
        refundedAmount: null,
        occurredAt: new Date(JSON.parse(fixtureBody(row.event.fixture)).create_time),
        raw: payload,
      },
    ])
    mock.complete()
  })

  // 原始回调已在线验签；脱敏正文只重放映射，不伪造原始传输签名。
  it('maps recorded order approval to association only, even when the GET order is now captured', async () => {
    const mock = offlineNormalizer([provenance.snapshots['one-time-order']])
    const payload = fixturePayload('one-time-approved-event.json')
    const result = await mock.normalize(payload)
    expect(result.providerEventId).toBe(
      provenance.events['one-time-approved-event'].providerEventId,
    )
    expect(result.type).toBe('CHECKOUT.ORDER.APPROVED')
    expect(result.events).toEqual([
      {
        type: 'checkout.completed',
        provider: 'paypal',
        mode: 'one_time',
        providerCheckoutId: '2A672877DY6250409',
        providerOrderId: '2A672877DY6250409',
        providerCustomerId: 'PAYERRECORDED',
        metadata: oneTimeMetadata,
        occurredAt: new Date('2026-10-11T05:44:22.110Z'),
        raw: payload,
      },
    ])
    mock.complete()
  })

  it('maps recorded Capture to its verified order, gross amount and checkout metadata', async () => {
    const mock = offlineNormalizer([
      provenance.snapshots['one-time-capture'],
      provenance.snapshots['one-time-order'],
    ])
    const payload = fixturePayload('one-time-event.json')
    const result = await mock.normalize(payload)
    expect(result.providerEventId).toBe(provenance.events['one-time-event'].providerEventId)
    expect(result.type).toBe('PAYMENT.CAPTURE.COMPLETED')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'payment.succeeded',
      provider: 'paypal',
      occurredAt: new Date('2026-10-11T05:50:09.000Z'),
      raw: payload,
      payment: {
        kind: 'one_time',
        providerPaymentId: '821243239P5069342',
        providerOrderId: '2A672877DY6250409',
        providerPriceId: `paypal:credit_pack:${oneTimeMetadata.planPriceId}`,
        providerCustomerId: 'PAYERRECORDED',
        amount: 1000,
        currency: 'USD',
        status: 'succeeded',
        refundedAmount: 0,
        paidAt: new Date('2026-10-11T05:50:09.000Z'),
        period: null,
        metadata: oneTimeMetadata,
      },
    })
    mock.complete()
  })

  it('maps the independently recorded full Capture refund to its verified refund identity', async () => {
    const mock = offlineNormalizer([provenance.snapshots['card-refund']])
    const payload = fixturePayload('card-refund-event.json')
    const result = await mock.normalize(payload)
    expect(result.providerEventId).toBe(provenance.events['card-refund-event'].providerEventId)
    expect(result.events).toEqual([
      {
        type: 'payment.refunded',
        provider: 'paypal',
        providerPaymentId: '14549073EE7057637',
        providerRefundId: '9UR96226Y9887940S',
        amount: 1,
        currency: 'USD',
        refundedAmount: 1,
        occurredAt: new Date('2026-10-14T17:08:47.648Z'),
        raw: payload,
      },
    ])
    mock.complete()
  })

  it('preserves the verified refund when a recorded Capture completion already carries REFUNDED', async () => {
    // 独立探针的 custom_id 是录制标记，非应用结账 metadata；仅在内存移除它以验证无关联的付款快照。
    // 原始夹具保持不变；应用入账仍须通过管线定位真实空间，不能凭这笔探针发积分。
    const order = {
      ...cardOrderFixture,
      purchase_units: cardOrderFixture.purchase_units.map(
        ({ custom_id: _marker, ...unit }) => unit,
      ),
    }
    const mock = offlineNormalizer([
      provenance.snapshots['card-capture'],
      { ...provenance.snapshots['card-order'], body: JSON.stringify(order) },
    ])
    const result = await mock.normalize(fixturePayload('card-refunded-capture-event.json'))
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'payment.succeeded',
      payment: {
        kind: 'one_time',
        providerPaymentId: '14549073EE7057637',
        providerOrderId: '6KE705423D766922N',
        amount: 1,
        status: 'refunded',
        refundedAmount: 1,
        metadata: null,
      },
    })
    mock.complete()
  })

  it('rejects an unpaid Capture state before reading snapshots', async () => {
    const mock = offlineNormalizer([])
    const recorded = JSON.parse(fixtureBody('card-refunded-capture-event.json'))
    const payload = { ...recorded, resource: { ...recorded.resource, status: 'PENDING' } }
    await expect(mock.normalize(payload)).rejects.toThrow(
      'Malformed PayPal completed payment state',
    )
    mock.complete()
  })

  it('classifies the recorded Sale as initial using remote history and the actual billing boundaries', async () => {
    const mock = offlineNormalizer(saleReplies)
    const payload = fixturePayload('monthly-initial-event.json')
    const result = await mock.normalize(payload)
    expect(result.providerEventId).toBe(provenance.events['monthly-initial-event'].providerEventId)
    expect(result.type).toBe('PAYMENT.SALE.COMPLETED')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'payment.succeeded',
      provider: 'paypal',
      occurredAt: new Date('2026-10-11T07:20:36.000Z'),
      raw: payload,
      payment: {
        kind: 'initial',
        providerPaymentId: '7WT17462SJ5165744',
        providerSubscriptionId: 'I-H2LE38AW7EU4',
        providerPriceId: 'P-5DY311405E0178244NLEERUI',
        providerCustomerId: 'PAYERRECORDED',
        amount: 1900,
        currency: 'USD',
        status: 'succeeded',
        refundedAmount: 0,
        paidAt: new Date('2026-10-11T07:20:36.000Z'),
        period: monthlyPeriod,
        metadata: monthlyMetadata,
      },
    })
    mock.complete()
  })

  it('keeps the recorded immutable Sale period when current subscription billing dates advance', async () => {
    const receipt: PayPalRecordedSale = {
      providerPaymentId: '7WT17462SJ5165744',
      providerSubscriptionId: 'I-H2LE38AW7EU4',
      providerPriceId: 'P-5DY311405E0178244NLEERUI',
      workspaceId,
      planPriceId: monthlyMetadata.planPriceId,
      kind: 'initial',
      amount: 1900,
      currency: 'USD',
      paidAt: new Date('2026-10-11T07:20:36.000Z'),
      period: monthlyPeriod,
    }
    // 合成后续账期漂移只存在于内存；录制正文和 GET 路径保持可核验。
    const advancedSubscription = {
      ...subscriptionFixture,
      billing_info: {
        ...subscriptionFixture.billing_info,
        last_payment: {
          amount: { currency_code: 'USD', value: '19.00' },
          time: '2026-11-11T10:00:00Z',
        },
        next_billing_time: '2026-12-11T10:00:00Z',
      },
    }
    const mock = offlineNormalizer(
      saleReplies.map((reply) =>
        reply.fixture === 'monthly-subscription.json'
          ? { ...reply, body: JSON.stringify(advancedSubscription) }
          : reply,
      ),
      async (saleId) => {
        expect(saleId).toBe(receipt.providerPaymentId)
        return receipt
      },
    )
    const result = await mock.normalize(fixturePayload('monthly-initial-event.json'))
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'payment.succeeded',
      payment: {
        kind: 'initial',
        providerPaymentId: receipt.providerPaymentId,
        period: monthlyPeriod,
      },
    })
    mock.complete()
  })

  it.each([
    { recording: 'monthly-activated-event', occurredAt: '2026-10-11T07:20:42.194Z' },
    { recording: 'monthly-resumed-event', occurredAt: '2026-10-11T07:23:17.278Z' },
  ] as const)(
    'maps recorded $recording to association plus active subscription, without payment',
    async ({ recording, occurredAt }) => {
      const mock = offlineNormalizer([provenance.snapshots['monthly-subscription']])
      const evidence = provenance.events[recording]
      const payload = fixturePayload(evidence.fixture)
      const result = await mock.normalize(payload)
      expect(result.providerEventId).toBe(evidence.providerEventId)
      expect(result.type).toBe('BILLING.SUBSCRIPTION.ACTIVATED')
      expect(result.events.map((event) => event.type)).toEqual([
        'checkout.completed',
        'subscription.activated',
      ])
      expect(result.events[0]).toMatchObject({
        mode: 'subscription',
        providerCheckoutId: 'I-H2LE38AW7EU4',
        providerSubscriptionId: 'I-H2LE38AW7EU4',
        providerCustomerId: 'PAYERRECORDED',
        metadata: monthlyMetadata,
      })
      expect(result.events[1]).toMatchObject({
        subscription: {
          providerSubscriptionId: 'I-H2LE38AW7EU4',
          providerPriceId: 'P-5DY311405E0178244NLEERUI',
          status: 'active',
          remoteStatus: 'ACTIVE',
          metadata: monthlyMetadata,
        },
      })
      for (const event of result.events) {
        expect(event).toMatchObject({
          provider: 'paypal',
          occurredAt: new Date(occurredAt),
          raw: payload,
        })
      }
      mock.complete()
    },
  )

  it('maps recorded suspension to paused at the event time without fetching the now-active subscription', async () => {
    const mock = offlineNormalizer([])
    const payload = fixturePayload('monthly-suspended-event.json')
    const result = await mock.normalize(payload)
    const occurredAt = new Date('2026-10-11T07:22:21.153Z')
    expect(result.providerEventId).toBe(
      provenance.events['monthly-suspended-event'].providerEventId,
    )
    expect(result.type).toBe('BILLING.SUBSCRIPTION.SUSPENDED')
    expect(result.events).toEqual([
      {
        type: 'subscription.past_due',
        provider: 'paypal',
        providerSubscriptionId: 'I-H2LE38AW7EU4',
        status: 'paused',
        pastDueSince: occurredAt,
        occurredAt,
        raw: payload,
      },
    ])
    mock.complete()
  })
})
