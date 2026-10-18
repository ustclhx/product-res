import {
  auditLog,
  createDb,
  creditGrant,
  creditLedger,
  member,
  organization,
  payment,
  paymentRefund,
  plan,
  planPrice,
  purchase,
  refundRequest,
  user,
} from '@product-res/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBillingEvent, prepareBillingEvents } from './events.ts'
import { flushRefundNotifications, notifyRefundRequest } from './notifications.ts'
import type { NormalizedEvent, PaymentProvider, RefundInput } from './provider.ts'
import {
  listRefundablePayments,
  listRefundRequests,
  markManualRefund,
  type RefundNotification,
  type RefundServiceOptions,
  retryRefundNotification,
  reviewRefundRequest,
  submitRefundRequest,
} from './refunds.ts'

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
  other: string,
  pid: string,
  priceId: string,
  planId: string
let options: RefundServiceOptions
const remote = vi.fn(async (_input: RefundInput) => ({ providerRefundId: 'refund-proof' }))
const notify = vi.fn(async (_notification: RefundNotification) => {})
const submit = (overrides: Partial<Parameters<typeof submitRefundRequest>[1]> = {}) =>
  submitRefundRequest(options, {
    userId: uid,
    workspaceId: ws,
    paymentId: pid,
    reason: 'Please refund',
    contactEmail: 'saved@example.test',
    ...overrides,
  })
const approve = (requestId: string, approvedAmount?: number) =>
  reviewRefundRequest(options, {
    userId: adminId,
    ip: '203.0.113.17',
    requestId,
    decision: 'approve',
    ...(approvedAmount === undefined ? {} : { approvedAmount }),
  })
beforeEach(async () => {
  uid = id()
  adminId = id()
  ws = id()
  other = id()
  pid = id()
  priceId = id()
  planId = id()
  remote.mockReset().mockResolvedValue({ providerRefundId: `refund-${pid}` })
  notify.mockReset().mockResolvedValue(undefined)
  await db.insert(user).values([
    { id: uid, name: 'Applicant', email: `${uid}@example.test` },
    { id: adminId, name: 'Admin', email: `${adminId}@example.test`, role: 'admin' },
  ])
  await db.insert(organization).values([
    { id: ws, name: 'Refunds', slug: ws },
    { id: other, name: 'Other', slug: other },
  ])
  await db.insert(member).values({ id: id(), userId: uid, organizationId: ws, role: 'owner' })
  await db.insert(plan).values({
    id: planId,
    key: planId,
    name: 'Credits',
    type: 'credit_pack',
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
    interval: null,
    amount: 1000,
    currency: 'USD',
    providerPriceId: priceId,
  })
  const purchaseId = id()
  await db.insert(purchase).values({
    id: purchaseId,
    workspaceId: ws,
    userId: uid,
    planId,
    planPriceId: priceId,
    provider: 'stripe',
    providerOrderId: purchaseId,
    amount: 1000,
    currency: 'USD',
  })
  await db.insert(payment).values({
    id: pid,
    workspaceId: ws,
    provider: 'stripe',
    providerPaymentId: pid,
    purchaseId,
    kind: 'one_time',
    planPriceId: priceId,
    amount: 1000,
    currency: 'USD',
    paidAt: now,
  })
  const provider = {
    id: 'stripe',
    capabilities: { refundsViaApi: true },
    refund: remote,
  } as unknown as PaymentProvider
  options = {
    db,
    providers: { stripe: provider },
    config: { refundWindowDays: 30 },
    notify,
    now: () => now,
  }
})
afterEach(async () => {
  const spaces = [ws, other]
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, spaces))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, spaces))
  await migrator.delete(auditLog).where(inArray(auditLog.workspaceId, spaces))
  await db.delete(refundRequest).where(inArray(refundRequest.workspaceId, spaces))
  await db.delete(paymentRefund).where(inArray(paymentRefund.workspaceId, spaces))
  await db.delete(payment).where(inArray(payment.workspaceId, spaces))
  await db.delete(purchase).where(inArray(purchase.workspaceId, spaces))
  await db.delete(member).where(inArray(member.organizationId, spaces))
  await db.delete(organization).where(inArray(organization.id, spaces))
  await db.delete(user).where(inArray(user.id, [uid, adminId]))
  await db.delete(planPrice).where(eq(planPrice.id, priceId))
  await db.delete(plan).where(eq(plan.id, planId))
})
afterAll(() => Promise.all([db.$client.end(), migrator.$client.end()]))

