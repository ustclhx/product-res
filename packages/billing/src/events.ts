import {
  auditLog,
  billingCompensation,
  type Database,
  payment,
  planPrice,
  purchase,
  subscription,
} from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { applyPaymentSucceeded } from './events/payments.ts'
import { applyPaymentDisputed, applyPaymentRefunded } from './events/refunds.ts'
import {
  type BillingEventOptions,
  type BillingProviders,
  lockWorkspaceBilling,
  money,
  orderScope,
  type PreparedBillingEvents,
  paymentScope,
  priceFor,
  scope,
  validateMetadata,
} from './events/shared.ts'
import { applySubscriptionChange } from './events/subscriptions.ts'
import { resolveBillingTarget } from './events/target.ts'
import type { WebhookContext, WebhookTransaction } from './pipeline.ts'
import type { NormalizedEvent, OrderSnapshot, SubscriptionSnapshot } from './provider.ts'
import { auditSubscriptionChange } from './subscription-audit.ts'

export { grantSubscriptionMonth, subscriptionMonthAnchor } from './events/grants.ts'
export {
  type BillingEventOptions,
  type BillingProviders,
  lockWorkspaceBilling,
  type PreparedBillingEvents,
  RenewingSubscriptionConflict,
} from './events/shared.ts'
/** Network enrichment only here, before the pipeline opens its processing transaction. */
export async function prepareBillingEvents(
  events: readonly NormalizedEvent[],
  db: Database,
  providers: BillingProviders,
): Promise<PreparedBillingEvents> {
  const prepared: PreparedBillingEvents = { associations: new Map() }
  for (const event of events) {
    let kind: 'subscription' | 'order'
    let id: string
    let snapshot: SubscriptionSnapshot | OrderSnapshot | undefined
    if (event.type === 'checkout.completed') {
      kind = event.mode === 'subscription' ? 'subscription' : 'order'
      id = event.mode === 'subscription' ? event.providerSubscriptionId : event.providerOrderId
    } else if (event.type === 'subscription.activated' || event.type === 'subscription.updated') {
      kind = 'subscription'
      id = event.subscription.providerSubscriptionId
      snapshot = event.subscription
    } else if (event.type === 'payment.succeeded') {
      kind = event.payment.kind === 'one_time' ? 'order' : 'subscription'
      id =
        event.payment.kind === 'one_time'
          ? event.payment.providerOrderId
          : event.payment.providerSubscriptionId
    } else if ('providerSubscriptionId' in event) {
      kind = 'subscription'
      id = event.providerSubscriptionId
    } else continue
    const associationKey = event
    const [local] =
      kind === 'subscription'
        ? await db.select().from(subscription).where(scope(event.provider, id))
        : await db.select().from(purchase).where(orderScope(event.provider, id))
    if (local) {
      const providerPriceId =
        event.type === 'payment.succeeded'
          ? (event.payment as typeof event.payment & { providerPriceId?: string | null })
              .providerPriceId
          : snapshot?.providerPriceId
      let priceId = local.planPriceId
      let recordedPrice: string | null = null
      if (event.type === 'payment.succeeded') {
        const [recorded] = await db
          .select()
          .from(payment)
          .where(paymentScope(event.provider, event.payment.providerPaymentId))
        if (recorded?.planPriceId) {
          priceId = recorded.planPriceId
          recordedPrice = recorded.planPriceId
        }
      }
      if (providerPriceId) {
        const [mapped] = await db
          .select()
          .from(planPrice)
          .where(
            and(
              eq(planPrice.provider, event.provider),
              eq(planPrice.providerPriceId, providerPriceId),
            ),
          )
        if (!mapped) throw new Error('Unknown provider price')
        if (recordedPrice && recordedPrice !== mapped.id)
          throw new Error('Payment provider price provenance mismatch')
        priceId = mapped.id
      }
      prepared.associations.set(associationKey, {
        workspaceId: local.workspaceId,
        ...(await priceFor(db, priceId, event.provider, providerPriceId, undefined, false)),
        metadata: null,
        snapshot,
      })
      continue
    }
    const [compensation] =
      kind === 'subscription'
        ? await db
            .select()
            .from(billingCompensation)
            .where(
              and(
                sql`${billingCompensation.payload}->>'provider' = ${event.provider}`,
                sql`${billingCompensation.payload}->>'providerSubscriptionId' = ${id}`,
                sql`coalesce(${billingCompensation.payload}->>'reason', '') <> 'workspace_deleted'`,
              ),
            )
            .limit(1)
        : []
    if (compensation) {
      const payload = compensation.payload
      prepared.associations.set(associationKey, {
        workspaceId: compensation.workspaceId,
        ...(await priceFor(
          db,
          payload.planPriceId,
          event.provider,
          undefined,
          payload.planId,
          false,
        )),
        metadata: null,
        snapshot: {
          providerSubscriptionId: id,
          providerCustomerId: null,
          providerPriceId: '',
          status: 'canceled',
          remoteStatus: 'canceled',
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          trialEnd: null,
          pastDueSince: null,
          metadata: null,
          raw: {},
        },
      })
      continue
    }
    if (!snapshot) {
      const provider = providers[event.provider]
      if (!provider || provider.id !== event.provider) throw new Error('Missing billing provider')
      snapshot =
        kind === 'subscription' ? await provider.getSubscription(id) : await provider.getOrder(id)
    }
    if (
      ('providerSubscriptionId' in snapshot
        ? snapshot.providerSubscriptionId
        : snapshot.providerOrderId) !== id
    )
      throw new Error('Remote billing object mismatch')
    const metadata = snapshot.metadata
    if (
      event.type === 'checkout.completed' &&
      (!metadata ||
        metadata.workspaceId !== event.metadata.workspaceId ||
        metadata.userId !== event.metadata.userId ||
        metadata.planPriceId !== event.metadata.planPriceId)
    )
      throw new Error('Checkout metadata repair mismatch')
    try {
      await validateMetadata(
        db,
        metadata,
        kind === 'subscription' || event.type === 'payment.succeeded',
      )
    } catch (error) {
      await db.insert(auditLog).values({
        action: 'billing.association_failed',
        targetType: kind,
        targetId: id,
        meta: { provider: event.provider },
      })
      throw error
    }
    if (!metadata) throw new Error('Missing billing association')
    const priced = await priceFor(
      db,
      metadata.planPriceId,
      event.provider,
      snapshot.providerPriceId,
    )
    if ((kind === 'subscription') !== (priced.plan.type === 'subscription'))
      throw new Error('Billing object plan mismatch')
    if ('providerOrderId' in snapshot) {
      money(snapshot.amount, snapshot.currency)
      if (
        snapshot.amount !== priced.price.amount ||
        snapshot.currency.toUpperCase() !== priced.price.currency.toUpperCase()
      )
        throw new Error('Order price mismatch')
    }
    prepared.associations.set(associationKey, {
      workspaceId: metadata.workspaceId,
      ...priced,
      metadata,
      snapshot,
    })
  }
  return prepared
}

