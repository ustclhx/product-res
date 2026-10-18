import type { TemplateConfig } from '@product-res/config'
import {
  auditLog,
  creditGrant,
  type Database,
  member,
  organization,
  type Payment,
  payment,
  paymentRefund,
  type RefundRequest,
  refundRequest,
  user,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { applyBillingEvent, type BillingProviders, lockWorkspaceBilling } from './events.ts'
import type { WebhookTransaction } from './pipeline.ts'

export interface RefundNotification {
  request: RefundRequest
  contactEmail: string
  /** Stable delivery identity for an injected mailer/outbox to deduplicate. */
  idempotencyKey: string
}
export interface RefundServiceOptions {
  db: Database
  providers: BillingProviders
  config: Pick<TemplateConfig['billing'], 'refundWindowDays'>
  notify: (notification: RefundNotification) => Promise<void>
  now?: () => Date
}
function fail(code: string, message: string, status = 400): never {
  throw new AppError(code, message, { status })
}
function text(value: string, name: string, required = true) {
  const result = value.trim()
  if ((required && !result) || result.length > 2000)
    fail('INVALID_REFUND_INPUT', `${name} must contain 1–2000 characters`)
  return result
}
function amount(value: number, remaining: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > remaining)
    fail('INVALID_REFUND_AMOUNT', 'Refund amount exceeds the remaining payment')
  return value
}
const clock = (options: RefundServiceOptions) => options.now?.() ?? new Date()
function earliest(options: RefundServiceOptions, now: Date) {
  const days = options.config.refundWindowDays
  if (!Number.isFinite(days) || days < 0) throw new Error('Invalid refund window')
  return new Date(now.getTime() - days * 86_400_000)
}
async function owner(tx: WebhookTransaction, userId: string, workspaceId: string) {
  // Account deletion takes the same owner/workspace locks in this order.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${userId}`}, 0))`)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`}, 0))`)
  const [owned] = await tx
    .select({ account: user })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, workspaceId),
        eq(member.role, 'owner'),
        isNull(organization.deletedAt),
      ),
    )
  if (!owned || owned.account.banned || owned.account.email === `deleted+${userId}@invalid`)
    fail('WORKSPACE_OWNER_REQUIRED', 'An active workspace owner is required', 403)
}
async function admin(tx: WebhookTransaction, userId: string) {
  const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('share')
  if (
    !account ||
    !(account.role ?? '').split(',').some((role) => role.trim() === 'admin') ||
    account.banned ||
    account.email === `deleted+${userId}@invalid`
  )
    fail('ADMIN_REQUIRED', 'An active administrator is required', 403)
}
async function lockedRequest(tx: WebhookTransaction, id: string) {
  const [found] = await tx.select().from(refundRequest).where(eq(refundRequest.id, id))
  if (!found) fail('REFUND_REQUEST_NOT_FOUND', 'Refund request not found', 404)
  await lockWorkspaceBilling(tx, found.workspaceId)
  const [request] = await tx
    .select()
    .from(refundRequest)
    .where(eq(refundRequest.id, id))
    .for('update')
  const [paid] = await tx
    .select()
    .from(payment)
    .where(and(eq(payment.id, found.paymentId), eq(payment.workspaceId, found.workspaceId)))
    .for('update')
  if (!request || !paid) fail('REFUND_REQUEST_NOT_FOUND', 'Refund payment not found', 404)
  return { request, paid }
}
async function audit(
  tx: WebhookTransaction,
  request: RefundRequest,
  actorUserId: string,
  action: string,
  meta: Record<string, string | number | null> = {},
  ip: string | null = null,
) {
  await tx.insert(auditLog).values({
    workspaceId: request.workspaceId,
    actorUserId,
    ip,
    action,
    targetType: 'refund_request',
    targetId: request.id,
    meta: { approvedAmount: request.approvedAmount, reviewNote: request.reviewNote, ...meta },
  })
}
async function notify(options: RefundServiceOptions, request: RefundRequest) {
  if (!request.contactEmail)
    fail('REFUND_CONTACT_UNAVAILABLE', 'Refund contact has been cleared', 409)
  // Deliberately propagate failure: the committed decision survives and delivery can be retried.
  await options.notify({
    request,
    contactEmail: request.contactEmail,
    idempotencyKey: `refund-notification:${request.id}:${request.status}`,
  })
}
function providerFor(options: RefundServiceOptions, paid: Payment) {
  const provider = options.providers[paid.provider]
  if (!provider || provider.id !== paid.provider) throw new Error('Missing billing provider')
  return provider
}

