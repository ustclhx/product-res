import {
  billingCustomer,
  type Database,
  member,
  organization,
  type PaymentProviderId,
  plan,
  planPrice,
  purchase,
  type Subscription,
  subscription,
  user,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { type BillingProviders, lockWorkspaceBilling } from './events.ts'
import type { WebhookTransaction } from './pipeline.ts'
import type { SubscriptionSnapshot } from './provider.ts'
import { auditSubscriptionChange } from './subscription-audit.ts'

export interface BillingServiceContext {
  db: Database
  providers: BillingProviders
  enabledProviders: readonly PaymentProviderId[]
}
export interface BillingActor {
  workspaceId: string
  userId: string
  ip?: string | null
}
export interface SubscriptionInput extends BillingActor {
  subscriptionId: string
}
export interface CreateCheckoutInput extends BillingActor {
  provider: PaymentProviderId
  planPriceId: string
  /** UUID generated once per checkout intent; reuse on retries. */
  idempotencyKey: string
  /** Trusted route-generated URLs, never forwarded from request bodies. */
  successUrl: string
  cancelUrl: string
  confirmSwitch?: boolean
  expectedOldSubscriptionId?: string
}
function fail(code: string, message: string, status = 409): never {
  throw new AppError(code, message, { status })
}
function providerFor(ctx: BillingServiceContext, id: PaymentProviderId) {
  const provider = ctx.providers[id]
  if (!ctx.enabledProviders.includes(id) || !provider || provider.id !== id)
    fail('BILLING_PROVIDER_DISABLED', 'Payment provider unavailable', 400)
  return provider
}
async function owner(db: Database | WebhookTransaction, actor: BillingActor) {
  const [account] = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(
      and(
        eq(member.organizationId, actor.workspaceId),
        eq(member.userId, actor.userId),
        eq(member.role, 'owner'),
        isNull(organization.deletedAt),
        or(eq(user.banned, false), isNull(user.banned)),
      ),
    )
  if (!account) fail('BILLING_OWNER_REQUIRED', 'An active workspace owner is required', 403)
  return account
}
async function priceFor(ctx: BillingServiceContext, id: string, provider: PaymentProviderId) {
  providerFor(ctx, provider)
  const [found] = await ctx.db
    .select({ price: planPrice, plan })
    .from(planPrice)
    .innerJoin(plan, eq(planPrice.planId, plan.id))
    .where(
      and(
        eq(planPrice.id, id),
        eq(planPrice.provider, provider),
        eq(planPrice.active, true),
        eq(plan.active, true),
      ),
    )
  if (
    found?.price.currency.toUpperCase() !== 'USD' ||
    !found.price.providerPriceId ||
    found.price.providerPriceId.startsWith('unsynced:') ||
    (found.plan.type === 'subscription') !== (found.price.interval !== null)
  )
    fail('BILLING_PRICE_UNAVAILABLE', 'An active synced USD price is required', 400)
  return found
}
async function current(db: Database | WebhookTransaction, workspaceId: string) {
  const [winner] = await db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.workspaceId, workspaceId),
        inArray(subscription.status, ['trialing', 'active', 'past_due', 'paused']),
        eq(subscription.cancelAtPeriodEnd, false),
      ),
    )
  return winner
}
async function ownedSubscription(ctx: BillingServiceContext, input: SubscriptionInput) {
  await owner(ctx.db, input)
  const [sub] = await ctx.db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.id, input.subscriptionId),
        eq(subscription.workspaceId, input.workspaceId),
      ),
    )
  if (!sub) fail('BILLING_SUBSCRIPTION_NOT_FOUND', 'Subscription unavailable', 404)
  providerFor(ctx, sub.provider)
  return sub
}
async function locked<T>(
  ctx: BillingServiceContext,
  actor: BillingActor,
  action: (tx: WebhookTransaction) => Promise<T>,
) {
  return ctx.db.transaction(async (tx) => {
    await lockWorkspaceBilling(tx, actor.workspaceId)
    await owner(tx, actor)
    return action(tx)
  })
}
function unchanged(before: Subscription, after: Subscription | undefined) {
  if (!after || before.updatedAt.getTime() !== after.updatedAt.getTime())
    fail('BILLING_SUBSCRIPTION_CHANGED', 'Subscription changed; reload before retrying')
}
async function reload(tx: WebhookTransaction, sub: Subscription) {
  const [row] = await tx
    .select()
    .from(subscription)
    .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, sub.workspaceId)))
  return row
}
async function persistSnapshot(
  ctx: BillingServiceContext,
  actor: BillingActor,
  sub: Subscription,
  snapshot: SubscriptionSnapshot,
  operation: 'cancel' | 'resume' | 'change',
) {
  if (snapshot.providerSubscriptionId !== sub.providerSubscriptionId)
    fail('BILLING_SNAPSHOT_MISMATCH', 'Provider returned a different subscription')
  await locked(ctx, actor, async (tx) => {
    unchanged(sub, await reload(tx, sub))
    if (operation === 'resume') {
      const winner = await current(tx, sub.workspaceId)
      if (winner && winner.id !== sub.id)
        fail('BILLING_RENEWING_SUBSCRIPTION_EXISTS', 'Another subscription is renewing')
    }
    const [mapping] = await tx
      .select()
      .from(planPrice)
      .where(
        and(
          eq(planPrice.provider, sub.provider),
          eq(planPrice.providerPriceId, snapshot.providerPriceId),
        ),
      )
    if (!mapping) fail('BILLING_SNAPSHOT_MISMATCH', 'Provider returned an unknown price')
    await tx
      .update(subscription)
      .set({
        planId: mapping.planId,
        planPriceId: mapping.id,
        status: snapshot.status,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        canceledAt: snapshot.canceledAt,
        trialEnd: snapshot.trialEnd,
        pastDueSince: snapshot.pastDueSince,
        raw: snapshot.raw,
        lastEventAt: new Date(),
        ...(snapshot.currentPeriodEnd &&
        (!sub.currentPeriodEnd || snapshot.currentPeriodEnd >= sub.currentPeriodEnd)
          ? {
              currentPeriodStart: snapshot.currentPeriodStart,
              currentPeriodEnd: snapshot.currentPeriodEnd,
            }
          : {}),
      })
      .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, actor.workspaceId)))
    const after = await reload(tx, sub)
    if (after)
      await auditSubscriptionChange(tx, sub, after, operation, actor.userId, actor.ip ?? null)
  })
}

