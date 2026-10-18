import {
  auditLog,
  type BillingCompensation,
  billingCompensation,
  type Database,
  payment,
  subscription,
} from '@product-res/db'
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { billingErrorMessage } from './errors.ts'
import {
  type BillingProviders,
  lockWorkspaceBilling,
  type PreparedBillingEvents,
  RenewingSubscriptionConflict,
} from './events.ts'
import type { WebhookFailure } from './pipeline.ts'
import { auditSubscriptionChange } from './subscription-audit.ts'

/** Only a known domain conflict can create a durable compensation after rollback. */
export async function persistCompensation(db: Database, cause: unknown) {
  if (!(cause instanceof RenewingSubscriptionConflict)) return
  const { workspaceId, ...payload } = cause.compensation
  const key = `${payload.provider}:${payload.providerSubscriptionId}:${payload.payment?.providerPaymentId ?? 'activation'}`
  return db.transaction(async (tx) => {
    await lockWorkspaceBilling(tx, workspaceId)
    const [inserted] = await tx
      .insert(billingCompensation)
      .values({ workspaceId, key, payload })
      .onConflictDoNothing({ target: billingCompensation.key })
      .returning()
    if (inserted)
      await tx.insert(auditLog).values({
        workspaceId,
        action: 'billing.subscription_compensation_required',
        targetType: 'billing_compensation',
        targetId: inserted.id,
        meta: {
          provider: payload.provider,
          providerSubscriptionId: payload.providerSubscriptionId,
          winnerSubscriptionId: payload.winnerSubscriptionId,
        },
      })
    return (
      inserted ??
      (await tx.select().from(billingCompensation).where(eq(billingCompensation.key, key)))[0]
    )
  })
}

export function createCompensationFailureHandler(db: Database) {
  return async (failure: WebhookFailure<PreparedBillingEvents>) => {
    await persistCompensation(db, failure.cause)
  }
}

async function recordLosingReceipt(db: Database, job: BillingCompensation) {
  const p = job.payload
  await db.transaction(async (tx) => {
    await lockWorkspaceBilling(tx, job.workspaceId)
    const [before] = await tx
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.provider, p.provider),
          eq(subscription.providerSubscriptionId, p.providerSubscriptionId),
        ),
      )
    await tx
      .insert(subscription)
      .values({
        workspaceId: job.workspaceId,
        provider: p.provider,
        providerSubscriptionId: p.providerSubscriptionId,
        planId: p.planId,
        planPriceId: p.planPriceId,
        status: 'canceled',
        cancelAtPeriodEnd: false,
        canceledAt: new Date(),
        currentPeriodEnd: null,
        lastEventAt: new Date(),
        raw: {},
      })
      .onConflictDoNothing({ target: [subscription.provider, subscription.providerSubscriptionId] })
    const [sub] = await tx
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.provider, p.provider),
          eq(subscription.providerSubscriptionId, p.providerSubscriptionId),
        ),
      )
    if (!sub || sub.workspaceId !== job.workspaceId)
      throw new Error('Compensation subscription association mismatch')
    await tx
      .update(subscription)
      .set({
        status: 'canceled',
        cancelAtPeriodEnd: false,
        canceledAt: new Date(),
        currentPeriodEnd: null,
      })
      .where(eq(subscription.id, sub.id))
    const [after] = await tx.select().from(subscription).where(eq(subscription.id, sub.id))
    if (after) await auditSubscriptionChange(tx, before, after, 'compensation')
    if (!p.payment) return
    const receipt = p.payment
    await tx
      .insert(payment)
      .values({
        workspaceId: job.workspaceId,
        subscriptionId: sub.id,
        provider: p.provider,
        providerPaymentId: receipt.providerPaymentId,
        kind: receipt.kind,
        planPriceId: p.planPriceId,
        amount: receipt.amount,
        currency: receipt.currency,
        paidAt: new Date(receipt.paidAt),
        periodStart: new Date(receipt.periodStart),
        periodEnd: new Date(receipt.periodEnd),
        status: 'succeeded',
        refundedAmount: 0,
      })
      .onConflictDoNothing({ target: [payment.provider, payment.providerPaymentId] })
    const [paid] = await tx
      .select()
      .from(payment)
      .where(
        and(
          eq(payment.provider, p.provider),
          eq(payment.providerPaymentId, receipt.providerPaymentId),
        ),
      )
    if (
      !paid ||
      paid.workspaceId !== job.workspaceId ||
      paid.subscriptionId !== sub.id ||
      paid.planPriceId !== p.planPriceId ||
      paid.amount !== receipt.amount ||
      paid.currency !== receipt.currency ||
      paid.kind !== receipt.kind ||
      paid.paidAt.getTime() !== new Date(receipt.paidAt).getTime() ||
      paid.periodStart?.getTime() !== new Date(receipt.periodStart).getTime() ||
      paid.periodEnd?.getTime() !== new Date(receipt.periodEnd).getTime()
    )
      throw new Error('Compensation payment provenance mismatch')
  })
}

