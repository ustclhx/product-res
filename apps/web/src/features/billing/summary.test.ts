import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { describe, expect, it } from 'vitest'
import { billingSubscriptionSummary } from './summary.ts'

const now = new Date('2026-11-10T12:00:00Z')
const end = new Date('2026-12-01T00:00:00Z')
const sub = {
  id: 'current',
  name: 'Pro',
  provider: 'stripe',
  status: 'active' as const,
  currentPeriodEnd: end,
  pastDueSince: null,
  cancelAtPeriodEnd: false,
  plan: { key: 'pro', sort: 10, features: DEFAULT_FREE_FEATURES },
}

describe('billing subscription summary', () => {
  it('selects the highest effective paid plan during overlap using entitlement rules', () => {
    const higher = {
      ...sub,
      id: 'old-higher',
      status: 'canceled' as const,
      cancelAtPeriodEnd: true,
      plan: { ...sub.plan, key: 'business', sort: 20 },
    }
    const summary = billingSubscriptionSummary([sub, higher], { now })
    expect(summary.currentSubscription?.id).toBe('old-higher')
    expect(summary.nextRenewalAt).toBeNull()
    expect(billingSubscriptionSummary([sub], { now }).nextRenewalAt).toEqual(end)
  })
  it('never promises renewal for canceled or terminated subscriptions and respects grace', () => {
    expect(
      billingSubscriptionSummary(
        [
          {
            ...sub,
            status: 'past_due',
            pastDueSince: now,
            currentPeriodEnd: new Date('2026-11-09Z'),
          },
        ],
        { now },
      ).nextRenewalAt,
    ).toBeNull()
    for (const status of ['canceled', 'expired'] as const) {
      expect(billingSubscriptionSummary([{ ...sub, status }], { now }).nextRenewalAt).toBeNull()
    }
    expect(
      billingSubscriptionSummary([{ ...sub, cancelAtPeriodEnd: true }], { now }).nextRenewalAt,
    ).toBeNull()
    expect(
      billingSubscriptionSummary(
        [{ ...sub, status: 'past_due', pastDueSince: new Date('2026-11-01Z') }],
        { now, pastDueGraceDays: 3 },
      ).currentSubscription,
    ).toBeNull()
    expect(
      billingSubscriptionSummary([{ ...sub, status: 'expired', currentPeriodEnd: new Date(0) }], {
        now,
      }).currentSubscription,
    ).toBeNull()
  })
})