export async function createCheckout(ctx: BillingServiceContext, input: CreateCheckoutInput) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.idempotencyKey))
    fail('BILLING_INVALID_IDEMPOTENCY_KEY', 'Checkout requires an idempotency UUID', 400)
  const account = await owner(ctx.db, input)
  const { price, plan: selected } = await priceFor(ctx, input.planPriceId, input.provider)
  const provider = providerFor(ctx, input.provider)
  const mode = selected.type === 'subscription' ? 'subscription' : 'one_time'
  if (mode === 'subscription') {
    const old = await locked(ctx, input, (tx) => current(tx, input.workspaceId))
    if (old) {
      if (old.provider === input.provider && provider.capabilities.changePlan)
        fail('BILLING_USE_CHANGE_PLAN', 'Use the subscription plan-change route')
      if (!input.confirmSwitch || input.expectedOldSubscriptionId !== old.id)
        fail(
          'BILLING_SWITCH_CONFIRMATION_REQUIRED',
          'Confirm replacement of the current subscription',
        )
      await cancelSubscription(ctx, { ...input, subscriptionId: old.id })
    }
    await locked(ctx, input, async (tx) => {
      if (await current(tx, input.workspaceId))
        fail(
          'BILLING_SUBSCRIPTION_CHANGED',
          'A renewing subscription appeared; reload before retrying',
        )
    })
  }
  const [customer] = await ctx.db
    .select()
    .from(billingCustomer)
    .where(
      and(
        eq(billingCustomer.workspaceId, input.workspaceId),
        eq(billingCustomer.provider, input.provider),
      ),
    )
  const result = await provider.createCheckout({
    workspaceId: input.workspaceId,
    userId: input.userId,
    price,
    mode,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    customerEmail: account.email,
    ...(customer?.providerCustomerId ? { providerCustomerId: customer.providerCustomerId } : {}),
    idempotencyKey: `checkout:${input.workspaceId}:${input.idempotencyKey}`,
  })
  // PayPal returns an order ID; Stripe returns a session ID and is associated by webhook.
  if (mode === 'one_time' && provider.confirmCheckout) {
    await locked(ctx, input, async (tx) => {
      const [existing] = await tx
        .select()
        .from(purchase)
        .where(
          and(
            eq(purchase.provider, input.provider),
            eq(purchase.providerOrderId, result.providerRef),
          ),
        )
      if (
        existing &&
        (existing.workspaceId !== input.workspaceId ||
          existing.userId !== input.userId ||
          existing.planPriceId !== price.id)
      )
        fail('BILLING_PURCHASE_MISMATCH', 'Checkout order belongs to another purchase')
      if (!existing)
        await tx.insert(purchase).values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          planId: selected.id,
          planPriceId: price.id,
          provider: input.provider,
          providerOrderId: result.providerRef,
          amount: price.amount,
          currency: price.currency,
        })
    })
  }
  return result
}

