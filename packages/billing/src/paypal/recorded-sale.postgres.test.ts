import {
  billingCompensation,
  createDb,
  organization,
  payment,
  plan,
  planPrice,
  subscription,
} from '@product-res/db'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { createPayPalSaleLookup } from './recorded-sale.ts'

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
if (!env.BILLING_TEST_DATABASE_URL) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: env.BILLING_TEST_DATABASE_URL })
const lookup = createPayPalSaleLookup(db)
const start = new Date('2030-01-31T12:00:00Z')
const end = new Date('2030-02-28T12:00:00Z')
let ws: string, otherWs: string, planId: string, priceId: string, subId: string, saleId: string
beforeEach(async () => {
  ws = crypto.randomUUID()
  otherWs = crypto.randomUUID()
  planId = crypto.randomUUID()
  priceId = crypto.randomUUID()
  subId = crypto.randomUUID()
  saleId = crypto.randomUUID()
  await db
    .insert(organization)
    .values([ws, otherWs].map((id) => ({ id, name: 'Lookup', slug: id })))
  await db.insert(plan).values({
    id: planId,
    key: planId,
    name: 'Lookup',
    type: 'subscription',
    credits: 10,
    features: {
      models: [],
      maxConcurrentTasks: 1,
      maxSeats: 1,
      storageGb: 1,
      publicApi: false,
      priorityQueue: false,
      watermark: false,
    },
  })
  await db.insert(planPrice).values({
    id: priceId,
    planId,
    provider: 'paypal',
    providerPriceId: `P-${priceId}`,
    interval: 'month',
    amount: 1000,
    currency: 'USD',
  })
  await db.insert(subscription).values({
    id: subId,
    workspaceId: ws,
    planId,
    planPriceId: priceId,
    provider: 'paypal',
    providerSubscriptionId: `I-${subId}`,
    status: 'active',
    lastEventAt: start,
    currentPeriodStart: new Date('2031-01-31T12:00:00Z'),
    currentPeriodEnd: new Date('2031-02-28T12:00:00Z'),
  })
})
afterEach(async () => {
  await db
    .delete(billingCompensation)
    .where(inArray(billingCompensation.workspaceId, [ws, otherWs]))
  await db.delete(payment).where(inArray(payment.workspaceId, [ws, otherWs]))
  await db.delete(subscription).where(inArray(subscription.workspaceId, [ws, otherWs]))
  await db.delete(planPrice).where(eq(planPrice.planId, planId))
  await db.delete(plan).where(eq(plan.id, planId))
  await db.delete(organization).where(inArray(organization.id, [ws, otherWs]))
})
afterAll(() => db.$client.end())
function receipt(workspaceId = ws) {
  return db.insert(payment).values({
    workspaceId,
    provider: 'paypal',
    providerPaymentId: saleId,
    subscriptionId: subId,
    planPriceId: priceId,
    kind: 'initial',
    amount: 1000,
    currency: 'USD',
    paidAt: start,
    periodStart: start,
    periodEnd: end,
  })
}
function compensation(workspaceId = ws) {
  return db.insert(billingCompensation).values({
    workspaceId,
    key: crypto.randomUUID(),
    payload: {
      provider: 'paypal',
      providerSubscriptionId: `I-${subId}`,
      planId,
      planPriceId: priceId,
      winnerSubscriptionId: crypto.randomUUID(),
      payment: {
        providerPaymentId: saleId,
        kind: 'initial',
        amount: 1000,
        currency: 'USD',
        paidAt: start.toISOString(),
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        refundedAmount: null,
        raw: {},
      },
    },
  })
}
it('returns null for a new sale and retains historical payment price and period after subscription changes', async () => {
  expect(await lookup(saleId)).toBeNull()
  await receipt()
  const nextPrice = crypto.randomUUID()
  await db.insert(planPrice).values({
    id: nextPrice,
    planId,
    provider: 'paypal',
    providerPriceId: `P-${nextPrice}`,
    interval: 'year',
    amount: 12000,
    currency: 'USD',
  })
  await db.update(subscription).set({ planPriceId: nextPrice }).where(eq(subscription.id, subId))
  expect(await lookup(saleId)).toEqual({
    providerPaymentId: saleId,
    providerSubscriptionId: `I-${subId}`,
    providerPriceId: `P-${priceId}`,
    workspaceId: ws,
    planPriceId: priceId,
    kind: 'initial',
    amount: 1000,
    currency: 'USD',
    paidAt: start,
    period: { start, end },
  })
})
it('uses a pending compensation receipt before payment insertion and rejects conflicting evidence', async () => {
  await db.delete(subscription).where(eq(subscription.id, subId))
  await compensation()
  expect(await lookup(saleId)).toMatchObject({
    workspaceId: ws,
    providerPaymentId: saleId,
    period: { start, end },
  })
  await compensation(otherWs)
  await expect(lookup(saleId)).rejects.toThrow('Conflicting recorded PayPal compensation evidence')
})
it('rejects a stored payment with inconsistent ownership rather than falling back to compensation', async () => {
  await receipt(otherWs)
  await compensation()
  await expect(lookup(saleId)).rejects.toThrow('association mismatch')
})
it('rejects compensation pointing to a subscription owned by another workspace', async () => {
  await compensation(otherWs)
  await expect(lookup(saleId)).rejects.toThrow('association mismatch')
})
