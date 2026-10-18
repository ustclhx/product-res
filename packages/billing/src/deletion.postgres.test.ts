import type { DeletionContext, DeletionStep } from '@product-res/auth'
import { hold, release } from '@product-res/credits'
import {
  createDb,
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
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBillingDeletionStep, listDeletionRefundReminders } from './deletion.ts'
import type { PaymentProvider, SubscriptionSnapshot } from './provider.ts'
import { listRefundRequests, reviewRefundRequest } from './refunds.ts'

const testEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
const url = testEnv.BILLING_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: url })
// audit_log 对 app 只追加（@product-res/db 迁移 0009），审计行由 migrator 清理
const migrator = createDb({ connectionString: testEnv.MIGRATION_DATABASE_URL ?? '' })
const id = () => crypto.randomUUID()
const now = new Date('2030-03-01T12:00:00Z')
let uid: string,
  adminId: string,
  ws: string,
  pid: string,
  priceId: string,
  planId: string,
  sid: string
let context: DeletionContext
const get = vi.fn<PaymentProvider['getSubscription']>()
const cancel = vi.fn<PaymentProvider['cancelSubscription']>()
const refund = vi.fn<NonNullable<PaymentProvider['refund']>>()
const provider = (name: 'stripe' | 'paypal') =>
  ({
    id: name,
    capabilities: { refundsViaApi: true },
    getSubscription: get,
    cancelSubscription: cancel,
    refund,
  }) as unknown as PaymentProvider
const make = () =>
  createBillingDeletionStep({
    providers: { stripe: provider('stripe'), paypal: provider('paypal') },
    refundWindowDays: 30,
    now: () => now,
  })
const snapshot = (remoteStatus = 'ACTIVE') =>
  ({ providerSubscriptionId: sid, status: 'active', remoteStatus }) as SubscriptionSnapshot

// Auth's trusted raw-transaction flow: billing executes before workspace/user anonymization.
async function execute(step: DeletionStep, fail = false) {
  await db.$client.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${uid}`},0))`
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${ws}`},0))`
    await step.execute?.(context, sql)
    await sql`update organization set deleted_at=${now.toISOString()} where id=${ws}`
    await sql`delete from member where user_id=${uid}`
    await sql`update "user" set email=${`deleted+${uid}@invalid`},banned=true where id=${uid}`
    if (fail) throw new Error('later deletion step failed')
  })
}
beforeEach(async () => {
  uid = id()
  adminId = id()
  ws = id()
  pid = id()
  priceId = id()
  planId = id()
  sid = id()
  context = { db, actorUserId: uid, workspaceIds: [ws] }
  get.mockReset().mockImplementation(async () => snapshot())
  cancel.mockReset().mockResolvedValue(undefined)
  refund.mockReset().mockResolvedValue({ providerRefundId: id() })
  await db.insert(user).values([
    { id: uid, name: 'Applicant', email: `${uid}@example.test` },
    { id: adminId, name: 'Admin', email: `${adminId}@example.test`, role: 'admin' },
  ])
  await db.insert(organization).values({ id: ws, name: 'Deletion', slug: ws, isPersonal: true })
  await db.insert(member).values({ id: id(), userId: uid, organizationId: ws, role: 'owner' })
  await db.insert(plan).values({
    id: planId,
    key: planId,
    name: 'Plan',
    type: 'subscription',
    credits: 100,
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
    interval: 'month',
    amount: 1000,
    currency: 'USD',
    providerPriceId: priceId,
  })
  await db.insert(subscription).values({
    id: sid,
    workspaceId: ws,
    planId,
    planPriceId: priceId,
    provider: 'stripe',
    providerSubscriptionId: sid,
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: new Date('2030-04-01'),
    lastEventAt: now,
  })
  await db.insert(payment).values({
    id: pid,
    workspaceId: ws,
    provider: 'stripe',
    providerPaymentId: pid,
    subscriptionId: sid,
    kind: 'initial',
    planPriceId: priceId,
    amount: 1000,
    currency: 'USD',
    paidAt: now,
    periodStart: now,
    periodEnd: new Date('2030-04-01'),
  })
  await db.insert(creditGrant).values({
    workspaceId: ws,
    source: 'subscription',
    sourceRef: pid,
    paymentId: pid,
    amount: 100,
    remaining: 100,
  })
})
afterEach(async () => {
  await migrator.$client`delete from audit_log where workspace_id=${ws}`
  await db
    .delete(creditHoldAllocation)
    .where(
      inArray(
        creditHoldAllocation.holdId,
        db.select({ id: creditHold.id }).from(creditHold).where(eq(creditHold.workspaceId, ws)),
      ),
    )
  await db.delete(creditLedger).where(eq(creditLedger.workspaceId, ws))
  await db.delete(creditHold).where(eq(creditHold.workspaceId, ws))
  await db.delete(creditGrant).where(eq(creditGrant.workspaceId, ws))
  await db.delete(refundRequest).where(eq(refundRequest.workspaceId, ws))
  await db.delete(payment).where(eq(payment.workspaceId, ws))
  await db.delete(subscription).where(eq(subscription.workspaceId, ws))
  await db.delete(member).where(eq(member.organizationId, ws))
  await db.delete(organization).where(eq(organization.id, ws))
  await db.delete(user).where(inArray(user.id, [uid, adminId]))
  await db.delete(planPrice).where(eq(planPrice.id, priceId))
  await db.delete(plan).where(eq(plan.id, planId))
})
afterAll(() => Promise.all([db.$client.end(), migrator.$client.end()]))

