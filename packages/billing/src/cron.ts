import {
  type CreditsTransaction,
  expireWorkspaceCredits,
  lockWorkspaceCredits,
  reconcileWorkspaceCredits,
} from '@product-res/credits'
import {
  auditLog,
  type CreditHold,
  creditGrant,
  creditHold,
  type Database,
  organization,
  payment,
  plan,
  planPrice,
  refundRequest,
  subscription,
} from '@product-res/db'
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { billingErrorMessage } from './errors.ts'
import {
  applyBillingEvent,
  type BillingProviders,
  grantSubscriptionMonth,
  lockWorkspaceBilling,
  prepareBillingEvents,
  subscriptionMonthAnchor,
} from './events.ts'
import type { NormalizedEvent } from './provider.ts'

export interface CronFailure {
  job: string
  workspaceId: string
  targetId: string
  error: string
}
export interface CronOptions {
  /** Called after a durable audit entry; callback failures propagate to the scheduler. */
  alert?: (failure: CronFailure) => void | Promise<void>
}
export interface CronResult {
  processed: number
  failures: CronFailure[]
}
async function failed(
  db: Database,
  result: CronResult,
  options: CronOptions,
  job: string,
  workspaceId: string,
  targetId: string,
  error: unknown,
) {
  const failure = { job, workspaceId, targetId, error: billingErrorMessage(error) }
  result.failures.push(failure)
  await db.insert(auditLog).values({
    workspaceId,
    action: `billing.cron.${job}.failed`,
    targetId,
    meta: { error: failure.error },
  })
  await options.alert?.(failure)
}

/** Expire even fully reserved grants; allocations settle through the credits API later. */
export async function runCreditExpiration(
  db: Database,
  now = new Date(),
  options: CronOptions = {},
): Promise<CronResult> {
  const workspaces = await db
    .selectDistinct({ workspaceId: creditGrant.workspaceId })
    .from(creditGrant)
    .where(and(eq(creditGrant.status, 'active'), lte(creditGrant.expiresAt, now)))
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        await expireWorkspaceCredits(db, workspaceId, tx, now)
      })
      result.processed++
    } catch (error) {
      await failed(db, result, options, 'expiration', workspaceId, workspaceId, error)
    }
  }
  return result
}

/**
 * Historical payment periods and prices determine month 0..11, including inactive prices.
 * Late months retain retrospective expiry and expire in the same transaction: no
 * spendable resurrection. Only source claims persist; no in-memory execution history.
 */
export async function runAnnualGrants(
  db: Database,
  now = new Date(),
  options: CronOptions & { subscriptionCreditGraceHours?: number } = {},
): Promise<CronResult> {
  const workspaces = await db
    .selectDistinct({ workspaceId: payment.workspaceId })
    .from(payment)
    .innerJoin(planPrice, eq(planPrice.id, payment.planPriceId))
    .where(
      and(
        // 部分退款的年付继续按未退款份额发放后续月份；全额退款与争议停止发放。
        inArray(payment.status, ['succeeded', 'partially_refunded']),
        lt(payment.refundedAmount, payment.amount),
        inArray(payment.kind, ['initial', 'renewal']),
        eq(planPrice.interval, 'year'),
        lte(payment.periodStart, now),
      ),
    )
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      const count = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        const rows = await tx
          .select({ paid: payment, price: planPrice, selectedPlan: plan })
          .from(payment)
          .innerJoin(planPrice, eq(planPrice.id, payment.planPriceId))
          .innerJoin(plan, eq(plan.id, planPrice.planId))
          .innerJoin(subscription, eq(subscription.id, payment.subscriptionId))
          .innerJoin(organization, eq(organization.id, payment.workspaceId))
          .where(
            and(
              eq(payment.workspaceId, workspaceId),
              eq(subscription.workspaceId, workspaceId),
              isNull(organization.deletedAt),
              inArray(payment.status, ['succeeded', 'partially_refunded']),
              lt(payment.refundedAmount, payment.amount),
              inArray(payment.kind, ['initial', 'renewal']),
              eq(planPrice.interval, 'year'),
              or(
                inArray(subscription.status, ['active', 'trialing']),
                and(
                  eq(subscription.status, 'canceled'),
                  eq(subscription.cancelAtPeriodEnd, true),
                  lt(sql`${now.toISOString()}::timestamptz`, subscription.currentPeriodEnd),
                ),
              ),
            ),
          )
        let granted = 0
        for (const { paid, price, selectedPlan } of rows) {
          if (!paid.periodStart || !paid.periodEnd) throw new Error('Missing annual paid period')
          for (let month = 0; month < 12; month++) {
            const start = subscriptionMonthAnchor(paid.periodStart, month)
            if (start > now || start >= paid.periodEnd) break
            // Source identity is global, including revoked/expired grants and other workspaces.
            const [claimed] = await tx
              .select({ id: creditGrant.id })
              .from(creditGrant)
              .where(
                and(
                  eq(creditGrant.source, 'subscription'),
                  eq(creditGrant.sourceRef, `${paid.id}:${month}`),
                ),
              )
            if (claimed) continue
            const created = await grantSubscriptionMonth(
              tx,
              paid,
              price,
              selectedPlan,
              month,
              now,
              options.subscriptionCreditGraceHours ?? 24,
            )
            if (created) granted++
          }
        }
        await expireWorkspaceCredits(db, workspaceId, tx, now)
        return granted
      })
      result.processed += count
    } catch (error) {
      await failed(db, result, options, 'annual_grants', workspaceId, workspaceId, error)
    }
  }
  return result
}

