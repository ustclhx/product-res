import { subscription } from '@product-res/db'
import { and, eq } from 'drizzle-orm'
import type { WebhookTransaction } from '../pipeline.ts'
import { checkWinner } from './shared.ts'
import type { BillingTarget, BillingTargetEvent } from './target.ts'

/** Applies provider subscription state; stale, compensated or deleted targets are ignored. */
export async function applySubscriptionChange(
  tx: WebhookTransaction,
  event: Exclude<BillingTargetEvent, { type: 'payment.succeeded' }>,
  { a, id, compensated, deleted, sub }: BillingTarget,
) {
  if (
    !sub ||
    compensated ||
    deleted ||
    event.occurredAt < sub.lastEventAt ||
    event.type === 'checkout.completed' ||
    event.type === 'subscription.renewed'
  )
    return
  let changes: Partial<typeof subscription.$inferInsert> = {
    lastEventAt: event.occurredAt,
    raw: event.raw,
  }
  if (event.type === 'subscription.activated' || event.type === 'subscription.updated') {
    const s = event.subscription
    const scheduledPause =
      event.provider === 'paypal' &&
      sub.cancelAtPeriodEnd &&
      ['paused', 'active', 'trialing'].includes(s.status)
    changes = {
      ...changes,
      planId: a.plan.id,
      planPriceId: a.price.id,
      status: scheduledPause ? 'canceled' : s.status,
      cancelAtPeriodEnd:
        event.provider === 'paypal' && sub.cancelAtPeriodEnd ? true : s.cancelAtPeriodEnd,
      canceledAt: scheduledPause ? (sub.canceledAt ?? event.occurredAt) : s.canceledAt,
      trialEnd: s.trialEnd,
      pastDueSince: s.pastDueSince,
      raw: s.raw,
    }
    if (
      !sub.currentPeriodEnd ||
      (s.currentPeriodEnd && s.currentPeriodEnd >= sub.currentPeriodEnd)
    ) {
      changes.currentPeriodStart = s.currentPeriodStart
      changes.currentPeriodEnd = s.currentPeriodEnd
    }
  } else if (event.type === 'subscription.past_due') {
    changes.status =
      event.provider === 'paypal' && sub.cancelAtPeriodEnd && event.status === 'paused'
        ? 'canceled'
        : event.status
    changes.pastDueSince = event.pastDueSince
  } else if (event.type === 'subscription.canceled') {
    changes.status = event.status
    changes.canceledAt = event.canceledAt
    if (
      event.currentPeriodEnd &&
      (!sub.currentPeriodEnd || event.currentPeriodEnd >= sub.currentPeriodEnd)
    )
      changes.currentPeriodEnd = event.currentPeriodEnd
  }
  await checkWinner(
    tx,
    a,
    event,
    id,
    changes.status ?? sub.status,
    changes.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd,
  )
  await tx
    .update(subscription)
    .set(changes)
    .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, a.workspaceId)))
}