export async function listRefundablePayments(
  options: RefundServiceOptions,
  input: { userId: string; workspaceId: string },
) {
  return options.db.transaction(async (tx) => {
    await owner(tx, input.userId, input.workspaceId)
    const now = clock(options)
    const rows = await tx
      .select()
      .from(payment)
      .where(
        and(
          eq(payment.workspaceId, input.workspaceId),
          eq(payment.status, 'succeeded'),
          gte(payment.paidAt, earliest(options, now)),
          lte(payment.paidAt, now),
          sql`${payment.refundedAmount} < ${payment.amount}`,
        ),
      )
      .orderBy(desc(payment.paidAt), desc(payment.id))
    return rows.map((row) => ({ ...row, remainingRefundable: row.amount - row.refundedAmount }))
  })
}

export async function submitRefundRequest(
  options: RefundServiceOptions,
  input: {
    userId: string
    workspaceId: string
    paymentId: string
    reason: string
    contactEmail: string
    requestedAmount?: number
  },
): Promise<RefundRequest> {
  const reason = text(input.reason, 'Reason')
  const email = input.contactEmail.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail('INVALID_REFUND_INPUT', 'A valid contact email is required')
  return options.db.transaction(async (tx) => {
    await owner(tx, input.userId, input.workspaceId)
    await lockWorkspaceBilling(tx, input.workspaceId)
    const [paid] = await tx
      .select()
      .from(payment)
      .where(and(eq(payment.id, input.paymentId), eq(payment.workspaceId, input.workspaceId)))
      .for('update')
    const now = clock(options)
    if (
      paid?.status !== 'succeeded' ||
      paid.paidAt < earliest(options, now) ||
      paid.paidAt > now ||
      paid.refundedAmount >= paid.amount
    )
      fail('PAYMENT_NOT_REFUNDABLE', 'Payment is outside the refund window or unavailable', 409)
    const requestedAmount =
      input.requestedAmount === undefined
        ? null
        : amount(input.requestedAmount, paid.amount - paid.refundedAmount)
    const [created] = await tx
      .insert(refundRequest)
      .values({
        workspaceId: input.workspaceId,
        paymentId: paid.id,
        userId: input.userId,
        reason,
        contactEmail: email,
        requestedAmount,
      })
      .onConflictDoNothing()
      .returning()
    if (!created)
      fail('REFUND_ALREADY_PENDING', 'Payment already has a pending refund request', 409)
    return created
  })
}

/** Administrator queue includes historical/deleted applicants and the payment's credit batches. */
export async function listRefundRequests(
  options: RefundServiceOptions,
  input: {
    userId: string
    workspaceId?: string
    status?: RefundRequest['status']
  },
) {
  return options.db.transaction(async (tx) => {
    await admin(tx, input.userId)
    const rows = await tx
      .select({ request: refundRequest, payment })
      .from(refundRequest)
      .innerJoin(payment, eq(payment.id, refundRequest.paymentId))
      .where(
        and(
          input.workspaceId ? eq(refundRequest.workspaceId, input.workspaceId) : undefined,
          input.status ? eq(refundRequest.status, input.status) : undefined,
        ),
      )
      .orderBy(desc(refundRequest.createdAt), desc(refundRequest.id))
    return Promise.all(
      rows.map(async (row) => {
        const batches = await tx
          .select()
          .from(creditGrant)
          .where(
            and(
              eq(creditGrant.workspaceId, row.request.workspaceId),
              eq(creditGrant.paymentId, row.payment.id),
            ),
          )
        return {
          ...row,
          remainingRefundable: row.payment.amount - row.payment.refundedAmount,
          credits: batches.map((batch) => ({
            id: batch.id,
            amount: batch.amount,
            used: batch.amount - batch.remaining,
            remaining: batch.remaining,
          })),
        }
      }),
    )
  })
}

