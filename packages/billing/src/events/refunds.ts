import { reducePaymentCredits, revokePaymentCredits } from '@product-res/credits'
import { auditLog, payment, paymentRefund, purchase, refundRequest } from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import type { WebhookTransaction } from '../pipeline.ts'
import type { NormalizedEvent } from '../provider.ts'
import { type BillingEventOptions, lockWorkspaceBilling, money, paymentScope } from './shared.ts'

type PaymentReversalEvent = Extract<
  NormalizedEvent,
  { type: 'payment.refunded' | 'payment.disputed' }
>

/** Locks the workspace before the payment row, then validates the reversal against it. */
async function lockReversedPayment(tx: WebhookTransaction, event: PaymentReversalEvent) {
  const [found] = await tx
    .select()
    .from(payment)
    .where(paymentScope(event.provider, event.providerPaymentId))
  if (!found) throw new Error('Payment association not found')
  await lockWorkspaceBilling(tx, found.workspaceId)
  const [paid] = await tx
    .select()
    .from(payment)
    .where(and(eq(payment.id, found.id), eq(payment.workspaceId, found.workspaceId)))
    .for('update')
  if (!paid) throw new Error('Payment association not found')
  money(event.amount, event.currency)
  if (
    event.currency.toUpperCase() !== paid.currency.toUpperCase() ||
    event.amount <= 0 ||
    event.amount > paid.amount
  )
    throw new Error('Refund or dispute amount mismatch')
  return paid
}
export async function applyPaymentDisputed(
  tx: WebhookTransaction,
  event: Extract<NormalizedEvent, { type: 'payment.disputed' }>,
) {
  const paid = await lockReversedPayment(tx, event)
  if (paid.status !== 'disputed') {
    await tx.update(payment).set({ status: 'disputed' }).where(eq(payment.id, paid.id))
    await revokePaymentCredits(tx, { workspaceId: paid.workspaceId, paymentId: paid.id })
    await tx.insert(auditLog).values({
      workspaceId: paid.workspaceId,
      action: 'billing.payment_disputed',
      targetType: 'payment',
      targetId: paid.id,
      meta: { providerDisputeId: event.providerDisputeId },
    })
  }
}
export async function applyPaymentRefunded(
  tx: WebhookTransaction,
  event: Extract<NormalizedEvent, { type: 'payment.refunded' }>,
  options: Pick<BillingEventOptions, 'now'>,
) {
  const paid = await lockReversedPayment(tx, event)
  const refundIdentity = and(
    eq(paymentRefund.provider, event.provider),
    eq(paymentRefund.providerRefundId, event.providerRefundId),
  )
  const [claimed] = await tx
    .insert(paymentRefund)
    .values({
      workspaceId: paid.workspaceId,
      paymentId: paid.id,
      provider: event.provider,
      providerRefundId: event.providerRefundId,
      amount: event.amount,
      currency: paid.currency,
    })
    .onConflictDoNothing({ target: [paymentRefund.provider, paymentRefund.providerRefundId] })
    .returning()
  const [refund] = claimed ? [claimed] : await tx.select().from(paymentRefund).where(refundIdentity)
  if (
    !refund ||
    refund.paymentId !== paid.id ||
    refund.currency !== paid.currency ||
    refund.amount !== event.amount
  )
    throw new Error('Refund replay association mismatch')
  const [sum] = await tx
    .select({ total: sql<number>`coalesce(sum(${paymentRefund.amount}), 0)::int` })
    .from(paymentRefund)
    .where(
      and(eq(paymentRefund.workspaceId, paid.workspaceId), eq(paymentRefund.paymentId, paid.id)),
    )
  if (event.refundedAmount !== null) money(event.refundedAmount, event.currency)
  const total = Math.max(paid.refundedAmount, sum?.total ?? 0, event.refundedAmount ?? 0)
  if (total > paid.amount) throw new Error('Cumulative refund exceeds payment')
  await tx
    .update(payment)
    .set({
      refundedAmount: total,
      status:
        paid.status === 'disputed'
          ? 'disputed'
          : total === paid.amount
            ? 'refunded'
            : 'partially_refunded',
    })
    .where(eq(payment.id, paid.id))
  await tx
    .update(refundRequest)
    .set({ status: 'refunded', updatedAt: options.now?.() ?? new Date() })
    .where(
      and(
        eq(refundRequest.workspaceId, paid.workspaceId),
        eq(refundRequest.paymentId, paid.id),
        eq(refundRequest.status, 'approved'),
        eq(refundRequest.providerRefundId, event.providerRefundId),
        eq(refundRequest.approvedAmount, event.amount),
      ),
    )
  if (paid.purchaseId)
    await tx
      .update(purchase)
      .set({ status: 'refunded' })
      .where(and(eq(purchase.id, paid.purchaseId), eq(purchase.workspaceId, paid.workspaceId)))
  // 全额退款收回全部剩余；部分退款按累计未退款份额保留各批次（Q6 比例回收），重放按累计值幂等。
  if (total === paid.amount)
    await revokePaymentCredits(tx, { workspaceId: paid.workspaceId, paymentId: paid.id })
  else
    await reducePaymentCredits(tx, {
      workspaceId: paid.workspaceId,
      paymentId: paid.id,
      share: { kept: paid.amount - total, total: paid.amount },
    })
  if (claimed)
    await tx.insert(auditLog).values({
      workspaceId: paid.workspaceId,
      action: 'billing.payment_refunded',
      targetType: 'payment',
      targetId: paid.id,
      meta: {
        providerRefundId: event.providerRefundId,
        amount: event.amount,
        refundedAmount: total,
      },
    })
}
