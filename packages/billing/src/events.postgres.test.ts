import { capture, hold, release } from '@product-res/credits'
import {
  auditLog,
  billingCompensation,
  billingCustomer,
  createDb,
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  member,
  organization,
  payment,
  paymentRefund,
  plan,
  planPrice,
  purchase,
  refundRequest,
  subscription,
  user,
  webhookEvent,
} from '@product-res/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBillingEvent,
  createBillingEventHandler,
  grantSubscriptionMonth,
  prepareBillingEvents,
  RenewingSubscriptionConflict,
  subscriptionMonthAnchor,
} from './events.ts'
import { encodePayPalMetadata } from './paypal/metadata.ts'
import { processWebhook } from './pipeline.ts'
import type {
  NormalizedEvent,
  PaymentProvider,
  PaymentSnapshot,
  SubscriptionSnapshot,
} from './provider.ts'
import { createPaymentRuntime } from './runtime.ts'

const testEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
const url = testEnv.BILLING_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: url })
// audit_log 对 app 只追加（@product-res/db 迁移 0009），审计行由 migrator 清理
const migrator = createDb({ connectionString: testEnv.MIGRATION_DATABASE_URL ?? '' })
const id = () => crypto.randomUUID()
const now = new Date('2030-01-31T12:00:00Z')
let ws: string,
  otherWs: string,
  uid: string,
  planId: string,
  priceId: string,
  subId: string,
  orderId: string