/** Persist an immutable decision before touching the provider; API acknowledgment is not settlement. */
export async function reviewRefundRequest(
  options: RefundServiceOptions,
  input: {
    userId: string
    ip?: string | null
    requestId: string
    decision: 'approve' | 'reject'
    approvedAmount?: number
    reviewNote?: string
  },
): Promise<RefundRequest> {
  const note = text(input.reviewNote ?? '', 'Review note', input.decision === 'reject')
  const saved = await options.db.transaction(async (tx) => {
    await admin(tx, input.userId)
    const { request, paid } = await lockedRequest(tx, input.requestId)
    const status = input.decision === 'approve' ? 'approved' : 'rejected'
    if (request.status !== 'pending') {
      if (
        (request.status !== status && !(status === 'approved' && request.status === 'refunded')) ||
        request.reviewerId !== input.userId ||
        request.reviewNote !== note ||
        (input.approvedAmount !== undefined && request.approvedAmount !== input.approvedAmount)
      )
        fail('REFUND_DECISION_IMMUTABLE', 'The saved refund decision cannot be changed', 409)
      return { request, paid }
    }
    const approvedAmount =
      input.decision === 'approve'
        ? amount(
            input.approvedAmount ?? paid.amount - paid.refundedAmount,
            paid.amount - paid.refundedAmount,
          )
        : null
    if (input.decision === 'approve') {
      if (paid.status === 'disputed')
        fail('PAYMENT_NOT_REFUNDABLE', 'Disputed payment cannot be approved', 409)
      const provider = providerFor(options, paid)
      if (provider.capabilities.refundsViaApi && !provider.refund)
        throw new Error('Missing provider refund API')
      // Do not allow two unresolved approved requests to reserve the same payment.
      const [existing] = await tx
        .select({ id: refundRequest.id })
        .from(refundRequest)
        .where(and(eq(refundRequest.paymentId, paid.id), eq(refundRequest.status, 'approved')))
      if (existing)
        fail('REFUND_ALREADY_APPROVED', 'Payment already has an unresolved approval', 409)
    }
    const [updated] = await tx
      .update(refundRequest)
      .set({
        status,
        approvedAmount,
        reviewerId: input.userId,
        reviewedAt: clock(options),
        reviewNote: note,
      })
      .where(eq(refundRequest.id, request.id))
      .returning()
    if (!updated) throw new Error('Refund decision disappeared')
    await audit(
      tx,
      updated,
      input.userId,
      `billing.refund_${status}`,
      { oldStatus: request.status, newStatus: status },
      input.ip ?? null,
    )
    return { request: updated, paid }
  })
  if (saved.request.status === 'approved') {
    const provider = providerFor(options, saved.paid)
    if (provider.capabilities.refundsViaApi) {
      const [ack] = await options.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, saved.request.id),
            eq(auditLog.action, 'billing.refund_api_acknowledged'),
          ),
        )
      if (!ack) {
        if (!provider.refund || !saved.request.approvedAmount)
          throw new Error('Invalid approved refund')
        const result = await provider.refund({
          providerPaymentId: saved.paid.providerPaymentId,
          kind: saved.paid.kind,
          currency: saved.paid.currency,
          amount: saved.request.approvedAmount,
          idempotencyKey: `refund:${saved.request.id}`,
        })
        if (!result.providerRefundId.trim())
          throw new Error('Provider returned an empty refund identity')
        await options.db.transaction(async (tx) => {
          const { request, paid } = await lockedRequest(tx, saved.request.id)
          if (request.providerRefundId && request.providerRefundId !== result.providerRefundId)
            throw new Error('Refund acknowledgment identity changed')
          const [settled] = await tx
            .select()
            .from(paymentRefund)
            .where(
              and(
                eq(paymentRefund.paymentId, paid.id),
                eq(paymentRefund.provider, paid.provider),
                eq(paymentRefund.providerRefundId, result.providerRefundId),
              ),
            )
          if (settled && settled.amount !== request.approvedAmount)
            throw new Error('Refund acknowledgment amount mismatch')
          await tx
            .update(refundRequest)
            .set({
              providerRefundId: result.providerRefundId,
              ...(settled ? { status: 'refunded' as const } : {}),
            })
            .where(eq(refundRequest.id, request.id))
          const [recorded] = await tx
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.targetId, request.id),
                eq(auditLog.action, 'billing.refund_api_acknowledged'),
              ),
            )
          if (!recorded)
            await audit(
              tx,
              request,
              input.userId,
              'billing.refund_api_acknowledged',
              {
                providerRefundId: result.providerRefundId,
              },
              input.ip ?? null,
            )
        })
      }
    }
  }
  const [current] = await options.db
    .select()
    .from(refundRequest)
    .where(eq(refundRequest.id, saved.request.id))
  if (!current) throw new Error('Refund request disappeared')
  await notify(options, current)
  return current
}