export async function cancelSubscription(ctx: BillingServiceContext, input: SubscriptionInput) {
  const sub = await ownedSubscription(ctx, input)
  if (sub.cancelAtPeriodEnd) return
  if (!['active', 'trialing', 'past_due', 'paused'].includes(sub.status))
    fail('BILLING_SUBSCRIPTION_NOT_CANCELABLE', 'Subscription cannot be canceled')
  const provider = providerFor(ctx, sub.provider)
  await provider.cancelSubscription(sub.providerSubscriptionId, { atPeriodEnd: true })
  if (sub.provider === 'paypal') {
    await locked(ctx, input, async (tx) => {
      unchanged(sub, await reload(tx, sub))
      await tx
        .update(subscription)
        .set({
          status: 'canceled',
          cancelAtPeriodEnd: true,
          canceledAt: new Date(),
          lastEventAt: new Date(),
        })
        .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, input.workspaceId)))
      const after = await reload(tx, sub)
      if (after)
        await auditSubscriptionChange(tx, sub, after, 'cancel', input.userId, input.ip ?? null)
    })
  } else
    await persistSnapshot(
      ctx,
      input,
      sub,
      await provider.getSubscription(sub.providerSubscriptionId),
      'cancel',
    )
}

export async function resumeSubscription(ctx: BillingServiceContext, input: SubscriptionInput) {
  const sub = await ownedSubscription(ctx, input)
  const provider = providerFor(ctx, sub.provider)
  if (!provider.resumeSubscription)
    fail('BILLING_RESUME_UNAVAILABLE', 'Provider cannot resume subscriptions', 400)
  await locked(ctx, input, async (tx) => {
    unchanged(sub, await reload(tx, sub))
    const winner = await current(tx, input.workspaceId)
    if (winner && winner.id !== sub.id)
      fail('BILLING_RENEWING_SUBSCRIPTION_EXISTS', 'Another subscription is renewing')
    if (!sub.cancelAtPeriodEnd || !sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date())
      fail('BILLING_SUBSCRIPTION_NOT_RESUMABLE', 'Subscription cannot be resumed')
  })
  await provider.resumeSubscription(sub.providerSubscriptionId)
  const snapshot = await provider.getSubscription(sub.providerSubscriptionId)
  await persistSnapshot(ctx, input, sub, snapshot, 'resume')
}

