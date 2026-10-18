import { getCreditBalance, grant, hold, release } from '@product-res/credits'
import {
  auditLog,
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
  plan,
  planPrice,
  refundRequest,
  subscription,
  user,
} from '@product-res/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearResolvedRefundContacts,
  registerHoldSweeper,
  runAnnualGrants,
  runCreditExpiration,
  runCreditReconciliation,
  runHoldSweep,
  runSubscriptionReconciliation,
} from './cron.ts'
import { subscriptionMonthAnchor } from './events.ts'
import type { PaymentProvider, SubscriptionSnapshot } from './provider.ts'

const testEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
const url = testEnv.BILLING_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: url })
// audit_log 对 app 只追加（@product-res/db 迁移 0009），审计行由 migrator 清理
const migrator = createDb({ connectionString: testEnv.MIGRATION_DATABASE_URL ?? '' })
const id = () => crypto.randomUUID()
let ws: string, uid: string, pid: string, price: string, sid: string, paid: string
let now: Date, start: Date, end: Date
const disposers: (() => void)[] = []
beforeEach(async () => {
  ws = id()
  uid = id()
  pid = id()
  price = id()
  sid = id()
  paid = id()
  now = new Date()
  // The previous month is elapsed in both injected and PostgreSQL clocks.
  start = subscriptionMonthAnchor(now, -2)
  end = subscriptionMonthAnchor(start, 12)
  await db.insert(user).values({ id: uid, name: 'Cron', email: `${uid}@example.test` })
  await db.insert(organization).values({ id: ws, name: 'Cron', slug: ws })
  await db.insert(member).values({ id: id(), userId: uid, organizationId: ws, role: 'owner' })
  await db.insert(plan).values({
    id: pid,
    key: pid,
    name: 'Cron',
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
    id: price,
    planId: pid,
    provider: 'stripe',
    providerPriceId: price,
    interval: 'year',
    amount: 1000,
    currency: 'USD',
  })
  await db.insert(subscription).values({
    id: sid,
    workspaceId: ws,
    planId: pid,
    planPriceId: price,
    provider: 'stripe',
    providerSubscriptionId: sid,
    status: 'active',
    currentPeriodStart: start,
    currentPeriodEnd: end,
    lastEventAt: start,
  })
  await db.insert(payment).values({
    id: paid,
    workspaceId: ws,
    subscriptionId: sid,
    planPriceId: price,
    provider: 'stripe',
    providerPaymentId: paid,
    kind: 'initial',
    status: 'succeeded',
    amount: 1000,
    currency: 'USD',
    periodStart: start,
    periodEnd: end,
    paidAt: start,
  })
})
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  const holds = await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))
  if (holds.length)
    await db.delete(creditHoldAllocation).where(
      inArray(
        creditHoldAllocation.holdId,
        holds.map((h) => h.id),
      ),
    )
  for (const table of [
    creditLedger,
    creditHold,
    creditGrant,
    creditDebt,
    refundRequest,
    payment,
    subscription,
    billingCustomer,
  ])
    await db.delete(table).where(eq(table.workspaceId, ws))
  await migrator.delete(auditLog).where(eq(auditLog.workspaceId, ws))
  await db.delete(member).where(eq(member.organizationId, ws))
  await db.delete(organization).where(eq(organization.id, ws))
  await db.delete(user).where(eq(user.id, uid))
  await db.delete(planPrice).where(eq(planPrice.planId, pid))
  await db.delete(plan).where(eq(plan.id, pid))
})
afterAll(() => Promise.all([db.$client.end(), migrator.$client.end()]))
const grants = () => db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
const ledger = () => db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
const scopedFailures = (result: { failures: { workspaceId: string }[] }) =>
  result.failures.filter((f) => f.workspaceId === ws)

