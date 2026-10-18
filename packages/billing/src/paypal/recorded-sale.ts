import {
  billingCompensation,
  type Database,
  payment,
  planPrice,
  subscription,
} from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { type PayPalRecordedSale, type PayPalSaleLookup, payPalDate } from './snapshots.ts'

function validate(receipt: PayPalRecordedSale): PayPalRecordedSale {
  if (
    !receipt.providerSubscriptionId ||
    !receipt.providerPriceId ||
    !['initial', 'renewal'].includes(receipt.kind) ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount < 0 ||
    !/^[A-Z]{3}$/.test(receipt.currency) ||
    !Number.isFinite(receipt.paidAt.getTime()) ||
    !Number.isFinite(receipt.period.start.getTime()) ||
    !Number.isFinite(receipt.period.end.getTime()) ||
    receipt.period.end <= receipt.period.start
  )
    throw new Error('Invalid recorded PayPal sale evidence')
  return receipt
}

/** 历史付款是周期证据；订阅当前周期和价格可变，不能覆盖历史收据。 */
export function createPayPalSaleLookup(db: Database): PayPalSaleLookup {
  return async (saleId) => {
    const [record] = await db
      .select({ payment, price: planPrice, sub: subscription })
      .from(payment)
      .leftJoin(planPrice, eq(payment.planPriceId, planPrice.id))
      .leftJoin(subscription, eq(payment.subscriptionId, subscription.id))
      .where(and(eq(payment.provider, 'paypal'), eq(payment.providerPaymentId, saleId)))
    if (record) {
      const { payment: paid, price, sub } = record
      if (
        !price ||
        !sub ||
        price.provider !== 'paypal' ||
        sub.provider !== 'paypal' ||
        sub.workspaceId !== paid.workspaceId ||
        !paid.periodStart ||
        !paid.periodEnd ||
        (paid.kind !== 'initial' && paid.kind !== 'renewal')
      )
        throw new Error('Recorded PayPal sale association mismatch')
      return validate({
        providerPaymentId: paid.providerPaymentId,
        providerSubscriptionId: sub.providerSubscriptionId,
        providerPriceId: price.providerPriceId,
        workspaceId: paid.workspaceId,
        planPriceId: price.id,
        kind: paid.kind,
        amount: paid.amount,
        currency: paid.currency,
        paidAt: paid.paidAt,
        period: { start: paid.periodStart, end: paid.periodEnd },
      })
    }
    // 竞争订阅事务回滚后，补偿任务可能尚未落收据；此时保留的 payload 是唯一历史周期证据。
    const jobs = await db
      .select()
      .from(billingCompensation)
      .where(
        and(
          sql`${billingCompensation.payload}->>'provider' = 'paypal'`,
          sql`${billingCompensation.payload}->'payment'->>'providerPaymentId' = ${saleId}`,
          sql`coalesce(${billingCompensation.payload}->>'reason', '') <> 'workspace_deleted'`,
        ),
      )
    let evidence: PayPalRecordedSale | null = null
    for (const job of jobs) {
      const p = job.payload
      const paid = p.payment
      const [price] = await db.select().from(planPrice).where(eq(planPrice.id, p.planPriceId))
      const [sub] = await db
        .select()
        .from(subscription)
        .where(
          and(
            eq(subscription.provider, 'paypal'),
            eq(subscription.providerSubscriptionId, p.providerSubscriptionId),
          ),
        )
      if (
        !paid ||
        !price ||
        price.provider !== 'paypal' ||
        price.planId !== p.planId ||
        (sub && sub.workspaceId !== job.workspaceId) ||
        (paid.kind !== 'initial' && paid.kind !== 'renewal')
      )
        throw new Error('Recorded PayPal compensation association mismatch')
      const candidate = validate({
        providerPaymentId: paid.providerPaymentId,
        providerSubscriptionId: p.providerSubscriptionId,
        providerPriceId: price.providerPriceId,
        workspaceId: job.workspaceId,
        planPriceId: price.id,
        kind: paid.kind,
        amount: paid.amount,
        currency: paid.currency,
        paidAt: payPalDate(paid.paidAt),
        period: { start: payPalDate(paid.periodStart), end: payPalDate(paid.periodEnd) },
      })
      if (evidence && JSON.stringify(evidence) !== JSON.stringify(candidate))
        throw new Error('Conflicting recorded PayPal compensation evidence')
      evidence = candidate
    }
    return evidence
  }
}
