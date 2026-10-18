import { grant, reducePaymentCredits } from '@product-res/credits'
import {
  organization,
  type Payment,
  type Plan,
  type PlanPrice,
  payment,
  subscription,
} from '@product-res/db'
import { and, eq } from 'drizzle-orm'
import type { WebhookTransaction } from '../pipeline.ts'
import { lockWorkspaceBilling } from './shared.ts'

/** UTC calendar arithmetic always derives from the original anchor (Jan 31 -> Feb 28 -> Mar 31). */
export function subscriptionMonthAnchor(anchor: Date, month: number) {
  const d = new Date(anchor)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + month)
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(anchor.getUTCDate(), days))
  return d
}
/** Shared by webhook and cron; reloads owned immutable provenance after acquiring billing lock. */
export async function grantSubscriptionMonth(
  tx: WebhookTransaction,
  paid: Payment,
  price: PlanPrice,
  selectedPlan: Plan,
  month: number,
  now = new Date(),
  graceHours = 24,
) {
  await lockWorkspaceBilling(tx, paid.workspaceId)
  const [workspace] = await tx
    .select()
    .from(organization)
    .where(eq(organization.id, paid.workspaceId))
  if (workspace?.deletedAt) return
  const [current] = await tx
    .select()
    .from(payment)
    .where(and(eq(payment.id, paid.id), eq(payment.workspaceId, paid.workspaceId)))
    .for('update')
  if (
    !current ||
    !['succeeded', 'partially_refunded'].includes(current.status) ||
    current.refundedAmount >= current.amount ||
    !['initial', 'renewal'].includes(current.kind)
  )
    throw new Error('Payment is not eligible for subscription grants')
  if (
    current.planPriceId !== price.id ||
    price.planId !== selectedPlan.id ||
    price.provider !== current.provider ||
    !current.periodStart ||
    !current.periodEnd ||
    selectedPlan.type !== 'subscription'
  )
    throw new Error('Subscription payment provenance mismatch')
  if (!Number.isInteger(month) || month < 0 || month >= (price.interval === 'year' ? 12 : 1))
    throw new Error('Invalid subscription grant month')
  if (!Number.isFinite(graceHours) || graceHours < 0)
    throw new Error('Invalid subscription credit grace')
  const start = subscriptionMonthAnchor(current.periodStart, month)
  // 首月以已验证的成功付款为准：平台测试时钟或提前付款可领先应用时间，年付后续月仍按应用时间发放。
  if ((month > 0 && start > now) || start >= current.periodEnd)
    throw new Error('Subscription grant month is not due')
  const [sub] = await tx
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.id, current.subscriptionId ?? ''),
        eq(subscription.workspaceId, current.workspaceId),
      ),
    )
  if (
    month > 0 &&
    (!sub ||
      (!['active', 'trialing'].includes(sub.status) &&
        !(
          sub.status === 'canceled' &&
          sub.cancelAtPeriodEnd &&
          sub.currentPeriodEnd &&
          now < sub.currentPeriodEnd
        )))
  )
    throw new Error('Subscription no longer eligible for monthly grants')
  if (selectedPlan.credits === 0) return
  const end =
    price.interval === 'year'
      ? new Date(
          Math.min(
            subscriptionMonthAnchor(current.periodStart, month + 1).getTime(),
            current.periodEnd.getTime(),
          ),
        )
      : current.periodEnd
  const expiresAt = selectedPlan.rollover
    ? selectedPlan.creditExpiryDays === null
      ? null
      : new Date(start.getTime() + selectedPlan.creditExpiryDays * 86_400_000)
    : new Date(end.getTime() + graceHours * 3_600_000)
  const granted = await grant(tx, {
    workspaceId: current.workspaceId,
    source: 'subscription',
    sourceRef: `${current.id}:${month}`,
    paymentId: current.id,
    amount: selectedPlan.credits,
    expiresAt,
  })
  // 批次始终记录原始积分；部分退款后由幂等的比例回收保留未退款份额（Q6），避免重复缩放。
  if (current.refundedAmount > 0)
    await reducePaymentCredits(tx, {
      workspaceId: current.workspaceId,
      paymentId: current.id,
      share: { kept: current.amount - current.refundedAmount, total: current.amount },
    })
  return granted
}