describe('billing cron on isolated PostgreSQL', () => {
  it('uses historical annual price and retained cancellation; expires late months and repeats without extra ledger', async () => {
    const changed = id()
    await db.insert(planPrice).values({
      id: changed,
      planId: pid,
      provider: 'stripe',
      providerPriceId: changed,
      interval: 'month',
      amount: 2000,
      currency: 'USD',
    })
    await db.update(planPrice).set({ active: false }).where(eq(planPrice.id, price))
    await db
      .update(subscription)
      .set({ planPriceId: changed, status: 'canceled', cancelAtPeriodEnd: true })
      .where(eq(subscription.id, sid))
    expect(scopedFailures(await runAnnualGrants(db, now))).toEqual([])
    const first = await grants()
    expect(first).toHaveLength(3)
    expect(first.map((g) => g.sourceRef).sort()).toEqual([0, 1, 2].map((n) => `${paid}:${n}`))
    expect(first.filter((g) => g.status === 'expired')).toHaveLength(1)
    expect(first.find((g) => g.sourceRef === `${paid}:1`)?.expiresAt).toEqual(
      new Date(subscriptionMonthAnchor(start, 2).getTime() + 86_400_000),
    )
    const before = await ledger()
    await Promise.all([runAnnualGrants(db, now), runAnnualGrants(db, now)])
    expect(await grants()).toEqual(first)
    expect(await ledger()).toEqual(before)
    expect(scopedFailures(await runCreditReconciliation(db))).toEqual([])
  })
  it('uses the injected cron clock for retrospective expiration, independent of the database clock', async () => {
    const futureStart = new Date('2030-01-31T12:00:00Z')
    const futureEnd = new Date('2031-01-31T12:00:00Z')
    await db
      .update(payment)
      .set({ periodStart: futureStart, periodEnd: futureEnd })
      .where(eq(payment.id, paid))
    await db
      .update(subscription)
      .set({ currentPeriodStart: futureStart, currentPeriodEnd: futureEnd })
      .where(eq(subscription.id, sid))
    expect(scopedFailures(await runAnnualGrants(db, new Date('2030-04-02T12:00:00Z')))).toEqual([])
    const batches = await grants()
    expect(batches).toHaveLength(3)
    expect(batches.filter((g) => g.status === 'expired')).toHaveLength(2)
    expect(await getCreditBalance(db, ws)).toMatchObject({ available: 10 })
  })
  it.each(['paused', 'expired', 'canceled'] as const)(
    'stops grants for terminated or paused %s',
    async (status) => {
      await db
        .update(subscription)
        .set({ status, cancelAtPeriodEnd: false })
        .where(eq(subscription.id, sid))
      await runAnnualGrants(db, now)
      expect(await grants()).toEqual([])
    },
  )
  it('does not grant a future or fully refunded period; partial refunds grant the unrefunded share', async () => {
    await db
      .update(payment)
      .set({ periodStart: subscriptionMonthAnchor(now, 1) })
      .where(eq(payment.id, paid))
    expect(scopedFailures(await runAnnualGrants(db, now))).toEqual([])
    expect(await grants()).toEqual([])
    await db
      .update(payment)
      .set({ periodStart: start, status: 'refunded', refundedAmount: 1000 })
      .where(eq(payment.id, paid))
    expect(scopedFailures(await runAnnualGrants(db, now))).toEqual([])
    expect(await grants()).toEqual([])
    // 退款 50%：批次记录原始 10，按比例回收后保留 floor(10 × 0.5) = 5（Q6）
    await db
      .update(payment)
      .set({ status: 'partially_refunded', refundedAmount: 500 })
      .where(eq(payment.id, paid))
    expect(scopedFailures(await runAnnualGrants(db, now))).toEqual([])
    const scaled = await grants()
    expect(scaled.length).toBeGreaterThan(0)
    expect(scaled.every((row) => row.amount === 10)).toBe(true)
    // 已过账期的月份随后被同一 cron 过期，只核对仍有效批次的保留份额
    const active = scaled.filter((row) => row.status === 'active')
    expect(active.length).toBeGreaterThan(0)
    expect(active.every((row) => row.remaining === 5)).toBe(true)
  })
  it('expiration leaves held allocation for later release without restoring balance', async () => {
    const batch = await grant(db, { workspaceId: ws, source: 'admin', sourceRef: id(), amount: 10 })
    const reservation = await hold(db, {
      workspaceId: ws,
      userId: uid,
      amount: 4,
      refType: 'ai_message',
      refId: id(),
    })
    // Fixture-only time travel; production mutations remain in credits.
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(now.getTime() - 1000) })
      .where(eq(creditGrant.id, batch.id))
    await runCreditExpiration(db, now)
    const before = await ledger()
    await runCreditExpiration(db, now)
    expect(await ledger()).toEqual(before)
    await release(db, { workspaceId: ws, holdId: reservation.id })
    expect(await getCreditBalance(db, ws)).toMatchObject({ available: 0, held: 0 })
    expect(scopedFailures(await runCreditReconciliation(db))).toEqual([])
  })
  it('registered sweep settles once; unregistered, null expiry and failing handlers retain holds and alert', async () => {
    await grant(db, { workspaceId: ws, source: 'admin', sourceRef: id(), amount: 100 })
    const reserve = (refType: 'ai_message' | 'ai_task', expiresAt: Date | null) =>
      hold(db, {
        workspaceId: ws,
        userId: uid,
        amount: 4,
        refType,
        refId: id(),
        expiresAt,
      })
    const elapsed = new Date(now.getTime() - 1000)
    const a = await reserve('ai_message', elapsed)
    const b = await reserve('ai_task', elapsed)
    const c = await reserve('ai_task', null)
    const alert = vi.fn()
    const dispose = registerHoldSweeper('ai_message', async ({ db, tx, hold: h }) => {
      await release(db, { workspaceId: h.workspaceId, holdId: h.id }, tx)
    })
    disposers.push(dispose)
    expect(scopedFailures(await runHoldSweep(db, now, { alert }))).toHaveLength(1)
    expect(alert).toHaveBeenCalled()
    const before = await ledger()
    await runHoldSweep(db, now)
    expect(await ledger()).toEqual(before)
    expect((await db.select().from(creditHold).where(eq(creditHold.id, a.id)))[0]?.status).toBe(
      'released',
    )
    dispose()
    disposers.push(
      registerHoldSweeper('ai_task', async ({ db, tx, hold: h }) => {
        await release(db, { workspaceId: h.workspaceId, holdId: h.id }, tx)
        throw new Error('business failed')
      }),
    )
    expect(scopedFailures(await runHoldSweep(db, now))).toHaveLength(1)
    expect(
      (
        await db
          .select()
          .from(creditHold)
          .where(inArray(creditHold.id, [b.id, c.id]))
      ).every((h) => h.status === 'held'),
    ).toBe(true)
  })
  it('remote reconciliation runs outside transactions, preserves PayPal cancel intent and creates no payments', async () => {
    await db.update(planPrice).set({ provider: 'paypal' }).where(eq(planPrice.id, price))
    await db
      .update(subscription)
      .set({ provider: 'paypal', status: 'canceled', cancelAtPeriodEnd: true })
      .where(eq(subscription.id, sid))
    let inTx = false
    const original = db.transaction.bind(db)
    const spy = vi.spyOn(db, 'transaction').mockImplementation(async (callback, config) =>
      original(async (tx) => {
        inTx = true
        try {
          return await callback(tx)
        } finally {
          inTx = false
        }
      }, config),
    )
    const snapshot: SubscriptionSnapshot = {
      providerSubscriptionId: sid,
      providerCustomerId: null,
      providerPriceId: price,
      status: 'paused',
      remoteStatus: 'SUSPENDED',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      pastDueSince: null,
      metadata: { workspaceId: id(), userId: id(), planPriceId: id() },
      raw: {},
    }
    const getSubscription = vi.fn(async () => {
      expect(inTx).toBe(false)
      return snapshot
    })
    const cancelSubscription = vi.fn(async () => {
      expect(inTx).toBe(false)
    })
    const provider = {
      id: 'paypal',
      getSubscription,
      cancelSubscription,
    } as unknown as PaymentProvider
    try {
      expect(
        scopedFailures(
          await runSubscriptionReconciliation(db, { paypal: provider }, { now: () => now }),
        ),
      ).toEqual([])
      const [sub] = await db.select().from(subscription).where(eq(subscription.id, sid))
      expect(sub).toMatchObject({
        workspaceId: ws,
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: end,
      })
      expect(cancelSubscription).not.toHaveBeenCalled()
      await db
        .update(subscription)
        .set({ currentPeriodEnd: new Date(now.getTime() - 1000) })
        .where(eq(subscription.id, sid))
      await runSubscriptionReconciliation(db, { paypal: provider }, { now: () => now })
      expect(cancelSubscription).toHaveBeenCalledWith(sid, { atPeriodEnd: false })
      getSubscription.mockResolvedValue({ ...snapshot, providerSubscriptionId: id() })
      expect(
        scopedFailures(
          await runSubscriptionReconciliation(db, { paypal: provider }, { now: () => now }),
        ),
      ).toHaveLength(1)
      expect(await db.select().from(payment).where(eq(payment.workspaceId, ws))).toHaveLength(1)
      expect(await grants()).toHaveLength(0)
      await db.insert(subscription).values({
        id: id(),
        workspaceId: ws,
        planId: pid,
        planPriceId: price,
        provider: 'paypal',
        providerSubscriptionId: id(),
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: end,
        lastEventAt: start,
      })
      getSubscription.mockResolvedValue(snapshot)
      const mixed = await runSubscriptionReconciliation(
        db,
        { paypal: provider },
        { now: () => now },
      )
      expect(scopedFailures(mixed)).toHaveLength(1)
      expect(mixed.processed).toBeGreaterThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
  })
  it('terminal-cancels an elapsed PayPal period-end cancellation once; terminal remote state is never cancelled again', async () => {
    const elapsed = new Date(now.getTime() - 1000)
    await db.update(planPrice).set({ provider: 'paypal' }).where(eq(planPrice.id, price))
    await db
      .update(subscription)
      .set({
        provider: 'paypal',
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: elapsed,
      })
      .where(eq(subscription.id, sid))
    // 模拟 PayPal：周期末取消先 suspend，已 CANCELLED 的订阅再 cancel 会返回 422
    let remote: 'SUSPENDED' | 'CANCELLED' = 'SUSPENDED'
    const snapshot = (): SubscriptionSnapshot => ({
      providerSubscriptionId: sid,
      providerCustomerId: null,
      providerPriceId: price,
      status: remote === 'CANCELLED' ? 'canceled' : 'paused',
      remoteStatus: remote,
      currentPeriodStart: start,
      currentPeriodEnd: elapsed,
      cancelAtPeriodEnd: false,
      canceledAt: remote === 'CANCELLED' ? now : null,
      trialEnd: null,
      pastDueSince: null,
      metadata: null,
      raw: { status: remote },
    })
    const getSubscription = vi.fn(async () => snapshot())
    const cancelSubscription = vi.fn(async () => {
      if (remote === 'CANCELLED') throw new Error('PayPal HTTP request failed (422)')
      remote = 'CANCELLED'
    })
    const provider = {
      id: 'paypal',
      getSubscription,
      cancelSubscription,
    } as unknown as PaymentProvider
    for (let round = 0; round < 2; round++)
      expect(
        scopedFailures(
          await runSubscriptionReconciliation(db, { paypal: provider }, { now: () => now }),
        ),
      ).toEqual([])
    expect(cancelSubscription).toHaveBeenCalledTimes(1)
    expect(cancelSubscription).toHaveBeenCalledWith(sid, { atPeriodEnd: false })
    const [sub] = await db.select().from(subscription).where(eq(subscription.id, sid))
    expect(sub).toMatchObject({ status: 'canceled' })
    expect(sub?.raw).toEqual({ status: 'CANCELLED' })

    // 远端已因 CANCELLED 回调终止：对账只读取状态，不再调用 cancel
    cancelSubscription.mockClear()
    await db
      .update(subscription)
      .set({ status: 'canceled', cancelAtPeriodEnd: true })
      .where(eq(subscription.id, sid))
    expect(
      scopedFailures(
        await runSubscriptionReconciliation(db, { paypal: provider }, { now: () => now }),
      ),
    ).toEqual([])
    expect(cancelSubscription).not.toHaveBeenCalled()
  })

  it('clears contacts only 30 days after rejection or refund completion, never pending or approved', async () => {
    const old = new Date(now.getTime() - 31 * 86_400_000)
    const recent = new Date(now.getTime() - 29 * 86_400_000)
    const rows = [
      { status: 'rejected' as const, reviewedAt: old, updatedAt: recent },
      { status: 'refunded' as const, reviewedAt: old, updatedAt: old },
      { status: 'refunded' as const, reviewedAt: old, updatedAt: recent },
      { status: 'approved' as const, reviewedAt: old, updatedAt: old },
      { status: 'pending' as const, reviewedAt: null, updatedAt: old },
    ].map((r) => ({
      ...r,
      id: id(),
      workspaceId: ws,
      userId: uid,
      paymentId: paid,
      reason: 'test',
      contactEmail: 'private@example.test',
    }))
    await db.insert(refundRequest).values(rows)
    await clearResolvedRefundContacts(db, now)
    const contacts = await db.select().from(refundRequest).where(eq(refundRequest.workspaceId, ws))
    expect(
      contacts
        .filter((r) => r.contactEmail === null)
        .map((r) => r.id)
        .sort(),
    ).toEqual(
      rows
        .slice(0, 2)
        .map((r) => r.id)
        .sort(),
    )
  })
  it('invariant mismatch is audited and observable', async () => {
    await grant(db, { workspaceId: ws, source: 'admin', sourceRef: id(), amount: 10 })
    await db.insert(creditLedger).values({ workspaceId: ws, type: 'adjust', delta: 1 })
    const alert = vi.fn()
    const result = await runCreditReconciliation(db, { alert })
    expect(scopedFailures(result)).toHaveLength(1)
    expect(alert).toHaveBeenCalled()
    expect(
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, ws),
            eq(auditLog.action, 'billing.cron.credit_reconciliation.failed'),
          ),
        ),
    ).toHaveLength(1)
  })
})
