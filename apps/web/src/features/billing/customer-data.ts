import {
  type CreditPageInput,
  getCreditBalance,
  getCreditBatches,
  getCreditLedger,
} from '@product-res/credits'
import {
  type Database,
  payment,
  plan,
  planPrice,
  refundRequest,
  scoped,
  subscription,
} from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

export const creditPageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z
    .object({
      createdAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
        .refine((value) => Number.isFinite(Date.parse(value))),
      id: z.uuid(),
    })
    .optional(),
})

export async function customerCatalog(
  db: Database,
  readiness: { id: string; available: boolean }[],
) {
  const plans = await db
    .select({
      id: plan.id,
      key: plan.key,
      name: plan.name,
      type: plan.type,
      credits: plan.credits,
      creditExpiryDays: plan.creditExpiryDays,
      features: plan.features,
    })
    .from(plan)
    .where(eq(plan.active, true))
    .orderBy(asc(plan.sort))
  const prices = await db
    .select({
      id: planPrice.id,
      planId: planPrice.planId,
      provider: planPrice.provider,
      amount: planPrice.amount,
      currency: planPrice.currency,
      interval: planPrice.interval,
      active: planPrice.active,
      synced: planPrice.providerPriceId,
    })
    .from(planPrice)
  return {
    plans,
    prices: prices.map(({ synced, ...price }) => ({
      ...price,
      available:
        price.active &&
        Boolean(synced) &&
        !synced.startsWith('unsynced:') &&
        price.currency.toUpperCase() === 'USD' &&
        readiness.some((p) => p.id === price.provider && p.available),
    })),
    providers: readiness,
  }
}

export async function customerBilling(
  db: Database,
  workspaceId: string,
  role: string,
  pastDueGraceDays: number,
) {
  const entitlements = await getEntitlements(db, workspaceId, { pastDueGraceDays })
  const credits =
    role === 'owner' || role === 'admin' ? await getCreditBalance(db, workspaceId) : null
  const scope = scoped(db, workspaceId)
  const subscriptions = await scope
    .select(subscription, {
      fields: {
        id: subscription.id,
        provider: subscription.provider,
        planPriceId: subscription.planPriceId,
        name: plan.name,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
    })
    .innerJoin(plan, eq(subscription.planId, plan.id))
    .orderBy(desc(subscription.createdAt))
    .limit(50)
  if (role !== 'owner')
    return {
      entitlements,
      credits,
      subscriptions,
      payments: [],
      refunds: [],
    }
  const [payments, refunds] = await Promise.all([
    scope
      .select(payment, {
        fields: {
          id: payment.id,
          provider: payment.provider,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          refundedAmount: payment.refundedAmount,
          paidAt: payment.paidAt,
        },
      })
      .orderBy(desc(payment.paidAt))
      .limit(50),
    scope
      .select(refundRequest, {
        fields: {
          id: refundRequest.id,
          paymentId: refundRequest.paymentId,
          status: refundRequest.status,
          createdAt: refundRequest.createdAt,
        },
      })
      .orderBy(desc(refundRequest.createdAt))
      .limit(50),
  ])
  return { entitlements, credits, subscriptions, payments, refunds }
}

export async function customerUsage(
  db: Database,
  workspaceId: string,
  userId: string,
  role: string,
  input: CreditPageInput,
  kind: 'ledger' | 'batches',
) {
  const manager = role === 'owner' || role === 'admin'
  const ledger = await getCreditLedger(db, workspaceId, {
    ...(kind === 'ledger' ? input : { limit: input.limit ?? 25 }),
    ...(manager ? {} : { userId }),
  })
  const safeLedger = {
    ...ledger,
    items: ledger.items.map(({ id, type, delta, grantId, refType, refId, createdAt }) => ({
      id,
      type,
      delta,
      grantId,
      refType,
      refId,
      createdAt,
    })),
  }
  const [balance, batches] = manager
    ? await Promise.all([
        getCreditBalance(db, workspaceId),
        getCreditBatches(
          db,
          workspaceId,
          kind === 'batches' ? input : { limit: input.limit ?? 25 },
        ),
      ])
    : [null, null]
  return {
    ledger: safeLedger,
    balance,
    batches: batches
      ? {
          ...batches,
          items: batches.items.map(({ id, source, amount, remaining, status, expiresAt }) => ({
            id,
            source,
            amount,
            remaining,
            status,
            expiresAt,
          })),
        }
      : null,
  }
}