export async function applyBillingEvent(
  tx: WebhookTransaction,
  event: NormalizedEvent,
  prepared: PreparedBillingEvents,
  options: Pick<BillingEventOptions, 'subscriptionCreditGraceHours' | 'now'> = {},
): Promise<void> {
  if (event.type === 'payment.disputed') return applyPaymentDisputed(tx, event)
  if (event.type === 'payment.refunded') return applyPaymentRefunded(tx, event, options)
  const association = prepared.associations.get(event)
  if (association) await lockWorkspaceBilling(tx, association.workspaceId)
  const before = association
    ? await tx
        .select()
        .from(subscription)
        .where(eq(subscription.workspaceId, association.workspaceId))
    : []
  const target = await resolveBillingTarget(tx, event, prepared)
  if (event.type === 'payment.succeeded') await applyPaymentSucceeded(tx, event, target, options)
  else await applySubscriptionChange(tx, event, target)
  if (target.sub) {
    const [after] = await tx.select().from(subscription).where(eq(subscription.id, target.sub.id))
    if (after)
      await auditSubscriptionChange(
        tx,
        before.find((row) => row.id === after.id),
        after,
        event.type,
      )
  }
}
export function createBillingEventHandler(options: BillingEventOptions) {
  return {
    prepare: (events: readonly NormalizedEvent[]) =>
      prepareBillingEvents(events, options.db, options.providers),
    handler: (
      tx: WebhookTransaction,
      event: NormalizedEvent,
      context: WebhookContext<PreparedBillingEvents>,
    ) => applyBillingEvent(tx, event, context.prepared, options),
  }
}
