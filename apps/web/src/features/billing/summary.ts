import type { EntitlementOptions, EntitlementSubscription } from '@product-res/entitlements'
import { isSubscriptionEffective } from '@product-res/entitlements'

type SummarySubscription = EntitlementSubscription & {
  id: string
  name: string
  provider: string
  cancelAtPeriodEnd: boolean
}

/** Shares effective-period/grace rules with entitlement selection, including paid overlap. */
export function billingSubscriptionSummary(
  subscriptions: readonly SummarySubscription[],
  options: EntitlementOptions = {},
) {
  const now = options.now ?? new Date()
  const current = subscriptions
    .filter((sub) => isSubscriptionEffective(sub, { ...options, now }))
    .sort((a, b) => b.plan.sort - a.plan.sort)[0]
  return {
    currentSubscription: current
      ? {
          id: current.id,
          name: current.name,
          planKey: current.plan.key,
          provider: current.provider,
          status: current.status,
          currentPeriodEnd: current.currentPeriodEnd,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
        }
      : null,
    nextRenewalAt:
      current &&
      !current.cancelAtPeriodEnd &&
      current.currentPeriodEnd !== null &&
      new Date(current.currentPeriodEnd).getTime() > now.getTime() &&
      ['active', 'trialing', 'past_due'].includes(current.status)
        ? current.currentPeriodEnd
        : null,
  }
}
