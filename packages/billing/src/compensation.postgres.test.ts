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
import { createCompensationFailureHandler, runPendingCompensations } from './compensation.ts'
import { applyBillingEvent, createBillingEventHandler, prepareBillingEvents } from './events.ts'
import { processWebhook } from './pipeline.ts'
import type {
  NormalizedEvent,
  PaymentProvider,
  PaymentSnapshot,
  SubscriptionSnapshot,
} from './provider.ts'

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
let deliveryIds: string[] = []
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
beforeEach(async () => {
  deliveryIds = []
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
    capabilities: {
      refundsViaApi: true,
      portal: false,
      changePlan: false,
      merchantOfRecord: false,
    },
    cancelSubscription: vi.fn(async () => {}),
    refund: vi.fn(async () => ({ providerRefundId: 'refund-compensated' })),
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
  if (deliveryIds.length)
    await db.delete(webhookEvent).where(inArray(webhookEvent.providerEventId, deliveryIds))
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
async function deliver(event: NormalizedEvent, deliveryId = id()) {
  deliveryIds.push(deliveryId)
  const options = createBillingEventHandler({ db, providers: { stripe: provider }, now: () => now })
  const normalized = { providerEventId: deliveryId, type: event.type, events: [event] }
  provider.verifyWebhook = vi.fn(async () => normalized)
  const result = await processWebhook({
    ...options,
    db,
    provider,
    request: new Request('https://example.test'),
    rawBody: '{}',
    onFailure: createCompensationFailureHandler(db),
  })
  return { result, deliveryId }
}
const jobs = () =>
  db.select().from(billingCompensation).where(eq(billingCompensation.workspaceId, ws))
describe('durable concurrent subscription compensation', () => {
  it.each(['activation', 'payment'] as const)(
    'deleted workspace %s queues one cancel-only job, retries and never revives or refunds on late payments',
    async (first) => {
      await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
      await db.delete(member).where(eq(member.organizationId, ws))
      const activation: NormalizedEvent = {
        provider: 'stripe',
        type: 'subscription.activated',
        occurredAt: now,
        raw: {},
        subscription: snapshot,
      }
      const event = first === 'activation' ? activation : paid()
      const initial = await deliver(event)
      expect(initial.result.status).toBe('processed')
      expect((await deliver(event, initial.deliveryId)).result.status).toBe('duplicate')
      expect((await deliver(event)).result.status).toBe('processed')
      const [job] = await jobs()
      expect(await jobs()).toHaveLength(1)
      expect(job).toMatchObject({
        key: `deleted:stripe:${subId}`,
        payload: { reason: 'workspace_deleted', providerSubscriptionId: subId },
      })
      expect(job?.payload).not.toHaveProperty('winnerSubscriptionId')
      expect(job?.payload).not.toHaveProperty('payment')
      vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('cancel unavailable'))
      expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
        failed: 1,
        completed: 0,
      })
      expect((await jobs())[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        error: 'cancel unavailable',
      })
      expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
        completed: 1,
        failed: 0,
      })
      expect(provider.cancelSubscription).toHaveBeenLastCalledWith(subId, { atPeriodEnd: false })
      const renewal = paid({ kind: 'renewal', refundedAmount: 200 })
      expect((await deliver(renewal)).result.status).toBe('processed')
      expect((await deliver(renewal)).result.status).toBe('processed')
      expect((await deliver(activation)).result.status).toBe('processed')
      expect(await jobs()).toHaveLength(1)
      expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
        claimed: 0,
      })
      expect(provider.refund).not.toHaveBeenCalled()
      expect(await grants()).toEqual([])
      expect(await subs()).toMatchObject([
        { status: 'canceled', cancelAtPeriodEnd: false, currentPeriodEnd: null, raw: snapshot.raw },
      ])
      expect(await payments()).toHaveLength(first === 'payment' ? 2 : 1)
      expect((await payments()).find((p) => p.kind === 'renewal')).toMatchObject({
        amount: 1000,
        refundedAmount: 200,
      })
      expect((await jobs())[0]).toMatchObject({
        status: 'completed',
        attempts: 2,
        cancelCompleted: true,
        providerRefundId: null,
      })
    },
  )
  it.each(['SUSPENDED', 'CANCELLED', 'EXPIRED'])(
    'deleted PayPal subscription checks real %s status before immediate cancellation',
    async (remoteStatus) => {
      await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
      await db.update(planPrice).set({ provider: 'paypal' }).where(eq(planPrice.id, priceId))
      provider = { ...provider, id: 'paypal' }
      snapshot = { ...snapshot, status: 'canceled', remoteStatus }
      await apply([
        {
          provider: 'paypal',
          type: 'subscription.activated',
          occurredAt: now,
          raw: snapshot.raw,
          subscription: snapshot,
        },
      ])
      expect(await runPendingCompensations({ db, providers: { paypal: provider } })).toMatchObject({
        completed: 1,
      })
      expect(provider.getSubscription).toHaveBeenCalledTimes(1)
      if (remoteStatus === 'SUSPENDED')
        expect(provider.cancelSubscription).toHaveBeenCalledWith(subId, { atPeriodEnd: false })
      else expect(provider.cancelSubscription).not.toHaveBeenCalled()
      expect(provider.refund).not.toHaveBeenCalled()
    },
  )
  it('concurrent winner/loser preserves winner, refunds actual payment once and webhook settles without loser grants', async () => {
    const first = paid()
    const secondId = `sub-${id()}`
    const second = paid({ providerSubscriptionId: secondId })
    provider.getSubscription = vi.fn(async (remoteId) => ({
      ...snapshot,
      providerSubscriptionId: remoteId,
    }))
    const handler = createBillingEventHandler({
      db,
      providers: { stripe: provider },
      now: () => now,
    })
    const send = async (event: NormalizedEvent) => {
      const deliveryId = id()
      deliveryIds.push(deliveryId)
      const adapter = {
        ...provider,
        verifyWebhook: vi.fn(async () => ({
          providerEventId: deliveryId,
          type: event.type,
          events: [event],
        })),
      }
      return processWebhook({
        ...handler,
        db,
        provider: adapter,
        request: new Request('https://example.test'),
        rawBody: '{}',
        onFailure: createCompensationFailureHandler(db),
      })
    }
    const results = await Promise.all([send(first), send(second)])
    expect(results.map((r) => r.status).sort()).toEqual(['failed', 'processed'])
    const [job] = await jobs()
    if (!job?.payload.payment) throw new Error('Missing compensation')
    const loser = [first, second].find(
      (e) =>
        e.type === 'payment.succeeded' &&
        e.payment.providerPaymentId === job.payload.payment?.providerPaymentId,
    )
    if (loser?.type !== 'payment.succeeded') throw new Error('Missing loser')
    provider.getPayment = vi.fn(async () => loser.payment)
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect(provider.cancelSubscription).toHaveBeenCalledWith(job.payload.providerSubscriptionId, {
      atPeriodEnd: false,
    })
    expect(provider.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1000,
        kind: 'initial',
        idempotencyKey: `compensation:${job.id}`,
      }),
    )
    expect((await jobs())[0]).toMatchObject({
      status: 'completed',
      providerRefundId: 'refund-compensated',
    })
    expect(
      (await payments()).find((p) => p.providerPaymentId === loser.payment.providerPaymentId),
    ).toMatchObject({ status: 'succeeded', refundedAmount: 0 })
    expect((await deliver(loser)).result.status).toBe('processed')
    expect(await grants()).toHaveLength(1)
    const refund: NormalizedEvent = {
      provider: 'stripe',
      type: 'payment.refunded',
      occurredAt: now,
      raw: {},
      providerPaymentId: loser.payment.providerPaymentId,
      providerRefundId: 'refund-compensated',
      amount: 1000,
      currency: 'USD',
      refundedAmount: 1000,
    }
    await apply([refund, refund])
    expect(
      (await payments()).find((p) => p.providerPaymentId === loser.payment.providerPaymentId)
        ?.status,
    ).toBe('refunded')
    expect(
      (await subs()).find((s) => s.providerSubscriptionId === job.payload.providerSubscriptionId),
    ).toMatchObject({ status: 'canceled', currentPeriodEnd: null })
    expect((await subs()).filter((s) => s.status === 'active')).toHaveLength(1)
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      claimed: 0,
    })
    expect(provider.refund).toHaveBeenCalledTimes(1)
  })
  it('checkout conflict before paid cancels, later paid creates durable refund and retry reuses its identity', async () => {
    await apply([paid()])
    subId = `sub-${id()}`
    snapshot = { ...snapshot, providerSubscriptionId: subId }
    const checkout: NormalizedEvent = {
      provider: 'stripe',
      type: 'checkout.completed',
      occurredAt: now,
      raw: {},
      providerCheckoutId: id(),
      providerCustomerId: `customer-${ws}`,
      metadata: metadata(),
      mode: 'subscription',
      providerSubscriptionId: subId,
    }
    const initial = await deliver(checkout)
    expect(initial.result.status).toBe('failed')
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      completed: 1,
    })
    expect((await deliver(checkout, initial.deliveryId)).result.status).toBe('processed')
    expect(provider.refund).not.toHaveBeenCalled()
    const event = paid()
    if (event.type !== 'payment.succeeded') throw new Error('Missing payment')
    provider.getPayment = vi.fn(async () => event.payment)
    expect((await deliver(event)).result.status).toBe('failed')
    if (!provider.refund) throw new Error('Missing refund adapter')
    vi.mocked(provider.refund).mockRejectedValueOnce(new Error('temporary refund outage'))
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      failed: 1,
    })
    const refundJob = (await jobs()).find((j) => j.payload.payment)
    expect(refundJob).toMatchObject({
      status: 'pending',
      cancelCompleted: true,
      error: 'temporary refund outage',
    })
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      completed: 1,
    })
    expect(vi.mocked(provider.refund).mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
      `compensation:${refundJob?.id}`,
      `compensation:${refundJob?.id}`,
    ])
    expect((await deliver(event)).result.status).toBe('processed')
    expect(await grants()).toHaveLength(1)
  })
  it('recovers a lost refund response before the identity checkpoint from a fresh remote snapshot', async () => {
    await apply([paid()])
    const winner = (await subs())[0]
    subId = `sub-${id()}`
    snapshot = { ...snapshot, providerSubscriptionId: subId }
    const event = paid()
    if (event.type !== 'payment.succeeded') throw new Error('Missing payment')
    expect((await deliver(event)).result.status).toBe('failed')
    let externallyRefunded = 0
    provider.getPayment = vi.fn(
      async (): Promise<PaymentSnapshot> => ({
        ...event.payment,
        refundedAmount: externallyRefunded,
        status: externallyRefunded ? 'refunded' : 'succeeded',
      }),
    )
    if (!provider.refund) throw new Error('Missing refund adapter')
    vi.mocked(provider.refund).mockImplementationOnce(async (input) => {
      expect(input.amount).toBe(1000)
      externallyRefunded = 1000
      throw new Error('response lost after provider settlement')
    })
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      failed: 1,
      completed: 0,
    })
    const [job] = await jobs()
    if (!job) throw new Error('Missing compensation')
    expect(job).toMatchObject({ status: 'pending', providerRefundId: null, cancelCompleted: true })
    expect(externallyRefunded).toBe(1000)
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect(provider.getPayment).toHaveBeenCalledTimes(2)
    expect(provider.refund).toHaveBeenCalledTimes(1)
    expect((await jobs())[0]).toMatchObject({ status: 'completed', providerRefundId: null })
    // Remote recovery completes compensation, but only a verified refund event settles locally.
    expect(
      (await payments()).find((p) => p.providerPaymentId === event.payment.providerPaymentId),
    ).toMatchObject({ status: 'succeeded', refundedAmount: 0 })
    expect(await db.select().from(paymentRefund).where(eq(paymentRefund.workspaceId, ws))).toEqual(
      [],
    )
    expect((await deliver(event)).result.status).toBe('processed')
    expect(await grants()).toHaveLength(1)
    expect((await subs()).find((s) => s.id === winner?.id)).toMatchObject({ status: 'active' })
    expect((await subs()).find((s) => s.providerSubscriptionId === subId)).toMatchObject({
      status: 'canceled',
      currentPeriodEnd: null,
    })
    expect(await runPendingCompensations({ db, providers: { stripe: provider } })).toMatchObject({
      claimed: 0,
    })
    expect(provider.refund).toHaveBeenCalledTimes(1)
  })
  it('expired crash lease is atomically reclaimed and durable API identity prevents another refund', async () => {
    await apply([paid()])
    subId = `sub-${id()}`
    snapshot = { ...snapshot, providerSubscriptionId: subId, status: 'canceled' }
    // The initial conflict is observed while the remote subscription is still active.
    snapshot.status = 'active'
    const event = paid()
    if (event.type !== 'payment.succeeded') throw new Error('Missing payment')
    await deliver(event)
    const [job] = await jobs()
    if (!job) throw new Error('Missing job')
    const clock = new Date('2031-01-01')
    await db
      .update(billingCompensation)
      .set({ status: 'processing', leaseUntil: new Date('2030-01-01'), attempts: 1 })
      .where(eq(billingCompensation.id, job.id))
    snapshot.status = 'canceled'
    provider.getPayment = vi.fn(async () => event.payment)
    const runs = await Promise.all([
      runPendingCompensations({ db, providers: { stripe: provider }, now: () => clock }),
      runPendingCompensations({ db, providers: { stripe: provider }, now: () => clock }),
    ])
    expect(runs.reduce((sum, run) => sum + run.claimed, 0)).toBe(1)
    expect(provider.cancelSubscription).not.toHaveBeenCalled()
    expect(provider.refund).toHaveBeenCalledTimes(1)
    // Crash after durable refund checkpoint, before completion; no second API refund.
    await db
      .update(billingCompensation)
      .set({ status: 'processing', leaseUntil: new Date('2030-01-01') })
      .where(eq(billingCompensation.id, job.id))
    expect(
      await runPendingCompensations({ db, providers: { stripe: provider }, now: () => clock }),
    ).toMatchObject({ completed: 1 })
    expect(provider.refund).toHaveBeenCalledTimes(1)
    expect((await jobs())[0]?.attempts).toBe(3)
  })
  it('missing provider remains durable and alerts instead of silently completing', async () => {
    await apply([paid()])
    subId = `sub-${id()}`
    snapshot = { ...snapshot, providerSubscriptionId: subId }
    const event = paid()
    const initial = await deliver(event)
    expect(initial.result.status).toBe('failed')
    await deliver(event, initial.deliveryId)
    expect(await jobs()).toHaveLength(1)
    expect(await runPendingCompensations({ db, providers: {} })).toMatchObject({
      failed: 1,
      completed: 0,
    })
    expect((await jobs())[0]).toMatchObject({
      status: 'pending',
      error: 'Missing compensation billing provider',
    })
    expect(
      (await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws))).some(
        (a) => a.action === 'billing.subscription_compensation_failed',
      ),
    ).toBe(true)
    expect(await grants()).toHaveLength(1)
  })
  it('whole multi-event delivery eventually processes and duplicate replay never reactivates loser', async () => {
    await apply([paid()])
    subId = `sub-${id()}`
    snapshot = { ...snapshot, providerSubscriptionId: subId }
    const event = paid()
    if (event.type !== 'payment.succeeded') throw new Error('Missing payment')
    const checkout: NormalizedEvent = {
      provider: 'stripe',
      type: 'checkout.completed',
      occurredAt: now,
      raw: {},
      providerCheckoutId: id(),
      providerCustomerId: `customer-${ws}`,
      metadata: metadata(),
      mode: 'subscription',
      providerSubscriptionId: subId,
    }
    const deliveryId = id()
    deliveryIds.push(deliveryId)
    const options = createBillingEventHandler({
      db,
      providers: { stripe: provider },
      now: () => now,
    })
    provider.verifyWebhook = vi.fn(async () => ({
      providerEventId: deliveryId,
      type: 'checkout-and-paid',
      events: [checkout, event],
    }))
    provider.getPayment = vi.fn(async () => event.payment)
    const send = () =>
      processWebhook({
        ...options,
        db,
        provider,
        request: new Request('https://example.test'),
        rawBody: '{}',
        onFailure: createCompensationFailureHandler(db),
      })
    expect((await send()).status).toBe('failed')
    expect((await send()).status).toBe('failed')
    expect(await jobs()).toHaveLength(2)
    expect((await send()).status).toBe('processed')
    expect((await send()).status).toBe('duplicate')
    await runPendingCompensations({ db, providers: { stripe: provider } })
    expect(await grants()).toHaveLength(1)
    expect((await subs()).find((s) => s.providerSubscriptionId === subId)).toMatchObject({
      status: 'canceled',
      currentPeriodEnd: null,
    })
  })
})