/** Retry delivery independently of money movement after an observable mail failure. */
export async function retryRefundNotification(
  options: RefundServiceOptions,
  input: { userId: string; requestId: string },
): Promise<void> {
  const request = await options.db.transaction(async (tx) => {
    await admin(tx, input.userId)
    const { request } = await lockedRequest(tx, input.requestId)
    if (request.status === 'pending')
      fail('REFUND_NOT_REVIEWED', 'Refund has not been reviewed', 409)
    return request
  })
  await notify(options, request)
}

/** Explicit platform evidence is mandatory; settlement uses the exact webhook identity and consumer. */
export async function markManualRefund(
  options: RefundServiceOptions,
  input: {
    userId: string
    ip?: string | null
    requestId: string
    providerRefundId: string
    proof: string
  },
): Promise<RefundRequest> {
  const providerRefundId = text(input.providerRefundId, 'Platform refund identity')
  const proof = text(input.proof, 'Platform refund proof')
  const request = await options.db.transaction(async (tx) => {
    await admin(tx, input.userId)
    const { request, paid } = await lockedRequest(tx, input.requestId)
    if (providerFor(options, paid).capabilities.refundsViaApi)
      fail('MANUAL_REFUND_NOT_ALLOWED', 'This provider requires API refunds', 409)
    if (!['approved', 'refunded'].includes(request.status) || !request.approvedAmount)
      fail('REFUND_NOT_APPROVED', 'Refund needs an approved decision', 409)
    const [recorded] = await tx
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, request.id),
          eq(auditLog.action, 'billing.refund_manual_confirmed'),
        ),
      )
    if (recorded) {
      const evidence = recorded.meta as { providerRefundId?: string; proof?: string } | null
      if (evidence?.providerRefundId !== providerRefundId || evidence?.proof !== proof)
        fail('REFUND_DECISION_IMMUTABLE', 'Manual refund evidence cannot be changed', 409)
      return request
    }
    if (request.status === 'refunded') fail('REFUND_ALREADY_SETTLED', 'Refund already settled', 409)
    await applyBillingEvent(
      tx,
      {
        type: 'payment.refunded',
        provider: paid.provider,
        providerPaymentId: paid.providerPaymentId,
        providerRefundId,
        amount: request.approvedAmount,
        currency: paid.currency,
        refundedAmount: null,
        occurredAt: clock(options),
        raw: { proof },
      },
      { associations: new Map() },
      { now: () => clock(options) },
    )
    const [updated] = await tx
      .update(refundRequest)
      .set({ status: 'refunded' })
      .where(eq(refundRequest.id, request.id))
      .returning()
    if (!updated) throw new Error('Refund disappeared')
    await audit(
      tx,
      updated,
      input.userId,
      'billing.refund_manual_confirmed',
      {
        providerRefundId,
        proof,
      },
      input.ip ?? null,
    )
    return updated
  })
  await notify(options, request)
  return request
}