/** Bounded leases and fenced checkpoints; all provider calls run after the claim transaction commits. */
export async function runPendingCompensations(options: {
  db: Database
  providers: BillingProviders
  limit?: number
  leaseMs?: number
  now?: () => Date
}) {
  const { db, providers } = options
  const limit = options.limit ?? 25
  const leaseMs = options.leaseMs ?? 300_000
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 3_600_000
  )
    throw new Error('Invalid compensation lease or batch limit')
  const now = options.now?.() ?? new Date()
  const jobs = await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(billingCompensation)
      .where(
        or(
          eq(billingCompensation.status, 'pending'),
          and(
            eq(billingCompensation.status, 'processing'),
            or(isNull(billingCompensation.leaseUntil), lte(billingCompensation.leaseUntil, now)),
          ),
        ),
      )
      .orderBy(asc(billingCompensation.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    const claimed: BillingCompensation[] = []
    for (const job of pending) {
      const [row] = await tx
        .update(billingCompensation)
        .set({
          status: 'processing',
          attempts: sql`${billingCompensation.attempts} + 1`,
          leaseUntil: new Date(now.getTime() + leaseMs),
          error: null,
        })
        .where(eq(billingCompensation.id, job.id))
        .returning()
      if (row) claimed.push(row)
    }
    return claimed
  })
  let completed = 0,
    failed = 0
  for (const job of jobs) {
    const fence = and(
      eq(billingCompensation.id, job.id),
      eq(billingCompensation.attempts, job.attempts),
      eq(billingCompensation.status, 'processing'),
    )
    try {
      const provider = providers[job.payload.provider]
      if (!provider || provider.id !== job.payload.provider)
        throw new Error('Missing compensation billing provider')
      if (!job.cancelCompleted) {
        const remote = await provider.getSubscription(job.payload.providerSubscriptionId)
        if (remote.providerSubscriptionId !== job.payload.providerSubscriptionId)
          throw new Error('Compensation remote subscription mismatch')
        const terminal =
          provider.id === 'paypal'
            ? ['CANCELLED', 'EXPIRED'].includes(remote.remoteStatus.toUpperCase())
            : ['canceled', 'expired'].includes(remote.status)
        if (!terminal)
          await provider.cancelSubscription(job.payload.providerSubscriptionId, {
            atPeriodEnd: false,
          })
        const saved = await db
          .update(billingCompensation)
          .set({ cancelCompleted: true })
          .where(fence)
          .returning()
        if (!saved.length) continue
      }
      const deletionOnly = job.payload.reason === 'workspace_deleted'
      if (!deletionOnly) await recordLosingReceipt(db, job)
      const receipt = deletionOnly ? undefined : job.payload.payment
      if (receipt && !job.providerRefundId) {
        if (!provider.capabilities.refundsViaApi || !provider.refund)
          throw new Error('Compensation refund adapter unavailable')
        const actual = await provider.getPayment({
          providerPaymentId: receipt.providerPaymentId,
          kind: receipt.kind,
        })
        if (
          actual.providerPaymentId !== receipt.providerPaymentId ||
          actual.kind !== receipt.kind ||
          actual.providerSubscriptionId !== job.payload.providerSubscriptionId ||
          actual.amount !== receipt.amount ||
          actual.currency.toUpperCase() !== receipt.currency ||
          actual.paidAt.toISOString() !== receipt.paidAt ||
          actual.period?.start.toISOString() !== receipt.periodStart ||
          actual.period?.end.toISOString() !== receipt.periodEnd
        )
          throw new Error('Compensation verified payment mismatch')
        const [local] = await db
          .select()
          .from(payment)
          .where(
            and(
              eq(payment.provider, job.payload.provider),
              eq(payment.providerPaymentId, receipt.providerPaymentId),
            ),
          )
        const total = Math.max(
          actual.refundedAmount ?? 0,
          local?.refundedAmount ?? 0,
          receipt.refundedAmount ?? 0,
        )
        if (!Number.isSafeInteger(total) || total < 0 || total > actual.amount)
          throw new Error('Compensation invalid verified refund total')
        const remaining = actual.amount - total
        if (remaining > 0) {
          const result = await provider.refund({
            providerPaymentId: receipt.providerPaymentId,
            kind: receipt.kind,
            amount: remaining,
            currency: receipt.currency,
            idempotencyKey: `compensation:${job.id}`,
          })
          if (!result.providerRefundId.trim())
            throw new Error('Missing compensation refund identity')
          const saved = await db
            .update(billingCompensation)
            .set({ providerRefundId: result.providerRefundId })
            .where(fence)
            .returning()
          if (!saved.length) continue
        }
      }
      await db.transaction(async (tx) => {
        const saved = await tx
          .update(billingCompensation)
          .set({ status: 'completed', leaseUntil: null, error: null })
          .where(fence)
          .returning()
        if (saved.length) {
          await tx.insert(auditLog).values({
            workspaceId: job.workspaceId,
            action: 'billing.subscription_compensated',
            targetType: 'billing_compensation',
            targetId: job.id,
            meta: deletionOnly
              ? { reason: 'workspace_deleted', settlement: 'canceled_without_refund' }
              : { settlement: 'awaiting_verified_webhook' },
          })
          completed++
        }
      })
    } catch (cause) {
      const error = billingErrorMessage(cause, 'Compensation failed')
      await db.transaction(async (tx) => {
        const saved = await tx
          .update(billingCompensation)
          .set({ status: 'pending', leaseUntil: null, error })
          .where(fence)
          .returning()
        if (saved.length)
          await tx.insert(auditLog).values({
            workspaceId: job.workspaceId,
            action: 'billing.subscription_compensation_failed',
            targetType: 'billing_compensation',
            targetId: job.id,
            meta: { error },
          })
      })
      failed++
    }
  }
  return { claimed: jobs.length, completed, failed }
}
