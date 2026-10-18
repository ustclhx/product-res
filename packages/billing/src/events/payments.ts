import { grant, reducePaymentCredits, revokePaymentCredits } from '@product-res/credits'
import { payment, purchase, subscription } from '@product-res/db'
import { and, eq } from 'drizzle-orm'
import type { WebhookTransaction } from '../pipeline.ts'
import type { NormalizedEvent } from '../provider.ts'
import { grantSubscriptionMonth } from './grants.ts'
import { type BillingEventOptions, checkWinner, money, paymentScope } from './shared.ts'
import type { BillingTarget } from './target.ts'

/** Records the payment idempotently, advances the subscription period and grants credits. */
export async function applyPaymentSucceeded(
  tx: WebhookTransaction,
  event: Extract<NormalizedEvent, { type: 'payment.succeeded' }>,
  { a, id, compensated, deleted, sub, purchaseId }: BillingTarget,
  options: Pick<BillingEventOptions, 'subscriptionCreditGraceHours' | 'now'>,
) {
  const p = event.payment
  money(p.amount, p.currency)
  if (
    p.kind !== 'adjustment' &&
    (p.amount !== a.price.amount || p.currency.toUpperCase() !== a.price.currency.toUpperCase())
  )
    throw new Error('Payment price mismatch')
  if (
    p.period &&
    (!(p.period.start < p.period.end) ||
      !Number.isFinite(p.period.start.getTime()) ||
      !Number.isFinite(p.period.end.getTime()))
  )
    throw new Error('Invalid payment period')
  if (p.refundedAmount !== null) money(p.refundedAmount, p.currency)
  if ((p.refundedAmount ?? 0) > p.amount) throw new Error('Payment refund exceeds gross')
  const [inserted] = await tx
    .insert(payment)
    .values({
      workspaceId: a.workspaceId,
      provider: event.provider,
      providerPaymentId: p.providerPaymentId,
      subscriptionId: sub?.id ?? null,
      purchaseId: purchaseId ?? null,
      planPriceId: a.price.id,
      periodStart: p.period?.start ?? null,
      periodEnd: p.period?.end ?? null,
      kind: p.kind,
      amount: p.amount,
      currency: p.currency.toUpperCase(),
      paidAt: p.paidAt,
      status: p.status,
      refundedAmount: p.refundedAmount ?? 0,
    })
    .onConflictDoNothing({ target: [payment.provider, payment.providerPaymentId] })
    .returning()
  const [paid] = inserted
    ? [inserted]
    : await tx.select().from(payment).where(paymentScope(event.provider, p.providerPaymentId))
  if (
    !paid ||
    paid.workspaceId !== a.workspaceId ||
    paid.subscriptionId !== (sub?.id ?? null) ||
    paid.purchaseId !== (purchaseId ?? null) ||
    paid.kind !== p.kind ||
    paid.planPriceId !== a.price.id ||
    paid.paidAt.getTime() !== p.paidAt.getTime() ||
    paid.amount !== p.amount ||
    paid.currency !== p.currency.toUpperCase() ||
    paid.periodStart?.getTime() !== p.period?.start.getTime() ||
    paid.periodEnd?.getTime() !== p.period?.end.getTime()
  )
    throw new Error('Payment replay provenance mismatch')
  const refunded = Math.max(paid.refundedAmount, p.refundedAmount ?? 0)
  const status =
    paid.status === 'disputed' || p.status === 'disputed'
      ? 'disputed'
      : refunded > 0
        ? refunded === paid.amount
          ? 'refunded'
          : 'partially_refunded'
        : p.status === 'refunded' || p.status === 'partially_refunded'
          ? p.status
          : paid.status
  if (refunded !== paid.refundedAmount || status !== paid.status)
    await tx
      .update(payment)
      .set({ refundedAmount: refunded, status })
      .where(eq(payment.id, paid.id))
  if (purchaseId && status === 'succeeded')
    await tx
      .update(purchase)
      .set({ status: 'paid', paidAt: paid.paidAt })
      .where(
        and(
          eq(purchase.id, purchaseId),
          eq(purchase.workspaceId, a.workspaceId),
          eq(purchase.status, 'pending'),
        ),
      )
  if (
    sub &&
    !compensated &&
    !deleted &&
    p.period &&
    p.kind !== 'adjustment' &&
    event.occurredAt >= sub.lastEventAt &&
    (!sub.currentPeriodEnd || p.period.end >= sub.currentPeriodEnd)
  ) {
    const nextStatus = sub.cancelAtPeriodEnd ? sub.status : 'active'
    await checkWinner(tx, a, event, id, nextStatus, sub.cancelAtPeriodEnd)
    await tx
      .update(subscription)
      .set({
        currentPeriodStart: p.period.start,
        currentPeriodEnd: p.period.end,
        status: nextStatus,
        lastEventAt: event.occurredAt,
        pastDueSince: null,
      })
      .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, a.workspaceId)))
  }
  // 全额退款、争议或金额未知的部分退款收回全部剩余；已知金额的部分退款按未退款份额保留（Q6）。
  if (status !== 'succeeded' && !(status === 'partially_refunded' && refunded > 0)) {
    await revokePaymentCredits(tx, { workspaceId: paid.workspaceId, paymentId: paid.id })
    return
  }
  const reduceToKept = () =>
    refunded > 0
      ? reducePaymentCredits(tx, {
          workspaceId: paid.workspaceId,
          paymentId: paid.id,
          share: { kept: paid.amount - refunded, total: paid.amount },
        })
      : undefined
  if (compensated || deleted) {
    await reduceToKept()
    return
  }
  if (p.kind === 'initial' || p.kind === 'renewal')
    await grantSubscriptionMonth(
      tx,
      paid,
      a.price,
      a.plan,
      0,
      options.now?.() ?? new Date(),
      options.subscriptionCreditGraceHours ?? 24,
    )
  else if (p.kind === 'one_time' && a.plan.credits > 0)
    await grant(tx, {
      workspaceId: a.workspaceId,
      source: 'purchase',
      sourceRef: paid.id,
      paymentId: paid.id,
      amount: a.plan.credits,
      expiresAt:
        a.plan.creditExpiryDays === null
          ? null
          : new Date(paid.paidAt.getTime() + a.plan.creditExpiryDays * 86_400_000),
    })
  await reduceToKept()
}
