import { describe, expect, it } from 'vitest'
import { encodePayPalMetadata } from './metadata.ts'
import {
  classifyPayPalSale,
  createPayPalSnapshots,
  type PayPalRecordedSale,
  payPalDate,
  payPalRaw,
} from './snapshots.ts'
import { createPayPalTransport } from './transport.ts'

const meta = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  planPriceId: '33333333-3333-4333-8333-333333333333',
}
const money = { value: '12.34', currency_code: 'USD' }
const jan = '2026-01-01T00:00:00.000Z'
const feb = '2026-02-01T00:00:00.000Z'
const mar = '2026-03-01T00:00:00.000Z'
const sub = {
  id: 'I-SUB',
  plan_id: 'P-PLAN',
  status: 'ACTIVE',
  start_time: jan,
  custom_id: encodePayPalMetadata(meta),
  subscriber: { payer_id: 'BUYER' },
  billing_info: { last_payment: { time: feb, amount: money }, next_billing_time: mar },
}
const plan = {
  id: 'P-PLAN',
  billing_cycles: [
    {
      tenure_type: 'REGULAR',
      total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: money },
    },
  ],
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
  payer: { payer_id: 'BUYER' },
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
const tx = (id: string, time: string, status = 'COMPLETED') => ({
  id,
  time,
  status,
  amount_with_breakdown: { gross_amount: money },
})
const historyPath = (end = jan) =>
  `/v1/billing/subscriptions/I-SUB/transactions?start_time=${encodeURIComponent(jan)}&end_time=${encodeURIComponent(end)}`