export async function changePlan(
  ctx: BillingServiceContext,
  input: SubscriptionInput & { planPriceId: string },
) {
  const sub = await ownedSubscription(ctx, input)
  const { price, plan: target } = await priceFor(ctx, input.planPriceId, sub.provider)
  if (target.type !== 'subscription')
    fail('BILLING_PRICE_UNAVAILABLE', 'A subscription price is required', 400)
  const provider = providerFor(ctx, sub.provider)
  if (!provider.capabilities.changePlan || !provider.changePlan)
    return {
      status: 'checkout_required' as const,
      expectedOldSubscriptionId: sub.id,
      planPriceId: price.id,
      provider: sub.provider,
    }
  const [old] = await ctx.db
    .select({ plan, price: planPrice })
    .from(planPrice)
    .innerJoin(plan, eq(planPrice.planId, plan.id))
    .where(eq(planPrice.id, sub.planPriceId))
  if (!old) fail('BILLING_PRICE_UNAVAILABLE', 'Current price unavailable')
  await locked(ctx, input, async (tx) => {
    unchanged(sub, await reload(tx, sub))
    if ((await current(tx, input.workspaceId))?.id !== sub.id || sub.cancelAtPeriodEnd)
      fail('BILLING_SUBSCRIPTION_CHANGED', 'Change the current renewing subscription')
  })
  if (price.id === sub.planPriceId) return { status: 'unchanged' as const }
  // Rank determines tier changes. Within a tier, annual commitment upgrades monthly.
  const atPeriodEnd =
    target.sort < old.plan.sort ||
    (target.sort === old.plan.sort && old.price.interval === 'year' && price.interval === 'month')
  await provider.changePlan(sub.providerSubscriptionId, price, { atPeriodEnd })
  if (!atPeriodEnd)
    await persistSnapshot(
      ctx,
      input,
      sub,
      await provider.getSubscription(sub.providerSubscriptionId),
      'change',
    )
  return { status: atPeriodEnd ? ('scheduled' as const) : ('changed' as const) }
}

export async function getPortalUrl(
  ctx: BillingServiceContext,
  input: SubscriptionInput & { returnUrl: string },
) {
  const sub = await ownedSubscription(ctx, input)
  const provider = providerFor(ctx, sub.provider)
  if (!provider.capabilities.portal || !provider.getPortalUrl)
    fail('BILLING_PORTAL_UNAVAILABLE', 'Provider has no customer portal', 400)
  const [customer] = await ctx.db
    .select()
    .from(billingCustomer)
    .where(
      and(
        eq(billingCustomer.workspaceId, input.workspaceId),
        eq(billingCustomer.provider, sub.provider),
      ),
    )
  if (!customer?.providerCustomerId)
    fail('BILLING_CUSTOMER_NOT_FOUND', 'Billing customer unavailable', 404)
  return provider.getPortalUrl(customer.providerCustomerId, input.returnUrl)
}

export async function confirmCheckout(
  ctx: BillingServiceContext,
  input: BillingActor & { provider: PaymentProviderId; providerRef: string },
) {
  await owner(ctx.db, input)
  const provider = providerFor(ctx, input.provider)
  if (!provider.confirmCheckout)
    fail('BILLING_CONFIRM_UNAVAILABLE', 'Provider has no capture operation', 400)
  const [owned] = await ctx.db
    .select()
    .from(purchase)
    .where(
      and(
        eq(purchase.workspaceId, input.workspaceId),
        eq(purchase.userId, input.userId),
        eq(purchase.provider, input.provider),
        eq(purchase.providerOrderId, input.providerRef),
      ),
    )
  if (!owned) fail('BILLING_PURCHASE_NOT_FOUND', 'Purchase unavailable', 404)
  if (owned.status === 'paid') return
  if (owned.status !== 'pending')
    fail('BILLING_PURCHASE_NOT_PENDING', 'Purchase cannot be captured')
  await provider.confirmCheckout(input.providerRef, { idempotencyKey: `capture:${owned.id}` })
}
