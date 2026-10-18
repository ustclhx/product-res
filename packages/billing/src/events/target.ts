import {
  auditLog,
  billingCompensation,
  organization,
  purchase,
  type Subscription,
  subscription,
} from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import type { WebhookTransaction } from '../pipeline.ts'
import type { NormalizedEvent } from '../provider.ts'
import {
  type Association,
  checkWinner,
  conflictPayment,
  customer,
  lockWorkspaceBilling,
  orderScope,
  type PreparedBillingEvents,
  RenewingSubscriptionConflict,
  scope,
  validateMetadata,
} from './shared.ts'

/** Every event except payment reversals targets a prepared purchase or subscription. */
export type BillingTargetEvent = Exclude<
  NormalizedEvent,
  { type: 'payment.refunded' | 'payment.disputed' }
>
export interface BillingTarget {
  a: Association
  id: string
  compensated: boolean
  deleted: boolean
  sub: Subscription | undefined
  purchaseId: string | undefined
}
async function ensurePurchase(
  tx: WebhookTransaction,
  event: BillingTargetEvent,
  a: Association,
  id: string,
) {
  let [existing] = await tx.select().from(purchase).where(orderScope(event.provider, id))
  if (existing && existing.workspaceId !== a.workspaceId)
    throw new Error('Order workspace association changed')
  if (!existing) {
    await validateMetadata(tx, a.metadata, event.type === 'payment.succeeded')
    if (!a.metadata || a.plan.type !== 'credit_pack') throw new Error('Missing purchase metadata')
    ;[existing] = await tx
      .insert(purchase)
      .values({
        workspaceId: a.workspaceId,
        userId: a.metadata.userId,
        planId: a.plan.id,
        planPriceId: a.price.id,
        provider: event.provider,
        providerOrderId: id,
        amount: a.price.amount,
        currency: a.price.currency,
        raw: event.raw,
      })
      .returning()
  }
  if (!existing) throw new Error('Purchase insert failed')
  return existing.id
}
async function ensureSubscription(
  tx: WebhookTransaction,
  event: BillingTargetEvent,
  a: Association,
  id: string,
  compensated: boolean,
  deleted: boolean,
) {
  let [sub] = await tx.select().from(subscription).where(scope(event.provider, id))
  if (sub && sub.workspaceId !== a.workspaceId)
    throw new Error('Subscription workspace association changed')
  if (!sub) {
    if (!compensated) await validateMetadata(tx, a.metadata, deleted)
    const snapshot = a.snapshot
    if (!snapshot || !('providerSubscriptionId' in snapshot))
      throw new Error('Missing subscription repair snapshot')
    if (!compensated && !deleted)
      await checkWinner(tx, a, event, id, snapshot.status, snapshot.cancelAtPeriodEnd)
    ;[sub] = await tx
      .insert(subscription)
      .values({
        workspaceId: a.workspaceId,
        planId: a.plan.id,
        planPriceId: a.price.id,
        provider: event.provider,
        providerSubscriptionId: id,
        status: compensated || deleted ? 'canceled' : snapshot.status,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: compensated || deleted ? null : snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        canceledAt: snapshot.canceledAt,
        trialEnd: snapshot.trialEnd,
        pastDueSince: snapshot.pastDueSince,
        lastEventAt: event.occurredAt,
        raw: snapshot.raw,
      })
      .returning()
  }
  if (!sub) throw new Error('Subscription insert failed')
  if (deleted) {
    const [job] = await tx
      .insert(billingCompensation)
      .values({
        workspaceId: a.workspaceId,
        key: `deleted:${event.provider}:${id}`,
        payload: {
          reason: 'workspace_deleted',
          provider: event.provider,
          providerSubscriptionId: id,
          planId: a.plan.id,
          planPriceId: a.price.id,
        },
      })
      .onConflictDoNothing({ target: billingCompensation.key })
      .returning()
    if (job)
      await tx.insert(auditLog).values({
        workspaceId: a.workspaceId,
        action: 'billing.subscription_compensation_required',
        targetType: 'billing_compensation',
        targetId: job.id,
        meta: {
          reason: 'workspace_deleted',
          provider: event.provider,
          providerSubscriptionId: id,
        },
      })
  }
  if (compensated || deleted)
    await tx
      .update(subscription)
      .set({ status: 'canceled', cancelAtPeriodEnd: false, currentPeriodEnd: null })
      .where(eq(subscription.id, sub.id))
  return sub
}
/** Acquires the workspace billing lock, then reconciles compensation, the local object and customer. */
export async function resolveBillingTarget(
  tx: WebhookTransaction,
  event: BillingTargetEvent,
  prepared: PreparedBillingEvents,
): Promise<BillingTarget> {
  const oneTime =
    (event.type === 'checkout.completed' && event.mode === 'one_time') ||
    (event.type === 'payment.succeeded' && event.payment.kind === 'one_time')
  const id =
    event.type === 'checkout.completed'
      ? event.mode === 'one_time'
        ? event.providerOrderId
        : event.providerSubscriptionId
      : event.type === 'payment.succeeded'
        ? event.payment.kind === 'one_time'
          ? event.payment.providerOrderId
          : event.payment.providerSubscriptionId
        : 'subscription' in event
          ? event.subscription.providerSubscriptionId
          : event.providerSubscriptionId
  const a = prepared.associations.get(event)
  if (!a) throw new Error('Billing event was not prepared')
  await lockWorkspaceBilling(tx, a.workspaceId)
  const [workspace] = await tx.select().from(organization).where(eq(organization.id, a.workspaceId))
  const deleted = Boolean(workspace?.deletedAt)
  const jobs = await tx
    .select()
    .from(billingCompensation)
    .where(
      and(
        eq(billingCompensation.workspaceId, a.workspaceId),
        sql`${billingCompensation.payload}->>'provider' = ${event.provider}`,
        sql`${billingCompensation.payload}->>'providerSubscriptionId' = ${id}`,
        sql`coalesce(${billingCompensation.payload}->>'reason', '') <> 'workspace_deleted'`,
      ),
    )
  const existingCompensation = jobs[0]
  const compensated = !oneTime && Boolean(existingCompensation)
  if (
    existingCompensation &&
    existingCompensation.payload.reason !== 'workspace_deleted' &&
    !oneTime &&
    event.type === 'payment.succeeded' &&
    event.payment.kind !== 'one_time' &&
    !jobs.some((job) => job.payload.payment?.providerPaymentId === event.payment.providerPaymentId)
  ) {
    throw new RenewingSubscriptionConflict({
      workspaceId: a.workspaceId,
      provider: event.provider,
      providerSubscriptionId: id,
      winnerSubscriptionId: existingCompensation.payload.winnerSubscriptionId,
      planId: a.plan.id,
      planPriceId: a.price.id,
      ...conflictPayment(event, a),
    })
  }
  if (compensated && event.type === 'payment.succeeded') {
    const p = event.payment
    const receipt = jobs.find(
      (job) => job.payload.payment?.providerPaymentId === p.providerPaymentId,
    )?.payload.payment
    if (
      !receipt ||
      receipt.kind !== p.kind ||
      receipt.amount !== p.amount ||
      receipt.currency !== p.currency.toUpperCase() ||
      receipt.paidAt !== p.paidAt.toISOString() ||
      receipt.periodStart !== p.period?.start.toISOString() ||
      receipt.periodEnd !== p.period?.end.toISOString()
    )
      throw new Error('Compensation payment replay provenance mismatch')
  }
  const customerId =
    event.type === 'payment.succeeded'
      ? (event.payment.providerCustomerId ?? a.snapshot?.providerCustomerId ?? null)
      : event.type === 'checkout.completed'
        ? event.providerCustomerId
        : (a.snapshot?.providerCustomerId ?? null)
  let sub: Subscription | undefined
  let purchaseId: string | undefined
  if (oneTime) purchaseId = await ensurePurchase(tx, event, a, id)
  else sub = await ensureSubscription(tx, event, a, id, compensated, deleted)
  await customer(tx, a.workspaceId, event.provider, customerId)
  return { a, id, compensated, deleted, sub, purchaseId }
}
