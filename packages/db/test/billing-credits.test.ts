import { env } from 'cloudflare:workers'
import { isUuidV7, newId } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  billingCustomer,
  createDb,
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  organization,
  payment,
  paymentRefund,
  plan,
  planPrice,
  purchase,
  refundRequest,
  scoped,
  subscription,
  user,
  webhookEvent,
} from '../src/index.ts'

const open = () => createDb(env.HYPERDRIVE)
const features = {
  models: ['*'],
  maxConcurrentTasks: 1,
  maxSeats: 1,
  storageGb: 1,
  publicApi: false,
  priorityQueue: false,
  watermark: true,
}
const now = new Date()
const periodEnd = new Date(now.getTime() + 30 * 86_400_000)

async function pgCode(promise: PromiseLike<unknown>) {
  try {
    await promise
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code
  }
  throw new Error('expected SQL constraint rejection')
}

async function seed() {
  const db = open()
  const ws = newId()
  const otherWs = newId()
  const userId = newId()
  await db.insert(user).values({ id: userId, name: 'Billing', email: `${userId}@example.test` })
  await db.insert(organization).values([
    { id: ws, name: 'Billing', slug: ws },
    { id: otherWs, name: 'Other', slug: otherWs },
  ])
  const [p] = await db
    .insert(plan)
    .values({ key: ws, name: 'pro', type: 'subscription', credits: 100, features })
    .returning()
  if (!p) throw new Error('plan seed failed')
  const [price] = await db
    .insert(planPrice)
    .values({
      planId: p.id,
      provider: 'stripe',
      providerPriceId: ws,
      interval: 'month',
      amount: 1000,
      currency: 'usd',
    })
    .returning()
  if (!price) throw new Error('price seed failed')
  const sub = {
    workspaceId: ws,
    planId: p.id,
    planPriceId: price.id,
    provider: 'stripe' as const,
    providerSubscriptionId: ws,
    status: 'active' as const,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    lastEventAt: now,
  }
  const [s] = await db.insert(subscription).values(sub).returning()
  if (!s) throw new Error('subscription seed failed')
  const pay = {
    workspaceId: ws,
    provider: 'stripe' as const,
    providerPaymentId: ws,
    subscriptionId: s.id,
    kind: 'initial' as const,
    amount: 1000,
    currency: 'usd',
    paidAt: now,
  }
  const [paid] = await db.insert(payment).values(pay).returning()
  if (!paid) throw new Error('payment seed failed')
  return {
    ws,
    otherWs,
    userId,
    planId: p.id,
    priceId: price.id,
    subId: s.id,
    paymentId: paid.id,
    sub,
    pay,
  }
}

type Fixture = Awaited<ReturnType<typeof seed>>
let f: Fixture
beforeEach(async () => {
  f = await seed()
})
afterEach(async () => {
  const db = open()
  const holds = await db
    .select({ id: creditHold.id })
    .from(creditHold)
    .where(eq(creditHold.workspaceId, f.ws))
  for (const h of holds)
    await db.delete(creditHoldAllocation).where(eq(creditHoldAllocation.holdId, h.id))
  await db.delete(creditLedger).where(eq(creditLedger.workspaceId, f.ws))
  await db.delete(creditHold).where(eq(creditHold.workspaceId, f.ws))
  await db.delete(creditDebt).where(eq(creditDebt.workspaceId, f.ws))
  await db.delete(creditGrant).where(eq(creditGrant.workspaceId, f.ws))
  await db.delete(refundRequest).where(eq(refundRequest.workspaceId, f.ws))
  await db.delete(paymentRefund).where(eq(paymentRefund.workspaceId, f.ws))
  await db.delete(payment).where(eq(payment.workspaceId, f.ws))
  await db.delete(purchase).where(eq(purchase.workspaceId, f.ws))
  await db.delete(subscription).where(eq(subscription.workspaceId, f.ws))
  await db.delete(billingCustomer).where(eq(billingCustomer.workspaceId, f.ws))
  await db.delete(webhookEvent).where(eq(webhookEvent.providerEventId, f.ws))
  await db.delete(planPrice).where(eq(planPrice.id, f.priceId))
  await db.delete(plan).where(eq(plan.id, f.planId))
  await db.delete(organization).where(eq(organization.id, f.ws))
  await db.delete(organization).where(eq(organization.id, f.otherWs))
  await db.delete(user).where(eq(user.id, f.userId))
})