export type HoldSweepHandler = (context: {
  db: Database
  /** DB-only handler: pass this transaction to credits.capture/release; no network I/O. */
  tx: CreditsTransaction
  hold: CreditHold
  now: Date
}) => Promise<void>
// Module-startup business handlers only; the finite refType set bounds this registry.
const holdSweepers = new Map<CreditHold['refType'], HoldSweepHandler>()
export function registerHoldSweeper(refType: CreditHold['refType'], handler: HoldSweepHandler) {
  if (holdSweepers.has(refType)) throw new Error(`Hold sweeper already registered: ${refType}`)
  holdSweepers.set(refType, handler)
  return () => {
    if (holdSweepers.get(refType) === handler) holdSweepers.delete(refType)
  }
}

/** DB-only business handlers own settlement; no AI-specific policies are installed here. */
export async function runHoldSweep(
  db: Database,
  now = new Date(),
  options: CronOptions = {},
): Promise<CronResult> {
  const holds = await db
    .select()
    .from(creditHold)
    .where(and(eq(creditHold.status, 'held'), lte(creditHold.expiresAt, now)))
  const result: CronResult = { processed: 0, failures: [] }
  for (const candidate of holds) {
    try {
      const handled = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, candidate.workspaceId)
        await lockWorkspaceCredits(tx, candidate.workspaceId)
        const [active] = await tx
          .select()
          .from(creditHold)
          .where(
            and(
              eq(creditHold.id, candidate.id),
              eq(creditHold.workspaceId, candidate.workspaceId),
              eq(creditHold.status, 'held'),
              lte(creditHold.expiresAt, now),
            ),
          )
        if (!active) return false
        const handler = holdSweepers.get(active.refType)
        if (!handler) throw new Error(`No hold sweeper registered: ${active.refType}`)
        await handler({ db, tx, hold: active, now })
        return true
      })
      if (handled) result.processed++
    } catch (error) {
      await failed(db, result, options, 'hold_sweep', candidate.workspaceId, candidate.id, error)
    }
  }
  return result
}

/** Fetch remote state outside transactions; normalization cannot synthesize payments. */
export async function runSubscriptionReconciliation(
  db: Database,
  providers: BillingProviders,
  options: CronOptions & { now?: () => Date } = {},
): Promise<CronResult> {
  const rows = await db
    .select()
    .from(subscription)
    .where(
      or(
        inArray(subscription.status, ['active', 'trialing', 'past_due', 'paused']),
        and(eq(subscription.status, 'canceled'), eq(subscription.cancelAtPeriodEnd, true)),
      ),
    )
  const result: CronResult = { processed: 0, failures: [] }
  for (const row of rows) {
    try {
      const provider = providers[row.provider]
      if (!provider || provider.id !== row.provider)
        throw new Error('Missing or wrong billing provider')
      const [current] = await db.select().from(subscription).where(eq(subscription.id, row.id))
      if (!current) continue
      const clock = options.now ?? (() => new Date())
      const fetchSnapshot = async () => {
        const remote = await provider.getSubscription(current.providerSubscriptionId)
        if (remote.providerSubscriptionId !== current.providerSubscriptionId)
          throw new Error('Remote billing object mismatch')
        return remote
      }
      let snapshot = await fetchSnapshot()
      // PayPal 终止后本地仍保留 cancelAtPeriodEnd=true，行会被再次选中；
      // 先读远端状态，已终止（CANCELLED/EXPIRED）时不再 cancel，保证幂等
      if (
        current.provider === 'paypal' &&
        current.cancelAtPeriodEnd &&
        current.currentPeriodEnd &&
        current.currentPeriodEnd <= clock() &&
        snapshot.status !== 'canceled' &&
        snapshot.status !== 'expired'
      ) {
        await provider.cancelSubscription(current.providerSubscriptionId, { atPeriodEnd: false })
        snapshot = await fetchSnapshot()
      }
      const now = clock()
      const event: NormalizedEvent = {
        provider: current.provider,
        type: 'subscription.updated',
        subscription: { ...snapshot, metadata: null },
        occurredAt: now,
        raw: snapshot.raw,
      }
      const prepared = await prepareBillingEvents([event], db, providers)
      await db.transaction((tx) => applyBillingEvent(tx, event, prepared, { now: () => now }))
      result.processed++
    } catch (error) {
      await failed(
        db,
        result,
        options,
        'subscription_reconciliation',
        row.workspaceId,
        row.id,
        error,
      )
    }
  }
  return result
}

export async function runCreditReconciliation(
  db: Database,
  options: CronOptions = {},
): Promise<CronResult> {
  const workspaces = await db.select({ workspaceId: organization.id }).from(organization)
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      const snapshot = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        return reconcileWorkspaceCredits(db, workspaceId, tx)
      })
      if (!snapshot.consistent)
        throw new Error(`Credit invariant difference: ${snapshot.difference}`)
      result.processed++
    } catch (error) {
      await failed(db, result, options, 'credit_reconciliation', workspaceId, workspaceId, error)
    }
  }
  return result
}

/** Approval is not resolution: refunded uses updatedAt (completion), rejected uses review time. */
export async function clearResolvedRefundContacts(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000)
  const cleared = await db
    .update(refundRequest)
    .set({ contactEmail: null })
    .where(
      and(
        isNotNull(refundRequest.contactEmail),
        or(
          and(
            eq(refundRequest.status, 'rejected'),
            lt(
              sql`coalesce(${refundRequest.reviewedAt}, ${refundRequest.updatedAt})`,
              sql`${cutoff.toISOString()}::timestamptz`,
            ),
          ),
          and(eq(refundRequest.status, 'refunded'), lt(refundRequest.updatedAt, cutoff)),
        ),
      ),
    )
    .returning({ id: refundRequest.id })
  return { cleared: cleared.length }
}