let snapshot: SubscriptionSnapshot
let provider: PaymentProvider
const metadata = () => ({ workspaceId: ws, userId: uid, planPriceId: priceId })
const paid = (overrides: Partial<PaymentSnapshot> = {}): NormalizedEvent => ({
  provider: 'stripe',
  type: 'payment.succeeded',
  occurredAt: now,
  raw: {},
  payment: {
    providerPaymentId: `pi-${id()}`,
    providerSubscriptionId: subId,
    kind: 'initial',
    period: { start: now, end: new Date('2030-02-28T12:00:00Z') },
    providerCustomerId: `customer-${ws}`,
    amount: 1000,
    currency: 'USD',
    paidAt: now,
    refundedAmount: null,
    status: 'succeeded',
    metadata: null,
    raw: {},
    ...overrides,
  } as PaymentSnapshot,
})
async function apply(events: NormalizedEvent[]) {
  const prepared = await prepareBillingEvents(events, db, { stripe: provider, paypal: provider })
  await db.transaction(async (tx) => {
    for (const event of events) await applyBillingEvent(tx, event, prepared, { now: () => now })
  })
}
async function checkout(oneTime = false): Promise<NormalizedEvent> {
  return {
    provider: 'stripe',
    type: 'checkout.completed',
    occurredAt: now,
    raw: {},
    providerCheckoutId: id(),
    providerCustomerId: `customer-${ws}`,
    metadata: metadata(),
    ...(oneTime
      ? { mode: 'one_time' as const, providerOrderId: orderId }
      : { mode: 'subscription' as const, providerSubscriptionId: subId }),
  }
}
beforeEach(async () => {
  ws = id()
  otherWs = id()
  uid = id()
  planId = id()
  priceId = id()
  subId = `sub-${id()}`
  orderId = `order-${id()}`
  await db.insert(user).values({ id: uid, name: 'Events', email: `${uid}@example.test` })
  await db.insert(organization).values([
    { id: ws, name: 'Events', slug: ws },
    { id: otherWs, name: 'Other', slug: otherWs },
  ])
  await db.insert(member).values({ id: id(), organizationId: ws, userId: uid, role: 'owner' })
  await db.insert(plan).values({
    id: planId,
    key: planId,
    name: 'Events',
    type: 'subscription',
    credits: 10,
    features: {
      models: [],
      maxConcurrentTasks: 1,
      maxSeats: 1,
      storageGb: 1,
      publicApi: false,
      priorityQueue: false,
      watermark: false,
    },
  })
  await db.insert(planPrice).values({
    id: priceId,
    planId,
    provider: 'stripe',
    providerPriceId: priceId,
    interval: 'month',
    amount: 1000,
    currency: 'USD',
  })
  snapshot = {
    providerSubscriptionId: subId,
    providerCustomerId: `customer-${ws}`,
    providerPriceId: priceId,
    status: 'active',
    remoteStatus: 'active',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    pastDueSince: null,
    metadata: metadata(),
    raw: { status: 'active' },
  }
  provider = {
    id: 'stripe',
    getSubscription: vi.fn(async () => snapshot),
    getOrder: vi.fn(async () => ({
      providerOrderId: orderId,
      providerCustomerId: `customer-${ws}`,
      providerPriceId: priceId,
      status: 'paid',
      amount: 1000,
      currency: 'USD',
      metadata: metadata(),
      raw: {},
    })),
  } as unknown as PaymentProvider
})
afterEach(async () => {
  const w = [ws, otherWs]
  const holds = await db.select().from(creditHold).where(inArray(creditHold.workspaceId, w))
  if (holds.length)
    await db.delete(creditHoldAllocation).where(
      inArray(
        creditHoldAllocation.holdId,
        holds.map((h) => h.id),
      ),
    )
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, w))
  await db.delete(creditHold).where(inArray(creditHold.workspaceId, w))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, w))
  await db.delete(creditDebt).where(inArray(creditDebt.workspaceId, w))
  await db.delete(billingCompensation).where(inArray(billingCompensation.workspaceId, w))
  await db.delete(refundRequest).where(inArray(refundRequest.workspaceId, w))
  await db.delete(paymentRefund).where(inArray(paymentRefund.workspaceId, w))
  await db.delete(payment).where(inArray(payment.workspaceId, w))
  await db.delete(purchase).where(inArray(purchase.workspaceId, w))
  await db.delete(subscription).where(inArray(subscription.workspaceId, w))
  await db.delete(billingCustomer).where(inArray(billingCustomer.workspaceId, w))
  await migrator.delete(auditLog).where(inArray(auditLog.workspaceId, w))
  await migrator.delete(auditLog).where(eq(auditLog.targetId, subId))
  await db.delete(member).where(inArray(member.organizationId, w))
  await db.delete(organization).where(inArray(organization.id, w))
  await db.delete(user).where(eq(user.id, uid))
  await db.delete(planPrice).where(eq(planPrice.planId, planId))
  await db.delete(plan).where(eq(plan.id, planId))
})
afterAll(() => Promise.all([db.$client.end(), migrator.$client.end()]))
const grants = () => db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
const payments = () => db.select().from(payment).where(eq(payment.workspaceId, ws))
const subs = () => db.select().from(subscription).where(eq(subscription.workspaceId, ws))
describe('billing event consumer on PostgreSQL', () => {
  it('keeps actual PayPal billing boundaries and full grace through renewal and old Sale replay', async () => {
    await db
      .update(planPrice)
      .set({ provider: 'paypal', amount: 1900 })
      .where(eq(planPrice.id, priceId))
    await db.update(plan).set({ credits: 1000 }).where(eq(plan.id, planId))
    const start = '2030-10-11T07:17:44.000Z'
    const firstPaid = '2030-10-11T07:20:36.000Z'
    const firstEnd = '2030-11-11T10:00:00.000Z'
    const nextPaid = '2030-11-11T10:01:00.000Z'
    const nextEnd = '2030-12-11T10:00:00.000Z'
    const money = { value: '19.00', currency_code: 'USD' }
    const sale = (key: string, time: string) => ({
      id: key,
      state: 'completed',
      amount: { total: '19.00', currency: 'USD' },
      create_time: time,
      billing_agreement_id: subId,
    })
    const first = sale(`SALE-${id()}`, firstPaid)
    const renewal = sale(`SALE-${id()}`, nextPaid)
    let renewed = false
    const runtime = createPaymentRuntime(
      {
        PAYMENT_MODE: 'test',
        PAYPAL_CLIENT_ID: 'fixture',
        PAYPAL_CLIENT_SECRET: 'fixture',
        PAYPAL_WEBHOOK_ID: 'fixture',
      },
      ['paypal'],
      {
        db,
        cache: {
          get: async () => JSON.stringify({ accessToken: 'fixture', expiresAt: 9999999999999 }),
          put: async () => {},
        },
        fetch: async (input) => {
          const url = new URL(String(input))
          let body: unknown
          if (url.pathname === `/v1/payments/sale/${first.id}`) body = first
          else if (url.pathname === `/v1/payments/sale/${renewal.id}`) body = renewal
          else if (url.pathname === `/v1/billing/subscriptions/${subId}`)
            body = {
              id: subId,
              plan_id: priceId,
              status: 'ACTIVE',
              start_time: start,
              custom_id: encodePayPalMetadata(metadata()),
              subscriber: { payer_id: `buyer-${ws}` },
              billing_info: {
                last_payment: { time: renewed ? nextPaid : firstPaid, amount: money },
                next_billing_time: renewed ? nextEnd : firstEnd,
              },
            }
          else if (url.pathname === `/v1/billing/subscriptions/${subId}/transactions`)
            body = {
              transactions: [
                first,
                ...(url.searchParams.get('end_time') === nextPaid ? [renewal] : []),
              ].map((s) => ({
                id: s.id,
                time: s.create_time,
                status: 'COMPLETED',
                amount_with_breakdown: { gross_amount: money },
              })),
            }
          else if (url.pathname === `/v1/billing/plans/${priceId}`)
            body = {
              id: priceId,
              billing_cycles: [
                {
                  tenure_type: 'REGULAR',
                  total_cycles: 0,
                  frequency: { interval_unit: 'MONTH', interval_count: 1 },
                  pricing_scheme: { fixed_price: money },
                },
              ],
            }
          else throw new Error(`Unexpected PayPal fixture request: ${url.pathname}`)
          return Response.json(body)
        },
      },
    )
    const ingest = async (resource: typeof first) => {
      const verified = await runtime.normalizers.paypal?.({
        id: `EVENT-${id()}`,
        event_type: 'PAYMENT.SALE.COMPLETED',
        create_time: resource.create_time,
        resource,
      })
      if (!verified) throw new Error('Missing PayPal normalizer')
      const prepared = await prepareBillingEvents(verified.events, db, runtime.providers)
      await db.transaction(async (tx) => {
        for (const event of verified.events)
          await applyBillingEvent(tx, event, prepared, {
            now: () => new Date(resource.create_time),
          })
      })
    }
    await ingest(first)
    const [initialPayment] = await payments()
    expect(initialPayment).toMatchObject({
      periodStart: new Date(start),
      periodEnd: new Date(firstEnd),
    })
    expect(await grants()).toMatchObject([
      { amount: 1000, expiresAt: new Date('2030-11-12T10:00:00.000Z') },
    ])
    renewed = true
    await ingest(renewal)
    await ingest(first)
    await ingest(renewal)
    const receipts = await payments()
    expect(receipts).toHaveLength(2)
    expect(receipts.find((p) => p.providerPaymentId === first.id)).toMatchObject({
      periodStart: new Date(start),
      periodEnd: new Date(firstEnd),
    })
    expect(receipts.find((p) => p.providerPaymentId === renewal.id)).toMatchObject({
      periodStart: new Date(firstEnd),
      periodEnd: new Date(nextEnd),
    })
    const batches = await grants()
    expect(batches).toHaveLength(2)
    expect(batches.map((g) => g.expiresAt?.toISOString()).sort()).toEqual([
      '2030-11-12T10:00:00.000Z',
      '2030-12-12T10:00:00.000Z',
    ])
    expect(batches.reduce((total, g) => total + g.amount, 0)).toBe(2000)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)),
    ).toHaveLength(2)
  })
  it.each([0, 48])(
    'webhook processing honors %s hours of subscription credit grace',
    async (graceHours) => {
      const event = paid()
      const deliveryId = id()
      const queue = vi.fn(async () => {})
      provider.verifyWebhook = vi.fn(async () => ({
        providerEventId: deliveryId,
        type: 'invoice.paid',
        events: [event],
      }))
      const handler = createBillingEventHandler({
        db,
        providers: { stripe: provider },
        subscriptionCreditGraceHours: graceHours,
        now: () => now,
      })
      try {
        const request = () =>
          processWebhook({
            ...handler,
            db,
            provider,
            request: new Request('https://example.test'),
            rawBody: '{}',
            notify: queue,
          })
        expect(await request()).toMatchObject({ status: 'processed' })
        expect(await request()).toMatchObject({ status: 'duplicate' })
        const [paidReceipt] = await payments()
        expect(await grants()).toMatchObject([
          {
            amount: 10,
            remaining: 10,
            paymentId: paidReceipt?.id,
            expiresAt: new Date(new Date('2030-02-28T12:00:00Z').getTime() + graceHours * 3600000),
          },
        ])
        expect(await grants()).toHaveLength(1)
        expect(queue).toHaveBeenCalledTimes(1)
      } finally {
        await db.delete(webhookEvent).where(eq(webhookEvent.providerEventId, deliveryId))
      }
    },
  )
  it('distinct webhook deliveries for one payment grant once, checkout does not grant', async () => {
    await apply([await checkout()])
    expect(await grants()).toHaveLength(0)
    expect((await subs())[0]).toMatchObject({ currentPeriodStart: null, currentPeriodEnd: null })
    const event = paid()
    const deliveries: string[] = []
    try {
      const options = createBillingEventHandler({
        db,
        providers: { stripe: provider },
        now: () => now,
      })
      await Promise.all(
        [0, 1].map(async () => {
          const delivery = id()
          deliveries.push(delivery)
          const verified = { providerEventId: delivery, type: 'invoice.paid', events: [event] }
          const result = await processWebhook({
            db,
            provider: { ...provider, verifyWebhook: async () => verified },
            request: new Request('https://example.test'),
            rawBody: '{}',
            ...options,
          })
          expect(result.status).toBe('processed')
        }),
      )
      expect(await payments()).toHaveLength(1)
      expect(await grants()).toHaveLength(1)
      expect((await grants())[0]).toMatchObject({
        sourceRef: `${(await payments())[0]?.id}:0`,
        expiresAt: new Date('2030-03-01T12:00:00Z'),
      })
    } finally {
      await db.delete(webhookEvent).where(inArray(webhookEvent.providerEventId, deliveries))
    }
  })
  it('missing metadata renewals repair from remote verified object; existing associations ignore hostile metadata', async () => {
    await apply([paid({ kind: 'renewal' })])
    expect(provider.getSubscription).toHaveBeenCalledTimes(1)
    await apply([
      paid({
        kind: 'renewal',
        metadata: { workspaceId: otherWs, userId: uid, planPriceId: priceId },
      }),
    ])
    expect(provider.getSubscription).toHaveBeenCalledTimes(1)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, otherWs))).toEqual(
      [],
    )
    expect(await grants()).toHaveLength(2)
  })
  it('verified renewal ahead of application time records payment and grants its first month once', async () => {
    await apply([paid()])
    const periodStart = new Date('2030-02-28T12:00:00Z')
    const periodEnd = new Date('2030-03-31T12:00:00Z')
    const event = {
      ...paid({
        kind: 'renewal',
        period: { start: periodStart, end: periodEnd },
        paidAt: periodStart,
      }),
      occurredAt: periodStart,
    }
    const firstDelivery = id()
    const secondDelivery = id()
    const handler = createBillingEventHandler({
      db,
      providers: { stripe: provider },
      now: () => now,
    })
    const request = (deliveryId: string) =>
      processWebhook({
        ...handler,
        db,
        provider: {
          ...provider,
          verifyWebhook: async () => ({
            providerEventId: deliveryId,
            type: 'invoice.paid',
            events: [event],
          }),
        },
        request: new Request('https://example.test'),
        rawBody: '{}',
      })
    try {
      expect(await request(firstDelivery)).toMatchObject({
        status: 'processed',
        delivery: { status: 'processed', error: null },
      })
      expect(await request(firstDelivery)).toMatchObject({ status: 'duplicate' })
      expect(await request(secondDelivery)).toMatchObject({ status: 'processed' })
      const receipts = await payments()
      expect(receipts).toHaveLength(2)
      const renewal = receipts.find((p) => p.kind === 'renewal')
      expect(renewal).toMatchObject({ status: 'succeeded', periodStart, periodEnd })
      const credited = await grants()
      expect(credited).toHaveLength(2)
      expect(credited.filter((g) => g.paymentId === renewal?.id)).toMatchObject([
        {
          sourceRef: `${renewal?.id}:0`,
          amount: 10,
          remaining: 10,
          expiresAt: new Date('2030-04-01T12:00:00Z'),
        },
      ])
      expect((await subs())[0]).toMatchObject({
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })
    } finally {
      await db
        .delete(webhookEvent)
        .where(inArray(webhookEvent.providerEventId, [firstDelivery, secondDelivery]))
    }
  })
  it('older state is ignored but independently valid older payment records without regressing paid period', async () => {
    await apply([paid()])
    await apply([
      {
        provider: 'stripe',
        type: 'subscription.canceled',
        providerSubscriptionId: subId,
        status: 'canceled',
        canceledAt: new Date('2030-02-05'),
        currentPeriodEnd: null,
        occurredAt: new Date('2030-02-05'),
        raw: {},
      },
    ])
    await apply([
      {
        provider: 'stripe',
        type: 'subscription.updated',
        subscription: snapshot,
        occurredAt: new Date('2030-02-01'),
        raw: {},
      },
    ])
    await apply([
      paid({
        kind: 'renewal',
        period: { start: new Date('2029-12-31'), end: new Date('2030-01-31') },
      }),
    ])
    expect((await subs())[0]).toMatchObject({
      status: 'canceled',
      currentPeriodEnd: new Date('2030-02-28T12:00:00Z'),
    })
    expect(await payments()).toHaveLength(2)
    expect(await grants()).toHaveLength(2)
    const logs = await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws))
    const changes = logs.filter((row) => row.action === 'billing.subscription_changed')
    // 创建 + 取消两次关键变更；旧事件与不改变周期的付款不会产生重复审计。
    expect(changes).toHaveLength(2)
    expect(
      changes.find((row) => (row.meta as { source: string }).source === 'subscription.canceled')
        ?.meta,
    ).toMatchObject({
      before: { status: 'active' },
      after: { status: 'canceled' },
    })
  })
  it('late verified invoice uses historical provider price after the local subscription changed price', async () => {
    await apply([paid()])
    const nextPrice = id()
    await db.insert(planPrice).values({
      id: nextPrice,
      planId,
      provider: 'stripe',
      providerPriceId: nextPrice,
      interval: 'month',
      amount: 2000,
      currency: 'USD',
    })
    await apply([
      {
        provider: 'stripe',
        type: 'subscription.updated',
        subscription: { ...snapshot, providerPriceId: nextPrice },
        occurredAt: new Date('2030-02-05'),
        raw: {},
      },
    ])
    await db.update(planPrice).set({ active: false }).where(eq(planPrice.id, priceId))
    const event = paid({ kind: 'renewal' })
    if (event.type !== 'payment.succeeded') throw new Error('Missing payment')
    Object.assign(event.payment, {
      providerPriceId: priceId,
      metadata: { ...metadata(), workspaceId: otherWs },
    })
    await apply([event])
    expect((await payments()).every((p) => p.planPriceId === priceId)).toBe(true)
    expect((await subs())[0]?.planPriceId).toBe(nextPrice)
    expect(await grants()).toHaveLength(2)
  })
  it('adjustment records a prorated payment and activation never grants', async () => {
    await apply([
      {
        provider: 'stripe',
        type: 'subscription.activated',
        subscription: snapshot,
        occurredAt: now,
        raw: {},
      },
    ])
    await apply([paid({ kind: 'adjustment', amount: 137 })])
    expect(await payments()).toHaveLength(1)
    expect(await grants()).toEqual([])
  })
  it('yearly batches preserve anchor and payment provenance; full refund revokes all remaining including held release', async () => {
    await db.update(planPrice).set({ interval: 'year' }).where(eq(planPrice.id, priceId))
    await apply([paid({ period: { start: now, end: new Date('2031-01-31T12:00:00Z') } })])
    const [p] = await payments()
    const [price] = await db.select().from(planPrice).where(eq(planPrice.id, priceId))
    const [selected] = await db.select().from(plan).where(eq(plan.id, planId))
    if (!p || !price || !selected) throw new Error('Missing provenance')
    expect((await grants())[0]?.expiresAt).toEqual(new Date('2030-03-01T12:00:00Z'))
    await expect(
      db.transaction((tx) => grantSubscriptionMonth(tx, p, price, selected, 1, now)),
    ).rejects.toThrow('not due')
    for (let n = 1; n < 12; n++)
      await db.transaction((tx) =>
        grantSubscriptionMonth(tx, p, price, selected, n, subscriptionMonthAnchor(now, n)),
      )
    expect(await grants()).toHaveLength(12)
    expect((await grants()).every((g) => g.paymentId === p.id)).toBe(true)
    const h = await hold(db, {
      workspaceId: ws,
      userId: uid,
      amount: 3,
      refType: 'ai_message',
      refId: id(),
    })
    await capture(db, { workspaceId: ws, holdId: h.id, actualAmount: 2 })
    const outstanding = await hold(db, {
      workspaceId: ws,
      userId: uid,
      amount: 4,
      refType: 'ai_message',
      refId: id(),
    })
    const refund: NormalizedEvent = {
      provider: 'stripe',
      type: 'payment.refunded',
      providerPaymentId: p.providerPaymentId,
      providerRefundId: `refund-${id()}`,
      // 全额退款收回全部剩余；部分退款的比例回收由 credits 生命周期与年付 cron 用例覆盖
      amount: 1000,
      currency: 'USD',
      refundedAmount: null,
      occurredAt: now,
      raw: {},
    }
    await apply([refund])
    await apply([refund])
    await release(db, { workspaceId: ws, holdId: outstanding.id })
    expect((await grants()).every((g) => g.status === 'revoked' && g.remaining === 0)).toBe(true)
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    expect(ledger.filter((l) => l.type === 'revoke').reduce((sum, l) => sum + l.delta, 0)).toBe(
      -118,
    )
    await expect(
      db.transaction((tx) =>
        grantSubscriptionMonth(tx, p, price, selected, 11, new Date('2031-01-01')),
      ),
    ).rejects.toThrow('not eligible')
  })
  it('scheduled annual cancellation keeps prepaid monthly grants until termination', async () => {
    await db.update(planPrice).set({ interval: 'year' }).where(eq(planPrice.id, priceId))
    await apply([paid({ period: { start: now, end: new Date('2031-01-31T12:00:00Z') } })])
    const [p] = await payments()
    const [price] = await db.select().from(planPrice).where(eq(planPrice.id, priceId))
    const [selected] = await db.select().from(plan).where(eq(plan.id, planId))
    if (!p || !price || !selected) throw new Error('Missing provenance')
    await db
      .update(subscription)
      .set({ status: 'canceled', cancelAtPeriodEnd: true })
      .where(eq(subscription.workspaceId, ws))
    await db.transaction((tx) =>
      grantSubscriptionMonth(tx, p, price, selected, 1, subscriptionMonthAnchor(now, 1)),
    )
    expect(await grants()).toHaveLength(2)
    await db
      .update(subscription)
      .set({ cancelAtPeriodEnd: false })
      .where(eq(subscription.workspaceId, ws))
    await expect(
      db.transaction((tx) =>
        grantSubscriptionMonth(tx, p, price, selected, 2, subscriptionMonthAnchor(now, 2)),
      ),
    ).rejects.toThrow('no longer eligible')
  })
  it('a PayPal wallet may pay multiple workspaces and a workspace may change payer', async () => {
    await db.update(planPrice).set({ provider: 'paypal' }).where(eq(planPrice.id, priceId))
    await db
      .insert(member)
      .values({ id: id(), organizationId: otherWs, userId: uid, role: 'owner' })
    const activate = (): NormalizedEvent => ({
      provider: 'paypal',
      type: 'subscription.activated',
      subscription: snapshot,
      occurredAt: now,
      raw: {},
    })
    await apply([activate()])
    snapshot = {
      ...snapshot,
      providerSubscriptionId: id(),
      metadata: { ...metadata(), workspaceId: otherWs },
    }
    await apply([activate()])
    snapshot = { ...snapshot, providerCustomerId: 'another-wallet' }
    await apply([
      {
        ...activate(),
        type: 'subscription.updated',
        occurredAt: new Date('2030-02-01'),
      } as NormalizedEvent,
    ])
    const mappings = await db
      .select()
      .from(billingCustomer)
      .where(inArray(billingCustomer.workspaceId, [ws, otherWs]))
    expect(mappings).toHaveLength(2)
    expect(mappings.every((row) => row.providerCustomerId === null)).toBe(true)
  })
  it('unique partial refund IDs avoid cumulative overcount and snapshot cannot erase local refund', async () => {
    const event = paid()
    await apply([event])
    const [p] = await payments()
    if (!p) throw new Error('missing')
    const r: NormalizedEvent = {
      provider: 'stripe',
      type: 'payment.refunded',
      providerPaymentId: p.providerPaymentId,
      providerRefundId: id(),
      amount: 200,
      currency: 'USD',
      refundedAmount: 200,
      occurredAt: now,
      raw: {},
    }
    await apply([r])
    await apply([r])
    // 比例回收：10 积分的批次在退款 20% 后保留 floor(10 × 0.8) = 8，重放不重复收回
    expect((await grants())[0]).toMatchObject({ amount: 10, remaining: 8, status: 'active' })
    await apply([{ ...r, providerRefundId: id(), amount: 100, refundedAmount: 300 }])
    await apply([event])
    expect((await payments())[0]).toMatchObject({
      refundedAmount: 300,
      status: 'partially_refunded',
    })
    expect((await grants())[0]).toMatchObject({ remaining: 7, status: 'active' })
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)))
        .filter((row) => row.type === 'revoke')
        .map((row) => row.delta)
        .sort((a, b) => a - b),
    ).toEqual([-2, -1])
    expect(
      await db.select().from(paymentRefund).where(eq(paymentRefund.workspaceId, ws)),
    ).toHaveLength(2)
    await expect(apply([{ ...r, amount: 201 }])).rejects.toThrow('replay association')
  })
  it.each([true, false])(
    'one time checkout/payment arrival order %s produces one purchase grant',
    async (checkoutFirst) => {
      await db
        .update(plan)
        .set({ type: 'credit_pack', creditExpiryDays: 365 })
        .where(eq(plan.id, planId))
      await db.update(planPrice).set({ interval: null }).where(eq(planPrice.id, priceId))
      const c = await checkout(true)
      const p = paid({ kind: 'one_time', providerOrderId: orderId, period: null })
      await apply(checkoutFirst ? [c, p] : [p, c])
      await apply([p])
      expect(await payments()).toHaveLength(1)
      expect(await grants()).toHaveLength(1)
      expect((await grants())[0]).toMatchObject({
        source: 'purchase',
        sourceRef: (await payments())[0]?.id,
      })
      expect(
        (await db.select().from(purchase).where(eq(purchase.workspaceId, ws)))[0]?.status,
      ).toBe('paid')
    },
  )
  it('caller rollback undoes association payment credit and ledger together', async () => {
    const event = paid()
    const prepared = await prepareBillingEvents([event], db, { stripe: provider })
    await expect(
      db.transaction(async (tx) => {
        await applyBillingEvent(tx, event, prepared, { now: () => now })
        throw new Error('caller rollback')
      }),
    ).rejects.toThrow('caller rollback')
    expect(await payments()).toEqual([])
    expect(await grants()).toEqual([])
    expect(await subs()).toEqual([])
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).toEqual([])
  })
  it('concurrent second renewing subscription returns compensation info and preserves winner', async () => {
    const first = paid()
    const secondId = `sub-${id()}`
    const second = paid({ providerSubscriptionId: secondId })
    const firstPrepared = await prepareBillingEvents([first], db, { stripe: provider })
    snapshot = { ...snapshot, providerSubscriptionId: secondId }
    const secondPrepared = await prepareBillingEvents([second], db, { stripe: provider })
    const results = await Promise.allSettled([
      db.transaction((tx) => applyBillingEvent(tx, first, firstPrepared, { now: () => now })),
      db.transaction((tx) => applyBillingEvent(tx, second, secondPrepared, { now: () => now })),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected')
    if (failed?.status !== 'rejected') throw new Error('Missing conflict')
    expect(failed.reason).toBeInstanceOf(RenewingSubscriptionConflict)
    expect(failed.reason.compensation).toMatchObject({
      workspaceId: ws,
      planId,
      planPriceId: priceId,
      payment: { amount: 1000, currency: 'USD' },
    })
    expect(await payments()).toHaveLength(1)
    expect(await subs()).toHaveLength(1)
  })
  it('PayPal scheduled pause preserves cancellation intent and paid dates; unexpected pause stays paused', async () => {
    await db.update(planPrice).set({ provider: 'paypal' }).where(eq(planPrice.id, priceId))
    const active: NormalizedEvent = {
      provider: 'paypal',
      type: 'subscription.activated',
      subscription: snapshot,
      occurredAt: now,
      raw: {},
    }
    await apply([active])
    await db
      .update(subscription)
      .set({
        cancelAtPeriodEnd: true,
        currentPeriodStart: now,
        currentPeriodEnd: new Date('2030-02-28T12:00:00Z'),
      })
      .where(eq(subscription.workspaceId, ws))
    const suspended: NormalizedEvent = {
      provider: 'paypal',
      type: 'subscription.updated',
      subscription: {
        ...snapshot,
        status: 'paused',
        remoteStatus: 'SUSPENDED',
        raw: { status: 'SUSPENDED' },
      },
      occurredAt: new Date('2030-02-01'),
      raw: {},
    }
    await apply([suspended])
    expect((await subs())[0]).toMatchObject({
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date('2030-02-28T12:00:00Z'),
      raw: { status: 'SUSPENDED' },
    })
    await apply([{ ...active, occurredAt: new Date('2030-02-02') }])
    expect((await subs())[0]).toMatchObject({ status: 'canceled', cancelAtPeriodEnd: true })
    await db
      .update(subscription)
      .set({ cancelAtPeriodEnd: false })
      .where(eq(subscription.workspaceId, ws))
    await apply([{ ...suspended, occurredAt: new Date('2030-02-03') }])
    expect((await subs())[0]?.status).toBe('paused')
  })
  it('zero credit plans record payment without calling positive-only grant', async () => {
    await db.update(plan).set({ credits: 0 }).where(eq(plan.id, planId))
    await apply([paid()])
    expect(await payments()).toHaveLength(1)
    expect(await grants()).toEqual([])
  })
  it('invalid deleted-workspace payment rolls back its cancellation job and receipt together', async () => {
    await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
    await expect(apply([paid({ amount: 999 })])).rejects.toThrow('price mismatch')
    expect(await subs()).toEqual([])
    expect(await payments()).toEqual([])
    expect(
      await db.select().from(billingCompensation).where(eq(billingCompensation.workspaceId, ws)),
    ).toEqual([])
  })
  it('deleted workspace receipt is preserved without grants; non-member repair is rejected', async () => {
    await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
    await apply([paid()])
    expect(await payments()).toHaveLength(1)
    expect(await grants()).toEqual([])
    expect(
      await db.select().from(billingCompensation).where(eq(billingCompensation.workspaceId, ws)),
    ).toMatchObject([{ key: `deleted:stripe:${subId}`, payload: { reason: 'workspace_deleted' } }])
    subId = `sub-${id()}`
    snapshot = {
      ...snapshot,
      providerSubscriptionId: subId,
      metadata: { ...metadata(), workspaceId: otherWs },
    }
    await expect(apply([paid()])).rejects.toThrow('ineligible')
  })
  it('price amount mismatch rolls back and disputes revoke once', async () => {
    await expect(apply([paid({ amount: 999 })])).rejects.toThrow('price mismatch')
    expect(await subs()).toEqual([])
    await apply([paid()])
    const [p] = await payments()
    if (!p) throw new Error('missing')
    const dispute: NormalizedEvent = {
      provider: 'stripe',
      type: 'payment.disputed',
      providerPaymentId: p.providerPaymentId,
      providerDisputeId: id(),
      amount: 1000,
      currency: 'USD',
      occurredAt: now,
      raw: {},
    }
    await apply([dispute])
    await apply([dispute])
    expect((await payments())[0]?.status).toBe('disputed')
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).filter(
        (l) => l.type === 'revoke',
      ),
    ).toHaveLength(1)
  })
  it('refund callback settles only approved exact identity and amount, preserving review/contact', async () => {
    await apply([paid()])
    const [p] = await payments()
    if (!p) throw new Error('Missing payment')
    const reviewedAt = new Date('2029-12-01')
    const [request] = await db
      .insert(refundRequest)
      .values({
        workspaceId: ws,
        userId: uid,
        paymentId: p.id,
        reason: 'refund',
        contactEmail: 'receipt@example.test',
        status: 'approved',
        approvedAmount: 200,
        providerRefundId: 'approved-refund',
        reviewedAt,
      })
      .returning()
    if (!request) throw new Error('Missing request')
    const r: NormalizedEvent = {
      type: 'payment.refunded',
      provider: 'stripe',
      providerPaymentId: p.providerPaymentId,
      providerRefundId: 'unrelated-refund',
      amount: 200,
      currency: 'USD',
      refundedAmount: null,
      occurredAt: now,
      raw: {},
    }
    await apply([r])
    expect(
      (await db.select().from(refundRequest).where(eq(refundRequest.id, request.id)))[0]?.status,
    ).toBe('approved')
    await apply([{ ...r, providerRefundId: 'approved-refund' }])
    await apply([{ ...r, providerRefundId: 'approved-refund' }])
    expect(
      (await db.select().from(refundRequest).where(eq(refundRequest.id, request.id)))[0],
    ).toMatchObject({
      status: 'refunded',
      contactEmail: 'receipt@example.test',
      reviewedAt,
      updatedAt: now,
    })
  })
  it('an unknown refund before the paid receipt remains explicitly retryable', async () => {
    await expect(
      apply([
        {
          type: 'payment.refunded',
          provider: 'stripe',
          providerPaymentId: 'unknown',
          providerRefundId: id(),
          amount: 100,
          currency: 'USD',
          refundedAmount: null,
          occurredAt: now,
          raw: {},
        },
      ]),
    ).rejects.toThrow('Payment association not found')
  })
  it('retired stable price still records renewal; deleted workspace stops annual primitive', async () => {
    await apply([paid()])
    await db
      .update(planPrice)
      .set({ active: false, interval: 'year' })
      .where(eq(planPrice.id, priceId))
    await apply([paid({ kind: 'renewal' })])
    expect(await payments()).toHaveLength(2)
    await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
    const [p] = await payments()
    const [price] = await db.select().from(planPrice).where(eq(planPrice.id, priceId))
    const [selected] = await db.select().from(plan).where(eq(plan.id, planId))
    if (!p || !price || !selected) throw new Error('Missing provenance')
    const previous = await grants()
    await db.transaction((tx) => grantSubscriptionMonth(tx, p, price, selected, 0, now))
    expect(await grants()).toHaveLength(previous.length)
    await apply([paid({ kind: 'renewal' })])
    expect(await payments()).toHaveLength(3)
    expect(await grants()).toHaveLength(previous.length)
  })
})