describe('trusted refund service on PostgreSQL', () => {
  it('settles a verified callback committed before the pending provider refund returns', async () => {
    await db.insert(creditGrant).values({
      workspaceId: ws,
      source: 'purchase',
      sourceRef: pid,
      paymentId: pid,
      amount: 10,
      remaining: 7,
      expiresAt: null,
    })
    const request = await submit()
    const callback: NormalizedEvent = {
      provider: 'stripe',
      type: 'payment.refunded',
      providerPaymentId: pid,
      providerRefundId: `refund-${pid}`,
      amount: 400,
      refundedAmount: 400,
      currency: 'USD',
      occurredAt: now,
      raw: {},
    }
    const deliverCallback = async () => {
      const prepared = await prepareBillingEvents([callback], db, options.providers)
      await db.transaction((tx) => applyBillingEvent(tx, callback, prepared, { now: () => now }))
    }
    remote.mockImplementationOnce(async () => {
      // The review transaction has committed, but the API acknowledgment has not.
      await deliverCallback()
      expect(
        (await db.select().from(refundRequest).where(eq(refundRequest.id, request.id)))[0],
      ).toMatchObject({ status: 'approved', providerRefundId: null })
      return { providerRefundId: `refund-${pid}` }
    })
    expect(await approve(request.id, 400)).toMatchObject({
      status: 'refunded',
      approvedAmount: 400,
      providerRefundId: `refund-${pid}`,
      reviewerId: adminId,
      contactEmail: 'saved@example.test',
    })
    await approve(request.id)
    await deliverCallback()
    expect(remote).toHaveBeenCalledTimes(1)
    expect((await db.select().from(payment).where(eq(payment.id, pid)))[0]).toMatchObject({
      status: 'partially_refunded',
      refundedAmount: 400,
    })
    expect(
      await db.select().from(paymentRefund).where(eq(paymentRefund.paymentId, pid)),
    ).toHaveLength(1)
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.paymentId, pid)))[0],
    ).toMatchObject({ remaining: 3, status: 'active' })
    // 部分退款 40%：批次保留 floor(10 × 0.6) = 6，已消费 3 不追溯，只从剩余 7 中收回 4
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)),
    ).toMatchObject([{ type: 'revoke', delta: -4 }])
    expect(
      notify.mock.calls.every(
        ([notification]) => notification.contactEmail === 'saved@example.test',
      ),
    ).toBe(true)
  })
  it('recovers committed review mail after queue failure without repeating payment or leaking deleted email', async () => {
    const request = await submit()
    await approve(request.id, 200)
    await db
      .update(user)
      .set({ email: `deleted+${uid}@invalid`, banned: true })
      .where(eq(user.id, uid))
    const queue = { send: vi.fn(async () => {}) }
    const mail = { db, queue, appName: 'Tests', supportEmail: 'support@example.test' }
    queue.send.mockRejectedValueOnce(new Error('queue unavailable'))
    const [saved] = await db.select().from(refundRequest).where(eq(refundRequest.id, request.id))
    if (!saved) throw new Error('Missing reviewed fixture')
    await expect(
      notifyRefundRequest(mail, {
        request: saved,
        contactEmail: 'saved@example.test',
        idempotencyKey: 'ignored',
      }),
    ).rejects.toThrow('queue unavailable')
    expect(await flushRefundNotifications(mail, { requestId: request.id })).toEqual({
      queued: 1,
      failures: [],
    })
    expect(await flushRefundNotifications(mail, { requestId: request.id })).toEqual({
      queued: 0,
      failures: [],
    })
    expect(queue.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: 'saved@example.test',
        idempotencyKey: `refund-notification:${request.id}:approved`,
        template: 'refund-update',
      }),
    )
    expect(remote).toHaveBeenCalledTimes(1)
  })
  it('lists and requests only active owner payments inside the configured window', async () => {
    expect(await listRefundablePayments(options, { userId: uid, workspaceId: ws })).toMatchObject([
      { id: pid, remainingRefundable: 1000 },
    ])
    await expect(submit({ workspaceId: other })).rejects.toMatchObject({
      code: 'WORKSPACE_OWNER_REQUIRED',
    })
    await expect(submit({ reason: '  ' })).rejects.toMatchObject({ code: 'INVALID_REFUND_INPUT' })
    await expect(submit({ contactEmail: 'bad' })).rejects.toMatchObject({
      code: 'INVALID_REFUND_INPUT',
    })
    await db
      .update(payment)
      .set({ paidAt: new Date(now.getTime() - 31 * 86400000) })
      .where(eq(payment.id, pid))
    expect(await listRefundablePayments(options, { userId: uid, workspaceId: ws })).toEqual([])
    await expect(submit()).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' })
    await db
      .update(payment)
      .set({ paidAt: new Date(now.getTime() - 30 * 86400000) })
      .where(eq(payment.id, pid))
    expect((await submit()).status).toBe('pending')
  })
  it('serializes concurrent pending submissions and relies on the database unique invariant', async () => {
    const results = await Promise.allSettled([submit(), submit(), submit()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'REFUND_ALREADY_PENDING' })
    expect(
      await db.select().from(refundRequest).where(eq(refundRequest.paymentId, pid)),
    ).toHaveLength(1)
  })
  it('persists partial approval before remote failure and retries the same immutable decision/key', async () => {
    const request = await submit()
    remote.mockImplementationOnce(async (input) => {
      const [saved] = await db.select().from(refundRequest).where(eq(refundRequest.id, request.id))
      expect(saved).toMatchObject({ status: 'approved', approvedAmount: 400, reviewerId: adminId })
      // Acquiring the payment lock here proves provider execution is outside the review transaction.
      await db.transaction(async (tx) => {
        await tx.select().from(payment).where(eq(payment.id, pid)).for('update')
      })
      expect(input).toMatchObject({
        amount: 400,
        idempotencyKey: `refund:${request.id}`,
        kind: 'one_time',
      })
      throw new Error('network failure')
    })
    await expect(approve(request.id, 400)).rejects.toThrow('network failure')
    await expect(approve(request.id, 500)).rejects.toMatchObject({
      code: 'REFUND_DECISION_IMMUTABLE',
    })
    await expect(
      reviewRefundRequest(options, {
        userId: uid,
        requestId: request.id,
        decision: 'approve',
        approvedAmount: 400,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
    const saved = await approve(request.id)
    expect(saved).toMatchObject({ status: 'approved', approvedAmount: 400 })
    expect(remote.mock.calls[1]?.[0]).toEqual(remote.mock.calls[0]?.[0])
    await approve(request.id)
    expect(remote).toHaveBeenCalledTimes(2)
    expect((await db.select().from(payment).where(eq(payment.id, pid)))[0]?.status).toBe(
      'succeeded',
    )
    const logs = await db.select().from(auditLog).where(eq(auditLog.targetId, request.id))
    expect(logs.find((log) => log.action === 'billing.refund_approved')).toMatchObject({
      actorUserId: adminId,
      ip: '203.0.113.17',
      meta: { oldStatus: 'pending', newStatus: 'approved' },
    })
    expect(logs.map((log) => log.action).sort()).toEqual([
      'billing.refund_api_acknowledged',
      'billing.refund_approved',
    ])
  })
  it('retains snapshot contact and permits review after applicant/workspace deletion', async () => {
    const request = await submit()
    await db
      .update(user)
      .set({ email: `deleted+${uid}@invalid`, banned: true, name: '' })
      .where(eq(user.id, uid))
    await db.delete(member).where(eq(member.userId, uid))
    await db.update(organization).set({ deletedAt: now }).where(eq(organization.id, ws))
    await approve(request.id)
    expect(remote.mock.calls[0]?.[0]).toMatchObject({ amount: 1000 })
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ contactEmail: 'saved@example.test' })
    expect((await listRefundRequests(options, { userId: adminId }))[0]?.request.id).toBe(request.id)
    await db.update(user).set({ banned: true }).where(eq(user.id, adminId))
    await expect(approve(request.id)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
  })
  it('requires a rejection reason, audits it and retries failed notification without money', async () => {
    const request = await submit()
    await expect(
      reviewRefundRequest(options, { userId: adminId, requestId: request.id, decision: 'reject' }),
    ).rejects.toMatchObject({ code: 'INVALID_REFUND_INPUT' })
    notify.mockRejectedValueOnce(new Error('mail unavailable'))
    await expect(
      reviewRefundRequest(options, {
        userId: adminId,
        requestId: request.id,
        decision: 'reject',
        reviewNote: 'Outside our policy',
      }),
    ).rejects.toThrow('mail unavailable')
    expect(
      (await db.select().from(refundRequest).where(eq(refundRequest.id, request.id)))[0],
    ).toMatchObject({ status: 'rejected', reviewNote: 'Outside our policy', reviewerId: adminId })
    await retryRefundNotification(options, { userId: adminId, requestId: request.id })
    expect(notify.mock.calls[1]?.[0]).toMatchObject({
      idempotencyKey: `refund-notification:${request.id}:rejected`,
    })
    expect(remote).not.toHaveBeenCalled()
    expect(await db.select().from(auditLog).where(eq(auditLog.targetId, request.id))).toHaveLength(
      1,
    )
  })
  it('retries approval notification without issuing another refund and binds the reviewer', async () => {
    const request = await submit()
    notify.mockRejectedValueOnce(new Error('mail unavailable'))
    await expect(approve(request.id, 600)).rejects.toThrow('mail unavailable')
    await approve(request.id, 600)
    expect(remote).toHaveBeenCalledTimes(1)
    await retryRefundNotification(options, { userId: adminId, requestId: request.id })
    expect(remote).toHaveBeenCalledTimes(1)
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, uid))
    await expect(
      reviewRefundRequest(options, {
        userId: uid,
        requestId: request.id,
        decision: 'approve',
        approvedAmount: 600,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_DECISION_IMMUTABLE' })
    await expect(
      markManualRefund(options, {
        userId: adminId,
        requestId: request.id,
        providerRefundId: 'arbitrary',
        proof: 'receipt',
      }),
    ).rejects.toMatchObject({ code: 'MANUAL_REFUND_NOT_ALLOWED' })
  })
  it('manual confirmation requires proof and uses the shared consumer once per platform refund', async () => {
    options.providers.stripe = {
      id: 'stripe',
      capabilities: { refundsViaApi: false },
    } as PaymentProvider
    await db.insert(creditGrant).values({
      workspaceId: ws,
      source: 'purchase',
      sourceRef: pid,
      paymentId: pid,
      amount: 10,
      remaining: 7,
      expiresAt: null,
    })
    const request = await submit()
    await approve(request.id, 500)
    expect(remote).not.toHaveBeenCalled()
    const input = {
      userId: adminId,
      requestId: request.id,
      providerRefundId: 'platform-refund',
      proof: 'Platform receipt 42',
    }
    await expect(markManualRefund(options, { ...input, proof: '' })).rejects.toMatchObject({
      code: 'INVALID_REFUND_INPUT',
    })
    await markManualRefund(options, input)
    await markManualRefund(options, input)
    await expect(
      markManualRefund(options, { ...input, providerRefundId: 'another-refund' }),
    ).rejects.toMatchObject({ code: 'REFUND_DECISION_IMMUTABLE' })
    expect((await db.select().from(payment).where(eq(payment.id, pid)))[0]).toMatchObject({
      status: 'partially_refunded',
      refundedAmount: 500,
    })
    expect(
      await db.select().from(paymentRefund).where(eq(paymentRefund.paymentId, pid)),
    ).toHaveLength(1)
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.paymentId, pid)))[0]?.remaining,
    ).toBe(2)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)),
    ).toHaveLength(1)
  })
})