describe('billing deletion in caller PostgreSQL transaction', () => {
  it('immediately cancels without refunds, preserves payment periods and prevents held credit resurrection', async () => {
    const reservation = await hold(db, {
      workspaceId: ws,
      userId: uid,
      amount: 40,
      refType: 'ai_message',
      refId: id(),
    })
    const step = make()
    cancel.mockImplementationOnce(async () => {
      // A competing transaction can take the billing lock during remote cancellation.
      await db.$client.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${ws}`},0))`
      })
    })
    await step.before?.(context)
    await execute(step)
    expect(cancel).toHaveBeenCalledWith(sid, { atPeriodEnd: false })
    expect(refund).not.toHaveBeenCalled()
    expect((await db.select().from(subscription).where(eq(subscription.id, sid)))[0]).toMatchObject(
      {
        status: 'canceled',
        cancelAtPeriodEnd: false,
        canceledAt: now,
        currentPeriodEnd: new Date('2030-04-01'),
      },
    )
    await release(db, { workspaceId: ws, holdId: reservation.id })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws)))[0],
    ).toMatchObject({ status: 'revoked', remaining: 0 })
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).reduce(
        (sum, row) => sum + row.delta,
        0,
      ),
    ).toBe(-100)
    expect(await db.select().from(refundRequest).where(eq(refundRequest.workspaceId, ws))).toEqual(
      [],
    )
  })
  it('fills missing contacts before anonymization and keeps pending refunds reviewable', async () => {
    const rid = id()
    await db.insert(refundRequest).values({
      id: rid,
      workspaceId: ws,
      paymentId: pid,
      userId: uid,
      reason: 'Please refund',
      contactEmail: null,
    })
    expect(await listDeletionRefundReminders(context, 30, now)).toMatchObject({
      eligiblePaymentIds: [pid],
      pendingRequests: [{ id: rid, contactEmail: null }],
    })
    const step = make()
    await step.before?.(context)
    await execute(step)
    const notify = vi.fn(async () => {})
    const options = {
      db,
      providers: { stripe: provider('stripe') },
      config: { refundWindowDays: 30 },
      now: () => now,
      notify,
    }
    expect(
      (await listRefundRequests(options, { userId: adminId, workspaceId: ws }))[0]?.request,
    ).toMatchObject({ id: rid, contactEmail: `${uid}@example.test` })
    await reviewRefundRequest(options, { userId: adminId, requestId: rid, decision: 'approve' })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ contactEmail: `${uid}@example.test` }),
    )
  })
  it('preserves an existing refund contact instead of replacing it with the account email', async () => {
    const rid = id()
    await db.insert(refundRequest).values({
      id: rid,
      workspaceId: ws,
      paymentId: pid,
      userId: uid,
      reason: 'Please refund',
      contactEmail: 'saved-contact@example.test',
    })
    const step = make()
    await step.before?.(context)
    await execute(step)
    expect(
      (await db.select().from(refundRequest).where(eq(refundRequest.id, rid)))[0],
    ).toMatchObject({ status: 'pending', contactEmail: 'saved-contact@example.test' })
    expect(refund).not.toHaveBeenCalled()
  })
  it('rolls back local cancellation and credit revocation when a later deletion step fails', async () => {
    const step = make()
    await step.before?.(context)
    await expect(execute(step, true)).rejects.toThrow('later deletion step failed')
    expect((await db.select().from(subscription).where(eq(subscription.id, sid)))[0]?.status).toBe(
      'active',
    )
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws)))[0],
    ).toMatchObject({ status: 'active', remaining: 100 })
    expect((await db.select().from(user).where(eq(user.id, uid)))[0]?.email).toBe(
      `${uid}@example.test`,
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('blocks missing providers and explicit remote failures before deletion', async () => {
    await expect(
      createBillingDeletionStep({ providers: {}, refundWindowDays: 30 }).before?.(context),
    ).rejects.toMatchObject({ code: 'BILLING_PROVIDER_UNAVAILABLE' })
    cancel.mockRejectedValueOnce(new Error('remote unavailable'))
    const step = make()
    await expect(step.before?.(context)).rejects.toThrow('remote unavailable')
    await expect(execute(step)).rejects.toMatchObject({ code: 'BILLING_DELETION_RETRY' })
  })
  it('requires retry for subscriptions appearing after remote work and after before returns', async () => {
    const add = async () => {
      await db.insert(subscription).values({
        id: id(),
        workspaceId: ws,
        planId,
        planPriceId: priceId,
        provider: 'stripe',
        providerSubscriptionId: id(),
        status: 'active',
        cancelAtPeriodEnd: true,
        lastEventAt: now,
      })
    }
    const first = make()
    cancel.mockImplementationOnce(add)
    await expect(first.before?.(context)).rejects.toMatchObject({ code: 'BILLING_DELETION_RETRY' })
    get.mockImplementation(async (remoteId) => ({
      ...snapshot(),
      providerSubscriptionId: remoteId,
    }))
    const second = make()
    await second.before?.(context)
    await add()
    await expect(execute(second)).rejects.toMatchObject({ code: 'BILLING_DELETION_RETRY' })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws)))[0]?.status,
    ).toBe('active')
  })
  it('rejects a changed subscription version before committing any local deletion writes', async () => {
    const step = make()
    await step.before?.(context)
    await db
      .update(subscription)
      .set({ lastEventAt: new Date(now.getTime() + 1000) })
      .where(eq(subscription.id, sid))
    await expect(execute(step)).rejects.toMatchObject({ code: 'BILLING_DELETION_RETRY' })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws)))[0]?.remaining,
    ).toBe(100)
  })
  it('cancels PayPal suspended cancel intent but skips true terminal remote status and terminal Stripe rows', async () => {
    await db
      .update(subscription)
      .set({ provider: 'paypal', status: 'canceled', cancelAtPeriodEnd: true })
      .where(eq(subscription.id, sid))
    get.mockResolvedValueOnce(snapshot('SUSPENDED'))
    await make().before?.(context)
    expect(cancel).toHaveBeenCalledWith(sid, { atPeriodEnd: false })
    cancel.mockClear()
    get.mockResolvedValueOnce(snapshot('CANCELLED'))
    await make().before?.(context)
    expect(cancel).not.toHaveBeenCalled()
    await db.update(subscription).set({ provider: 'stripe' }).where(eq(subscription.id, sid))
    get.mockClear()
    await make().before?.(context)
    expect(get).not.toHaveBeenCalled()
  })
})
