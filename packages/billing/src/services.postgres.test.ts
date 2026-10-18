import {
  auditLog,
  billingCustomer,
  createDb,
  creditGrant,
  creditLedger,
  member,
  organization,
  payment,
  plan,
  planPrice,
  purchase,
  subscription,
  user,
} from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBillingEvent, prepareBillingEvents } from './events.ts'
import type { NormalizedEvent, PaymentProvider, SubscriptionSnapshot } from './provider.ts'
import {
  type BillingServiceContext,
  cancelSubscription,
  changePlan,
  confirmCheckout,
  createCheckout,
  getPortalUrl,
  resumeSubscription,
} from './services.ts'

const url = process.env.BILLING_TEST_DATABASE_URL
if (
  !url ||
  (!/^\/product_res_wt_[a-z0-9_]+$/.test(new URL(url).pathname) &&
    !(process.env.CI && new URL(url).pathname === '/product_res_ci'))
)
  throw new Error('Services tests require an isolated billing database')
const db = createDb({ connectionString: url })
const migrator = createDb({ connectionString: process.env.MIGRATION_DATABASE_URL ?? '' })
const id = () => crypto.randomUUID()
let ws: string, uid: string, pid: string, sp: string, pp: string, sid: string
let ctx: BillingServiceContext
let remote: SubscriptionSnapshot
let extraPlans: string[] = []
let transactionDepth = 0
const noTransaction = () => expect(transactionDepth).toBe(0)
const actor = () => ({ workspaceId: ws, userId: uid })
const subInput = () => ({ ...actor(), subscriptionId: sid })
const checkout = (provider: 'stripe' | 'paypal' = 'stripe') => ({
  ...actor(),
  provider,
  planPriceId: provider === 'stripe' ? sp : pp,
  idempotencyKey: id(),
  successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel',
})
function mockProvider(provider: 'stripe' | 'paypal'): PaymentProvider {
  return {
    id: provider,
    capabilities: {
      portal: provider === 'stripe',
      changePlan: provider === 'stripe',
      refundsViaApi: true,
      merchantOfRecord: false,
    },
    createCheckout: vi.fn(async () => {
      noTransaction()
      return { url: 'https://mock.test/checkout', providerRef: `order-${ws}` }
    }),
    cancelSubscription: vi.fn(async () => {
      noTransaction()
      remote = { ...remote, cancelAtPeriodEnd: true }
    }),
    resumeSubscription: vi.fn(async () => {
      noTransaction()
      remote = { ...remote, status: 'active', cancelAtPeriodEnd: false }
    }),
    getSubscription: vi.fn(async () => {
      noTransaction()
      return remote
    }),
    changePlan: vi.fn(async (_sub, price, options) => {
      noTransaction()
      if (!options.atPeriodEnd) remote = { ...remote, providerPriceId: price.providerPriceId }
    }),
    getPortalUrl: vi.fn(async () => {
      noTransaction()
      return 'https://mock.test/portal'
    }),
    ...(provider === 'paypal'
      ? {
          confirmCheckout: vi.fn(async () => {
            noTransaction()
          }),
        }
      : {}),
  } as unknown as PaymentProvider
}
beforeEach(async () => {
  extraPlans = []
  ws = id()
  uid = id()
  pid = id()
  sp = id()
  pp = id()
  sid = id()
  await db.insert(user).values({ id: uid, name: 'Owner', email: `${uid}@test.example` })
  await db.insert(organization).values({ id: ws, name: 'Service tests', slug: ws })
  await db.insert(member).values({ id: id(), userId: uid, organizationId: ws, role: 'owner' })
  await db.insert(plan).values({
    id: pid,
    key: pid,
    name: 'Pro',
    type: 'subscription',
    credits: 10,
    sort: 10,
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
  await db.insert(planPrice).values([
    {
      id: sp,
      planId: pid,
      provider: 'stripe',
      providerPriceId: `price_${sp}`,
      interval: 'month',
      amount: 1000,
      currency: 'USD',
    },
    {
      id: pp,
      planId: pid,
      provider: 'paypal',
      providerPriceId: `P-${pp}`,
      interval: 'month',
      amount: 1000,
      currency: 'USD',
    },
  ])
  remote = {
    providerSubscriptionId: `sub_${sid}`,
    providerPriceId: `price_${sp}`,
    providerCustomerId: `cus_${ws}`,
    status: 'active',
    remoteStatus: 'active',
    currentPeriodStart: new Date('2026-10-01'),
    currentPeriodEnd: new Date('2030-11-01'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    pastDueSince: null,
    metadata: { workspaceId: ws, userId: uid, planPriceId: sp },
    raw: {},
  }
  ctx = {
    db,
    providers: { stripe: mockProvider('stripe'), paypal: mockProvider('paypal') },
    enabledProviders: ['stripe', 'paypal'],
  }
  const original = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementation((callback, config) =>
    original(async (tx) => {
      transactionDepth++
      try {
        return await callback(tx)
      } finally {
        transactionDepth--
      }
    }, config),
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.delete(creditLedger).where(eq(creditLedger.workspaceId, ws))
  await db.delete(creditGrant).where(eq(creditGrant.workspaceId, ws))
  await db.delete(payment).where(eq(payment.workspaceId, ws))
  await db.delete(purchase).where(eq(purchase.workspaceId, ws))
  await db.delete(subscription).where(eq(subscription.workspaceId, ws))
  await db.delete(billingCustomer).where(eq(billingCustomer.workspaceId, ws))
  await db.delete(member).where(eq(member.organizationId, ws))
  await migrator.delete(auditLog).where(eq(auditLog.workspaceId, ws))
  await db.delete(organization).where(eq(organization.id, ws))
  await db.delete(user).where(eq(user.id, uid))
  await db.delete(planPrice).where(inArray(planPrice.planId, [pid, ...extraPlans]))
  await db.delete(plan).where(inArray(plan.id, [pid, ...extraPlans]))
})
afterAll(async () => {
  await migrator.$client.end()
  await db.$client.end()
})
async function seedSub(provider: 'stripe' | 'paypal' = 'stripe') {
  await db.insert(subscription).values({
    id: sid,
    workspaceId: ws,
    planId: pid,
    planPriceId: provider === 'stripe' ? sp : pp,
    provider,
    providerSubscriptionId: remote.providerSubscriptionId,
    status: 'active',
    lastEventAt: new Date('2026-10-01'),
    currentPeriodStart: remote.currentPeriodStart,
    currentPeriodEnd: remote.currentPeriodEnd,
  })
}
const subs = () => db.select().from(subscription).where(eq(subscription.workspaceId, ws))

describe('trusted billing services on PostgreSQL', () => {
  it('Stripe tier rank upgrades immediately and downgrades at period end without additional credits', async () => {
    await seedSub()
    const team = id(),
      teamPrice = id()
    extraPlans.push(team)
    const [base] = await db.select().from(plan).where(eq(plan.id, pid))
    if (!base) throw new Error('Missing plan')
    await db
      .insert(plan)
      .values({ ...base, id: team, key: team, name: 'Team', sort: 20, credits: 30 })
    await db.insert(planPrice).values({
      id: teamPrice,
      planId: team,
      provider: 'stripe',
      providerPriceId: `price_${teamPrice}`,
      interval: 'month',
      amount: 2000,
      currency: 'USD',
    })
    expect(await changePlan(ctx, { ...subInput(), planPriceId: teamPrice })).toEqual({
      status: 'changed',
    })
    expect((await subs())[0]?.planId).toBe(team)
    expect(await changePlan(ctx, { ...subInput(), planPriceId: sp })).toEqual({
      status: 'scheduled',
    })
    expect((await subs())[0]?.planId).toBe(team)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
  })

  it('overlapping canceled and renewing subscriptions retain highest entitlement and each payment grants exactly once', async () => {
    await seedSub('paypal')
    await cancelSubscription(ctx, subInput())
    const team = id(),
      teamPrice = id(),
      newSub = id()
    extraPlans.push(team)
    const [base] = await db.select().from(plan).where(eq(plan.id, pid))
    if (!base) throw new Error('Missing plan')
    await db
      .insert(plan)
      .values({ ...base, id: team, key: team, name: 'Team', sort: 20, credits: 30 })
    await db.insert(planPrice).values({
      id: teamPrice,
      planId: team,
      provider: 'stripe',
      providerPriceId: `price_${teamPrice}`,
      interval: 'month',
      amount: 2000,
      currency: 'USD',
    })
    await db.insert(subscription).values({
      id: newSub,
      workspaceId: ws,
      planId: team,
      planPriceId: teamPrice,
      provider: 'stripe',
      providerSubscriptionId: `sub_${newSub}`,
      status: 'active',
      currentPeriodStart: remote.currentPeriodStart,
      currentPeriodEnd: remote.currentPeriodEnd,
      lastEventAt: new Date('2026-10-01'),
    })
    const events: NormalizedEvent[] = [
      {
        provider: 'paypal',
        type: 'payment.succeeded',
        occurredAt: new Date(),
        raw: {},
        payment: {
          providerPaymentId: id(),
          kind: 'initial',
          providerSubscriptionId: remote.providerSubscriptionId,
          providerPriceId: `P-${pp}`,
          providerCustomerId: null,
          amount: 1000,
          currency: 'USD',
          paidAt: new Date(),
          refundedAmount: null,
          status: 'succeeded',
          metadata: null,
          raw: {},
          period: { start: new Date('2026-10-01'), end: new Date('2030-11-01') },
        },
      },
      {
        provider: 'stripe',
        type: 'payment.succeeded',
        occurredAt: new Date(),
        raw: {},
        payment: {
          providerPaymentId: id(),
          kind: 'initial',
          providerSubscriptionId: `sub_${newSub}`,
          providerPriceId: `price_${teamPrice}`,
          providerCustomerId: null,
          amount: 2000,
          currency: 'USD',
          paidAt: new Date(),
          refundedAmount: null,
          status: 'succeeded',
          metadata: null,
          raw: {},
          period: { start: new Date('2026-10-01'), end: new Date('2030-11-01') },
        },
      },
    ]
    const prepared = await prepareBillingEvents(events, db, ctx.providers)
    for (let replay = 0; replay < 2; replay++)
      await db.transaction(async (tx) => {
        for (const event of events) await applyBillingEvent(tx, event, prepared)
      })
    expect((await getEntitlements(db, ws)).key).toBe(team)
    const grants = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    expect(grants).toHaveLength(2)
    expect(grants.map((g) => g.amount).sort((a, b) => a - b)).toEqual([10, 30])
    expect(await subs()).toHaveLength(2)
  })

  it('rejects same-provider renewing checkout and requires explicit expected-old switch confirmation', async () => {
    await seedSub()
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({
      code: 'BILLING_USE_CHANGE_PLAN',
    })
    await expect(createCheckout(ctx, checkout('paypal'))).rejects.toMatchObject({
      code: 'BILLING_SWITCH_CONFIRMATION_REQUIRED',
    })
    await expect(
      createCheckout(ctx, {
        ...checkout('paypal'),
        confirmSwitch: true,
        expectedOldSubscriptionId: id(),
      }),
    ).rejects.toMatchObject({ code: 'BILLING_SWITCH_CONFIRMATION_REQUIRED' })
    expect(ctx.providers.stripe?.cancelSubscription).not.toHaveBeenCalled()
    expect(ctx.providers.paypal?.createCheckout).not.toHaveBeenCalled()
  })
  it('failed old cancellation prevents checkout; success persists cancellation before remote checkout', async () => {
    await seedSub()
    const stripe = ctx.providers.stripe as PaymentProvider
    vi.mocked(stripe.cancelSubscription).mockRejectedValueOnce(new Error('cancel failed'))
    const input = { ...checkout('paypal'), confirmSwitch: true, expectedOldSubscriptionId: sid }
    await expect(createCheckout(ctx, input)).rejects.toThrow('cancel failed')
    expect((await subs())[0]?.cancelAtPeriodEnd).toBe(false)
    expect(ctx.providers.paypal?.createCheckout).not.toHaveBeenCalled()
    vi.mocked((ctx.providers.paypal as PaymentProvider).createCheckout).mockImplementationOnce(
      async (request) => {
        noTransaction()
        expect((await subs())[0]?.cancelAtPeriodEnd).toBe(true)
        expect(request.customerEmail).toBe(`${uid}@test.example`)
        expect(request.idempotencyKey).toBe(`checkout:${ws}:${input.idempotencyKey}`)
        return { url: 'https://mock.test', providerRef: id() }
      },
    )
    await createCheckout(ctx, input)
  })
  it('checks database membership, banned accounts, deleted workspaces, enabled providers and synced USD prices before effects', async () => {
    await db.update(member).set({ role: 'member' }).where(eq(member.organizationId, ws))
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({ status: 403 })
    await db.update(member).set({ role: 'owner' }).where(eq(member.organizationId, ws))
    await db.update(user).set({ banned: true }).where(eq(user.id, uid))
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({ status: 403 })
    await db.update(user).set({ banned: false }).where(eq(user.id, uid))
    await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, ws))
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({ status: 403 })
    await db.update(organization).set({ deletedAt: null }).where(eq(organization.id, ws))
    await expect(
      createCheckout({ ...ctx, enabledProviders: ['paypal'] }, checkout()),
    ).rejects.toMatchObject({ code: 'BILLING_PROVIDER_DISABLED' })
    await db
      .update(planPrice)
      .set({ providerPriceId: 'unsynced:fixture' })
      .where(eq(planPrice.id, sp))
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({
      code: 'BILLING_PRICE_UNAVAILABLE',
    })
    await db
      .update(planPrice)
      .set({ providerPriceId: `price_${sp}`, currency: 'EUR' })
      .where(eq(planPrice.id, sp))
    await expect(createCheckout(ctx, checkout())).rejects.toMatchObject({
      code: 'BILLING_PRICE_UNAVAILABLE',
    })
    expect(ctx.providers.stripe?.createCheckout).not.toHaveBeenCalled()
  })
  it('PayPal suspension preserves paid period and rejects resume before remote calls when another subscription renews', async () => {
    await seedSub('paypal')
    remote = { ...remote, providerPriceId: `P-${pp}`, status: 'paused', remoteStatus: 'SUSPENDED' }
    await cancelSubscription(ctx, subInput())
    expect((await subs())[0]).toMatchObject({
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: remote.currentPeriodEnd,
    })
    const old = sid
    sid = id()
    await seedSub()
    await expect(
      resumeSubscription(ctx, { ...actor(), subscriptionId: old }),
    ).rejects.toMatchObject({ code: 'BILLING_RENEWING_SUBSCRIPTION_EXISTS' })
    expect(ctx.providers.paypal?.resumeSubscription).not.toHaveBeenCalled()
  })
  it('Stripe cancel/resume persist normalized snapshots and portal uses owned local customer', async () => {
    await seedSub()
    await cancelSubscription(ctx, subInput())
    expect((await subs())[0]?.cancelAtPeriodEnd).toBe(true)
    await resumeSubscription(ctx, subInput())
    expect((await subs())[0]?.cancelAtPeriodEnd).toBe(false)
    await db
      .insert(billingCustomer)
      .values({ workspaceId: ws, provider: 'stripe', providerCustomerId: 'cus_owned' })
    expect(
      await getPortalUrl(ctx, { ...subInput(), returnUrl: 'https://example.test/billing' }),
    ).toBe('https://mock.test/portal')
    expect(ctx.providers.stripe?.getPortalUrl).toHaveBeenCalledWith(
      'cus_owned',
      'https://example.test/billing',
    )
  })
  it('Stripe monthly to annual changes immediately and annual to monthly schedules without changing current price or grants', async () => {
    await seedSub()
    const year = id()
    await db.insert(planPrice).values({
      id: year,
      planId: pid,
      provider: 'stripe',
      providerPriceId: `price_${year}`,
      interval: 'year',
      amount: 10000,
      currency: 'USD',
    })
    expect(await changePlan(ctx, { ...subInput(), planPriceId: year })).toEqual({
      status: 'changed',
    })
    expect((await subs())[0]?.planPriceId).toBe(year)
    expect(await changePlan(ctx, { ...subInput(), planPriceId: sp })).toEqual({
      status: 'scheduled',
    })
    expect((await subs())[0]?.planPriceId).toBe(year)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
  })
  it('PayPal changes return explicit new-checkout confirmation and capture only advances an owned purchase', async () => {
    await seedSub('paypal')
    expect(await changePlan(ctx, { ...subInput(), planPriceId: pp })).toMatchObject({
      status: 'checkout_required',
      expectedOldSubscriptionId: sid,
    })
    await db
      .update(plan)
      .set({ type: 'credit_pack' })
      .where(inArray(plan.id, [pid, ...extraPlans]))
    await db.update(planPrice).set({ interval: null }).where(eq(planPrice.id, pp))
    const result = await createCheckout(ctx, checkout('paypal'))
    await expect(
      confirmCheckout(ctx, { ...actor(), provider: 'paypal', providerRef: 'not-owned' }),
    ).rejects.toMatchObject({ code: 'BILLING_PURCHASE_NOT_FOUND' })
    await confirmCheckout(ctx, { ...actor(), provider: 'paypal', providerRef: result.providerRef })
    expect(ctx.providers.paypal?.confirmCheckout).toHaveBeenCalledTimes(1)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
    expect((await db.select().from(purchase).where(eq(purchase.workspaceId, ws)))[0]?.status).toBe(
      'pending',
    )
    const paid: NormalizedEvent = {
      provider: 'paypal',
      type: 'payment.succeeded',
      occurredAt: new Date(),
      raw: {},
      payment: {
        providerPaymentId: id(),
        providerOrderId: result.providerRef,
        providerPriceId: `P-${pp}`,
        kind: 'one_time',
        period: null,
        providerCustomerId: null,
        amount: 1000,
        currency: 'USD',
        paidAt: new Date(),
        refundedAmount: null,
        status: 'succeeded',
        metadata: null,
        raw: {},
      },
    }
    const prepared = await prepareBillingEvents([paid], db, ctx.providers)
    await db.transaction((tx) => applyBillingEvent(tx, paid, prepared))
    await confirmCheckout(ctx, { ...actor(), provider: 'paypal', providerRef: result.providerRef })
    await db.transaction((tx) => applyBillingEvent(tx, paid, prepared))
    expect(ctx.providers.paypal?.confirmCheckout).toHaveBeenCalledTimes(1)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toHaveLength(
      1,
    )
  })
})