describe('billing and credit schema constraints on isolated Postgres', () => {
  it('deduplicates refund identity across deliveries but permits a second partial refund', async () => {
    const db = open()
    const refund = {
      workspaceId: f.ws,
      paymentId: f.paymentId,
      provider: 'stripe' as const,
      providerRefundId: newId(),
      amount: 100,
      currency: 'usd',
    }
    await db.insert(paymentRefund).values(refund)
    expect(await pgCode(db.insert(paymentRefund).values(refund))).toBe('23505')
    await db.insert(paymentRefund).values({ ...refund, providerRefundId: newId() })
    expect(await scoped(db, f.ws).count(paymentRefund)).toBe(2)
  })

  it('retains historical payment periods and rejects incomplete or reversed periods', async () => {
    const db = open()
    const historical = {
      ...f.pay,
      providerPaymentId: newId(),
      planPriceId: f.priceId,
      periodStart: now,
      periodEnd,
    }
    await db.insert(payment).values(historical)
    expect(
      await pgCode(
        db.insert(payment).values({ ...historical, providerPaymentId: newId(), periodEnd: null }),
      ),
    ).toBe('23514')
    expect(
      await pgCode(
        db.insert(payment).values({ ...historical, providerPaymentId: newId(), periodEnd: now }),
      ),
    ).toBe('23514')
  })

  it('blocks a second renewing subscription across all renewable statuses, allows paid-period overlap', async () => {
    const db = open()
    for (const status of ['trialing', 'active', 'past_due', 'paused'] as const) {
      expect(
        await pgCode(
          db.insert(subscription).values({ ...f.sub, status, providerSubscriptionId: newId() }),
        ),
      ).toBe('23505')
    }
    await db
      .update(subscription)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscription.id, f.subId))
    await db.insert(subscription).values({ ...f.sub, providerSubscriptionId: newId() })
    expect(await scoped(db, f.ws).count(subscription)).toBe(2)
  })

  it('allows only one pending refund per payment, retains rejected history', async () => {
    const db = open()
    const request = {
      workspaceId: f.ws,
      userId: f.userId,
      paymentId: f.paymentId,
      reason: 'Unused',
    }
    const [r] = await db.insert(refundRequest).values(request).returning()
    expect(await pgCode(db.insert(refundRequest).values(request))).toBe('23505')
    await db
      .update(refundRequest)
      .set({ status: 'rejected' })
      .where(eq(refundRequest.id, r?.id ?? ''))
    await db.insert(refundRequest).values(request)
    expect(await scoped(db, f.ws).count(refundRequest)).toBe(2)
  })

  it('deduplicates payments, webhook deliveries and grant source references', async () => {
    const db = open()
    expect(await pgCode(db.insert(payment).values(f.pay))).toBe('23505')
    const delivery = {
      provider: 'stripe' as const,
      providerEventId: f.ws,
      type: 'invoice.paid',
      payload: { id: f.ws },
    }
    await db.insert(webhookEvent).values(delivery)
    expect(await pgCode(db.insert(webhookEvent).values(delivery))).toBe('23505')
    const grant = {
      workspaceId: f.ws,
      source: 'subscription' as const,
      sourceRef: `${f.paymentId}:0`,
      paymentId: f.paymentId,
      amount: 100,
      remaining: 100,
    }
    await db.insert(creditGrant).values(grant)
    expect(await pgCode(db.insert(creditGrant).values(grant))).toBe('23505')
    await db.insert(creditGrant).values({ ...grant, sourceRef: `${f.paymentId}:1` })
  })

  it('subscription adjustments require a subscription association', async () => {
    const db = open()
    await db.insert(payment).values({
      ...f.pay,
      kind: 'adjustment',
      providerPaymentId: newId(),
    })
    expect(
      await pgCode(
        db.insert(payment).values({
          ...f.pay,
          kind: 'adjustment',
          providerPaymentId: newId(),
          subscriptionId: null,
        }),
      ),
    ).toBe('23514')
  })

  it('deduplicates customer, price and one-time order mappings', async () => {
    const db = open()
    const customer = { workspaceId: f.ws, provider: 'stripe' as const, providerCustomerId: f.ws }
    await db.insert(billingCustomer).values(customer)
    expect(await pgCode(db.insert(billingCustomer).values(customer))).toBe('23505')
    expect(
      await pgCode(
        db.insert(planPrice).values({
          planId: f.planId,
          provider: 'stripe',
          providerPriceId: f.ws,
          amount: 1000,
          currency: 'usd',
        }),
      ),
    ).toBe('23505')
    const order = {
      workspaceId: f.ws,
      userId: f.userId,
      planId: f.planId,
      planPriceId: f.priceId,
      provider: 'stripe' as const,
      providerOrderId: f.ws,
      amount: 1000,
      currency: 'usd',
    }
    await db.insert(purchase).values(order)
    expect(await pgCode(db.insert(purchase).values(order))).toBe('23505')
  })

  it('all new foreign keys physically use RESTRICT', async () => {
    const rows = await open().execute(
      sql`select c.confdeltype from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public' and c.contype = 'f' and t.relname in ('plan_price', 'billing_customer', 'subscription', 'purchase', 'payment', 'refund_request', 'credit_grant', 'credit_hold', 'credit_hold_allocation', 'credit_ledger', 'credit_debt')`,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.confdeltype === 'r')).toBe(true)
  })

  it('rejects negative money, excessive refunds and invalid grant/hold/debt balances', async () => {
    const db = open()
    expect(
      await pgCode(
        db.insert(planPrice).values({
          planId: f.planId,
          provider: 'paypal',
          providerPriceId: newId(),
          amount: -1,
          currency: 'usd',
        }),
      ),
    ).toBe('23514')
    expect(
      await pgCode(
        db.update(payment).set({ refundedAmount: 1001 }).where(eq(payment.id, f.paymentId)),
      ),
    ).toBe('23514')
    const grant = {
      workspaceId: f.ws,
      source: 'admin' as const,
      sourceRef: f.ws,
      amount: 10,
      remaining: -1,
    }
    expect(await pgCode(db.insert(creditGrant).values(grant))).toBe('23514')
    expect(await pgCode(db.insert(creditGrant).values({ ...grant, remaining: 11 }))).toBe('23514')
    expect(
      await pgCode(
        db.insert(creditHold).values({
          workspaceId: f.ws,
          userId: f.userId,
          amount: 10,
          refType: 'ai_task',
          refId: newId(),
          overageDebt: -1,
        }),
      ),
    ).toBe('23514')
    expect(await pgCode(db.insert(creditDebt).values({ workspaceId: f.ws, amount: -1 }))).toBe(
      '23514',
    )
  })

  it('retains FK-referenced financial records and rejects nonexistent references', async () => {
    const db = open()
    await db.insert(creditGrant).values({
      workspaceId: f.ws,
      source: 'subscription',
      sourceRef: f.ws,
      paymentId: f.paymentId,
      amount: 10,
      remaining: 10,
    })
    expect(await pgCode(db.delete(payment).where(eq(payment.id, f.paymentId)))).toBe('23503')
    expect(await pgCode(db.delete(subscription).where(eq(subscription.id, f.subId)))).toBe('23503')
    expect(await pgCode(db.delete(planPrice).where(eq(planPrice.id, f.priceId)))).toBe('23503')
    expect(await pgCode(db.delete(organization).where(eq(organization.id, f.ws)))).toBe('23503')
    expect(
      await pgCode(
        db
          .insert(refundRequest)
          .values({ workspaceId: f.ws, userId: f.userId, paymentId: newId(), reason: 'bad' }),
      ),
    ).toBe('23503')
  })

  it('round-trips UUIDv7/timestamptz and scopes new financial tables including debt', async () => {
    const db = open()
    const [grant] = await scoped(db, f.ws)
      .insert(creditGrant, {
        source: 'admin',
        sourceRef: f.ws,
        amount: 10,
        remaining: 10,
        expiresAt: periodEnd,
      })
      .returning()
    if (!grant) throw new Error('grant seed failed')
    expect(isUuidV7(grant.id)).toBe(true)
    expect(grant.expiresAt).toEqual(periodEnd)
    expect(grant.createdAt).toBeInstanceOf(Date)
    await scoped(db, f.ws).insert(creditDebt, { amount: 5 })
    const own = scoped(db, f.ws)
    const other = scoped(db, f.otherWs)
    for (const table of [subscription, payment, creditGrant, creditDebt]) {
      expect(await own.count(table)).toBe(1)
      expect(await other.count(table)).toBe(0)
    }
    await expect(other.findById(creditGrant, grant.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('allocates once per hold/grant and permits signed ledger deltas', async () => {
    const db = open()
    const [g] = await db
      .insert(creditGrant)
      .values({ workspaceId: f.ws, source: 'admin', sourceRef: f.ws, amount: 10, remaining: 0 })
      .returning()
    const [h] = await db
      .insert(creditHold)
      .values({
        workspaceId: f.ws,
        userId: f.userId,
        amount: 10,
        refType: 'ai_task',
        refId: newId(),
      })
      .returning()
    if (!g || !h) throw new Error('allocation seed failed')
    const alloc = { holdId: h.id, grantId: g.id, amount: 10 }
    await db.insert(creditHoldAllocation).values(alloc)
    expect(await pgCode(db.insert(creditHoldAllocation).values(alloc))).toBe('23505')
    expect(await pgCode(db.delete(creditGrant).where(eq(creditGrant.id, g.id)))).toBe('23503')
    await db
      .insert(creditLedger)
      .values({ workspaceId: f.ws, grantId: g.id, delta: -10, type: 'consume' })
  })
})
