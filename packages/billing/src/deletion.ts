import type { DeletionContext, DeletionStep, DeletionTransaction } from '@product-res/auth'
import { type CreditsTransaction, revokeWorkspaceCredits } from '@product-res/credits'
import { type Database, payment, refundRequest, subscription } from '@product-res/db'
import * as schema from '@product-res/db/schema'
import { AppError } from '@product-res/shared'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { type BillingProviders, lockWorkspaceBilling } from './events.ts'
import { auditSubscriptionChange } from './subscription-audit.ts'

export interface BillingDeletionOptions {
  providers: BillingProviders
  refundWindowDays: number
  now?: () => Date
}

function cutoff(days: number, now: Date) {
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(now.getTime()))
    throw new Error('Invalid deletion refund window or time')
  return new Date(now.getTime() - days * 86_400_000)
}

/** Read-only reminder: deletion never creates a request or issues a refund. */
export async function listDeletionRefundReminders(
  context: DeletionContext,
  refundWindowDays: number,
  now = new Date(),
) {
  const earliest = cutoff(refundWindowDays, now)
  if (!context.workspaceIds.length) return { eligiblePaymentIds: [], pendingRequests: [] }
  const [eligible, pendingRequests] = await Promise.all([
    context.db
      .select({ id: payment.id })
      .from(payment)
      .where(
        and(
          inArray(payment.workspaceId, [...context.workspaceIds]),
          eq(payment.status, 'succeeded'),
          gte(payment.paidAt, earliest),
          lte(payment.paidAt, now),
          sql`${payment.refundedAmount} < ${payment.amount}`,
        ),
      )
      .orderBy(desc(payment.paidAt), desc(payment.id)),
    context.db
      .select()
      .from(refundRequest)
      .where(
        and(
          inArray(refundRequest.workspaceId, [...context.workspaceIds]),
          eq(refundRequest.status, 'pending'),
        ),
      )
      .orderBy(desc(refundRequest.createdAt), desc(refundRequest.id)),
  ])
  return { eligiblePaymentIds: eligible.map((row) => row.id), pendingRequests }
}

function retry(): never {
  throw new AppError(
    'BILLING_DELETION_RETRY',
    'Subscriptions changed during cancellation; retry deletion',
    { status: 409 },
  )
}

async function subscriptions(db: Database | CreditsTransaction, context: DeletionContext) {
  if (!context.workspaceIds.length) return []
  return db
    .select()
    .from(subscription)
    .where(inArray(subscription.workspaceId, [...context.workspaceIds]))
    .orderBy(subscription.id)
}

/** Request-scoped step. Remote cancellation survives a later database rollback. */
export function createBillingDeletionStep(options: BillingDeletionOptions): DeletionStep {
  cutoff(options.refundWindowDays, options.now?.() ?? new Date())
  // The same context is passed to before/execute by auth; no module-global provider state.
  const prepared = new WeakMap<DeletionContext, string>()
  return {
    async before(context) {
      prepared.delete(context)
      const rows = await subscriptions(context.db, context)
      const version = JSON.stringify(rows)
      for (const row of rows) {
        if (row.provider === 'stripe' && ['canceled', 'expired'].includes(row.status)) continue
        const provider = options.providers[row.provider]
        if (!provider || provider.id !== row.provider)
          throw new AppError(
            'BILLING_PROVIDER_UNAVAILABLE',
            `Missing billing provider: ${row.provider}`,
            { status: 503 },
          )
        const remote = await provider.getSubscription(row.providerSubscriptionId)
        if (remote.providerSubscriptionId !== row.providerSubscriptionId)
          throw new AppError(
            'BILLING_SUBSCRIPTION_MISMATCH',
            'Provider returned a different subscription',
            { status: 409 },
          )
        const terminal =
          row.provider === 'paypal'
            ? ['CANCELLED', 'EXPIRED'].includes(remote.remoteStatus.toUpperCase())
            : ['canceled', 'expired'].includes(remote.status)
        // PayPal SUSPENDED is reversible, including local canceled + cancelAtPeriodEnd.
        if (!terminal)
          await provider.cancelSubscription(row.providerSubscriptionId, { atPeriodEnd: false })
      }
      if (JSON.stringify(await subscriptions(context.db, context)) !== version) retry()
      prepared.set(context, version)
    },
    async execute(context, client: DeletionTransaction) {
      const version = prepared.get(context)
      if (version === undefined) retry()
      // Wrap the caller's raw transaction; never start or replace a transaction here.
      // Cast kept: drizzle() over TransactionSql types as a database, not PgTransaction, so pass it as credits' explicit tx.
      const tx = drizzle(
        Object.assign(client, {
          options: context.db.$client.options,
        }) as unknown as Database['$client'],
        { schema },
      ) as unknown as CreditsTransaction
      for (const workspaceId of [...new Set(context.workspaceIds)].sort())
        await lockWorkspaceBilling(tx, workspaceId)
      if (JSON.stringify(await subscriptions(tx, context)) !== version) retry()
      const now = options.now?.() ?? new Date()
      // Snapshot the original applicant email before auth anonymizes it. Existing contacts win.
      await client`update refund_request r set contact_email=u.email from "user" u
        where r.user_id=u.id and r.user_id=${context.actorUserId} and r.status='pending'
        and r.contact_email is null and u.email<>${`deleted+${context.actorUserId}@invalid`}`
      const before = await subscriptions(tx, context)
      for (const workspaceId of [...new Set(context.workspaceIds)].sort()) {
        await tx
          .update(subscription)
          .set({ status: 'canceled', cancelAtPeriodEnd: false, canceledAt: now, updatedAt: now })
          .where(eq(subscription.workspaceId, workspaceId))
        await revokeWorkspaceCredits(context.db, workspaceId, tx)
      }
      for (const after of await subscriptions(tx, context))
        await auditSubscriptionChange(
          tx,
          before.find((row) => row.id === after.id),
          after,
          'deletion',
          context.actorUserId,
          context.ip ?? null,
        )
      prepared.delete(context)
    },
  }
}