type Step = [string, unknown]
const recordedSale: PayPalRecordedSale = {
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
}
function harness(steps: Step[], records: PayPalRecordedSale[] = []) {
  const transport = createPayPalTransport({
    environment: 'sandbox',
    clientId: 'offline-fixture',
    clientSecret: 'offline-fixture',
    cache: {
      get: async () => JSON.stringify({ accessToken: 'offline', expiresAt: 9999999999999 }),
      put: async () => {},
    },
    fetch: async (url, init) => {
      const next = steps.shift()
      if (!next) throw new Error(`Unexpected HTTP request: ${String(url)}`)
      expect(init?.method).toBe('GET')
      expect(String(url)).toBe(`https://api-m.sandbox.paypal.com${next[0]}`)
      return new Response(JSON.stringify(next[1]), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  return {
    snapshots: createPayPalSnapshots(
      transport,
      async (id) => records.find((record) => record.providerPaymentId === id) ?? null,
    ),
    transport,
    done: () => expect(steps).toHaveLength(0),
  }
}
describe('PayPal snapshots via offline HTTP', () => {
  it.each([
    ['ACTIVE', 'active'],
    ['SUSPENDED', 'paused'],
    ['CANCELLED', 'canceled'],
    ['EXPIRED', 'expired'],
    ['APPROVED', 'paused'],
    ['APPROVAL_PENDING', 'paused'],
  ])('preserves %s and paid dates', async (remote, local) => {
    const h = harness([
      ['/v1/billing/subscriptions/I-SUB', { ...sub, status: remote, status_update_time: feb }],
    ])
    const snapshot = await h.snapshots.getSubscription('I-SUB')
    expect(snapshot).toMatchObject({
      status: local,
      remoteStatus: remote,
      currentPeriodStart: new Date(feb),
      currentPeriodEnd: new Date(mar),
      metadata: meta,
      cancelAtPeriodEnd: false,
    })
    h.done()
  })
  it('returns null periods for unpaid subscriptions', async () => {
    const h = harness([['/v1/billing/subscriptions/I-SUB', { ...sub, billing_info: {} }]])
    expect(await h.snapshots.getSubscription('I-SUB')).toMatchObject({
      currentPeriodStart: null,
      currentPeriodEnd: null,
      remoteStatus: 'ACTIVE',
    })
    h.done()
  })
  it('uses a fixed yearly plan when the next billing date is absent', async () => {
    const h = harness([
      [
        '/v1/billing/subscriptions/I-SUB',
        { ...sub, billing_info: { last_payment: { time: jan, amount: money } } },
      ],
      [
        '/v1/billing/plans/P-PLAN',
        {
          ...plan,
          billing_cycles: [
            { ...plan.billing_cycles[0], frequency: { interval_unit: 'YEAR', interval_count: 1 } },
          ],
        },
      ],
    ])
    expect((await h.snapshots.getSubscription('I-SUB')).currentPeriodEnd).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    )
    h.done()
  })
  it('maps stable order ID, exact amount and metadata', async () => {
    const h = harness([['/v2/checkout/orders/ORDER', order]])
    expect(await h.snapshots.getOrder('ORDER')).toMatchObject({
      providerOrderId: 'ORDER',
      providerCustomerId: 'BUYER',
      amount: 1234,
      status: 'paid',
      metadata: meta,
      providerPriceId: `paypal:credit_pack:${meta.planPriceId}`,
    })
    h.done()
  })
  it('maps refunded orders from capture state', async () => {
    const h = harness([
      [
        '/v2/checkout/orders/ORDER',
        {
          ...order,
          purchase_units: [
            {
              ...order.purchase_units[0],
              payments: { captures: [{ ...capture, status: 'REFUNDED' }] },
            },
          ],
        },
      ],
    ])
    expect((await h.snapshots.getOrder('ORDER')).status).toBe('refunded')
    h.done()
  })
  it.each(['related_ids', 'up'])(
    'repairs absent Capture metadata using verified Order (%s)',
    async (source) => {
      const remote =
        source === 'up'
          ? {
              ...capture,
              supplementary_data: undefined,
              links: [
                { rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER' },
              ],
            }
          : capture
      const h = harness([
        ['/v2/payments/captures/CAPTURE', remote],
        ['/v2/checkout/orders/ORDER', order],
      ])
      expect(
        await h.snapshots.getPayment({ kind: 'one_time', providerPaymentId: 'CAPTURE' }),
      ).toMatchObject({
        providerOrderId: 'ORDER',
        amount: 1234,
        metadata: meta,
        period: null,
        refundedAmount: 0,
      })
      h.done()
    },
  )
  it('returns null for absent metadata when the platform association is intact', async () => {
    const h = harness([
      [
        '/v2/checkout/orders/ORDER',
        { ...order, purchase_units: [{ amount: money, payments: { captures: [capture] } }] },
      ],
    ])
    expect((await h.snapshots.getOrder('ORDER')).metadata).toBeNull()
    h.done()
  })
  it('rejects missing Capture order association and unsupported adjustment without guessing', async () => {
    const h = harness([['/v2/payments/captures/CAPTURE', { ...capture, supplementary_data: {} }]])
    await expect(
      h.snapshots.getPayment({ kind: 'one_time', providerPaymentId: 'CAPTURE' }),
    ).rejects.toThrow('association')
    await expect(
      h.snapshots.getPayment({ kind: 'adjustment', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('adjustment')
    h.done()
  })
  it('uses full-refund totals and nullable partial-refund totals', async () => {
    const full = { ...capture, status: 'REFUNDED' }
    const h = harness([
      ['/v2/payments/captures/CAPTURE', full],
      [
        '/v2/checkout/orders/ORDER',
        {
          ...order,
          purchase_units: [{ ...order.purchase_units[0], payments: { captures: [full] } }],
        },
      ],
      ['/v2/payments/captures/CAPTURE', { ...capture, status: 'PARTIALLY_REFUNDED' }],
      ['/v2/checkout/orders/ORDER', order],
    ])
    expect(
      await h.snapshots.getPayment({ kind: 'one_time', providerPaymentId: 'CAPTURE' }),
    ).toMatchObject({ status: 'refunded', refundedAmount: 1234 })
    expect(
      await h.snapshots.getPayment({ kind: 'one_time', providerPaymentId: 'CAPTURE' }),
    ).toMatchObject({ status: 'partially_refunded', refundedAmount: null })
    h.done()
  })
  it('preserves an existing historical Sale period even when its old end was inaccurate', async () => {
    const legacyEnd = new Date('2026-01-31T22:00:00.000Z')
    const h = harness(
      [
        ['/v1/payments/sale/SALE', sale],
        ['/v1/billing/subscriptions/I-SUB', sub],
        [historyPath(), { transactions: [tx('SALE', jan)], total_items: 1, total_pages: 1 }],
        ['/v1/billing/plans/P-PLAN', plan],
      ],
      [{ ...recordedSale, period: { start: new Date(jan), end: legacyEnd } }],
    )
    expect(
      await h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).toMatchObject({
      kind: 'initial',
      providerSubscriptionId: 'I-SUB',
      period: { start: new Date(jan), end: legacyEnd },
      metadata: meta,
    })
    h.done()
  })
  it('preserves the actual next billing time for a current initial Sale', async () => {
    // 沙箱首付的扣款时刻与下次扣款时刻不同，不能从 start_time 推算周期末。
    const start = '2026-10-11T07:17:44.000Z'
    const paidAt = '2026-10-11T07:20:36.000Z'
    const nextBilling = '2026-11-11T10:00:00.000Z'
    const h = harness([
      ['/v1/payments/sale/SALE', { ...sale, create_time: paidAt }],
      [
        '/v1/billing/subscriptions/I-SUB',
        {
          ...sub,
          start_time: start,
          billing_info: {
            last_payment: { time: paidAt, amount: money },
            next_billing_time: nextBilling,
          },
        },
      ],
      [
        `/v1/billing/subscriptions/I-SUB/transactions?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(paidAt)}`,
        { transactions: [tx('SALE', paidAt)], total_items: 1, total_pages: 1 },
      ],
      ['/v1/billing/plans/P-PLAN', plan],
    ])
    const payment = await h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' })
    expect(payment.period?.end).toEqual(new Date(nextBilling))
    h.done()
  })
  it('maps current renewal using real paid dates without requiring metadata', async () => {
    const previousEnd = new Date('2026-01-31T22:00:00.000Z')
    const h = harness(
      [
        ['/v1/payments/sale/SALE', { ...sale, create_time: feb }],
        ['/v1/billing/subscriptions/I-SUB', { ...sub, custom_id: undefined }],
        [historyPath(feb), { transactions: [tx('FIRST', jan, 'REFUNDED'), tx('SALE', feb)] }],
        ['/v1/billing/plans/P-PLAN', plan],
      ],
      [
        {
          ...recordedSale,
          providerPaymentId: 'FIRST',
          period: { start: new Date(jan), end: previousEnd },
        },
      ],
    )
    expect(
      await h.snapshots.getPayment({ kind: 'renewal', providerPaymentId: 'SALE' }),
    ).toMatchObject({
      kind: 'renewal',
      period: { start: previousEnd, end: new Date(mar) },
      metadata: null,
    })
    h.done()
  })
  it('rejects a current renewal without a recorded preceding period', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', { ...sale, create_time: feb }],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(feb), { transactions: [tx('FIRST', jan), tx('SALE', feb)] }],
      ['/v1/billing/plans/P-PLAN', plan],
    ])
    await expect(
      h.snapshots.getPayment({ kind: 'renewal', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('Previous')
    h.done()
  })
  it.each(['providerSubscriptionId', 'workspaceId', 'planPriceId', 'providerPriceId'] as const)(
    'rejects conflicting recorded Sale %s',
    async (field) => {
      const h = harness(
        [
          ['/v1/payments/sale/SALE', sale],
          ['/v1/billing/subscriptions/I-SUB', sub],
          [historyPath(), { transactions: [tx('SALE', jan)] }],
          ['/v1/billing/plans/P-PLAN', plan],
        ],
        [{ ...recordedSale, [field]: 'OTHER' }],
      )
      await expect(
        h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
      ).rejects.toThrow('identity mismatch')
      h.done()
    },
  )
  it('classifies duplicate delivery of first actual Sale as initial', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(), { transactions: [tx('FAIL', jan, 'FAILED'), tx('SALE', jan)] }],
    ])
    expect(await classifyPayPalSale(h.transport, 'SALE')).toBe('initial')
    h.done()
  })
  it('rejects a first Sale mislabeled renewal', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(), { transactions: [tx('SALE', jan)] }],
    ])
    await expect(
      h.snapshots.getPayment({ kind: 'renewal', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('kind mismatch')
    h.done()
  })
  it('rejects incomplete transaction history', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(), { transactions: [tx('SALE', jan)], total_pages: 2 }],
    ])
    await expect(classifyPayPalSale(h.transport, 'SALE')).rejects.toThrow('Complete')
    h.done()
  })
  it('rejects an unrecorded historical Sale instead of inferring calendar boundaries', async () => {
    const late = '2026-01-02T00:00:00.000Z'
    const h = harness([
      ['/v1/payments/sale/SALE', { ...sale, create_time: late }],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(late), { transactions: [tx('SALE', late)] }],
      ['/v1/billing/plans/P-PLAN', plan],
    ])
    await expect(
      h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('Historical')
    h.done()
  })
  it('rejects malformed metadata and remote ID mismatch', async () => {
    const h = harness([
      [
        '/v2/checkout/orders/ORDER',
        { ...order, purchase_units: [{ ...order.purchase_units[0], custom_id: 'bad' }] },
      ],
      ['/v2/checkout/orders/ORDER', { ...order, id: 'OTHER' }],
    ])
    await expect(h.snapshots.getOrder('ORDER')).rejects.toThrow('metadata')
    await expect(h.snapshots.getOrder('ORDER')).rejects.toThrow('ID mismatch')
    h.done()
  })
  it('rejects a Sale without a subscription association', async () => {
    const h = harness([['/v1/payments/sale/SALE', { ...sale, billing_agreement_id: undefined }]])
    await expect(
      h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('resource ID')
    h.done()
  })
  it('reports Sale partial refunds without returning zero', async () => {
    const h = harness(
      [
        ['/v1/payments/sale/SALE', { ...sale, state: 'partially_refunded' }],
        ['/v1/billing/subscriptions/I-SUB', sub],
        [historyPath(), { transactions: [tx('SALE', jan, 'PARTIALLY_REFUNDED')] }],
        ['/v1/billing/plans/P-PLAN', plan],
      ],
      [recordedSale],
    )
    expect(
      await h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).toMatchObject({ status: 'partially_refunded', refundedAmount: null })
    h.done()
  })
  it('rejects unsupported trial plans for period fallback', async () => {
    const h = harness([
      [
        '/v1/billing/subscriptions/I-SUB',
        { ...sub, billing_info: { last_payment: { time: jan, amount: money } } },
      ],
      [
        '/v1/billing/plans/P-PLAN',
        { ...plan, billing_cycles: [{ ...plan.billing_cycles[0], tenure_type: 'TRIAL' }] },
      ],
    ])
    await expect(h.snapshots.getSubscription('I-SUB')).rejects.toThrow('REGULAR')
    h.done()
  })
  it('follows verified next links and merges overlapping transaction IDs', async () => {
    const next = `${historyPath(feb)}&page=2`
    const h = harness([
      ['/v1/payments/sale/SALE', { ...sale, create_time: feb }],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [
        historyPath(feb),
        {
          transactions: [tx('FIRST', jan)],
          total_items: 2,
          total_pages: 2,
          links: [{ rel: 'next', href: `https://api-m.sandbox.paypal.com${next}` }],
        },
      ],
      [next, { transactions: [tx('FIRST', jan), tx('SALE', feb)], total_items: 2, total_pages: 2 }],
    ])
    expect(await classifyPayPalSale(h.transport, 'SALE')).toBe('renewal')
    h.done()
  })
  it('rejects pagination links outside the configured API origin', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [
        historyPath(),
        {
          transactions: [tx('SALE', jan)],
          links: [{ rel: 'next', href: `https://attacker.example${historyPath()}&page=2` }],
        },
      ],
    ])
    await expect(classifyPayPalSale(h.transport, 'SALE')).rejects.toThrow('Unsafe')
    h.done()
  })
  it('rejects paid history spanning a missing cycle', async () => {
    const h = harness(
      [
        ['/v1/payments/sale/SALE', { ...sale, create_time: mar }],
        [
          '/v1/billing/subscriptions/I-SUB',
          {
            ...sub,
            billing_info: {
              last_payment: { time: mar, amount: money },
              next_billing_time: '2026-04-01T00:00:00.000Z',
            },
          },
        ],
        [historyPath(mar), { transactions: [tx('FIRST', jan), tx('SALE', mar)] }],
        ['/v1/billing/plans/P-PLAN', plan],
      ],
      [{ ...recordedSale, providerPaymentId: 'FIRST' }],
    )
    await expect(
      h.snapshots.getPayment({ kind: 'renewal', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('gap')
    h.done()
  })
  it('rejects overridden plans before deriving Sale periods', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', { ...sub, plan_overridden: true }],
      [historyPath(), { transactions: [tx('SALE', jan)] }],
    ])
    await expect(
      h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('Overridden')
    h.done()
  })
  it('rejects revised pricing schemes for historical payment periods', async () => {
    const h = harness([
      ['/v1/payments/sale/SALE', sale],
      ['/v1/billing/subscriptions/I-SUB', sub],
      [historyPath(), { transactions: [tx('SALE', jan)] }],
      [
        '/v1/billing/plans/P-PLAN',
        {
          ...plan,
          billing_cycles: [
            { ...plan.billing_cycles[0], pricing_scheme: { fixed_price: money, version: 2 } },
          ],
        },
      ],
    ])
    await expect(
      h.snapshots.getPayment({ kind: 'initial', providerPaymentId: 'SALE' }),
    ).rejects.toThrow('Revised')
    h.done()
  })
  it('rejects impossible external dates and non-JSON raw values', () => {
    for (const value of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z', undefined])
      expect(() => payPalDate(value)).toThrow()
    expect(() => payPalRaw({ date: new Date() })).toThrow()
    expect(() => payPalRaw({ value: Number.NaN })).toThrow()
  })
})
