import { AppError } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import {
  can,
  DEFAULT_FREE_FEATURES,
  type EntitlementSubscription,
  type Entitlements,
  limit,
  requireEntitlement,
  selectEntitlements,
  UPGRADE_REQUIRED,
} from './selection.ts'

const now = new Date('2026-10-04T00:00:00Z')
const day = 86_400_000
const at = (days: number) => new Date(now.getTime() + days * day)
const free: Entitlements = { key: 'free', sort: 0, features: DEFAULT_FREE_FEATURES }
const pro: Entitlements = {
  key: 'pro',
  sort: 10,
  features: { ...DEFAULT_FREE_FEATURES, models: ['premium', 'text'], maxSeats: 5, publicApi: true },
}
const team: Entitlements = { ...pro, key: 'team', sort: 20 }
const sub = (
  status: EntitlementSubscription['status'],
  plan = pro,
  overrides: Partial<EntitlementSubscription> = {},
): EntitlementSubscription => ({
  status,
  plan,
  currentPeriodEnd: at(10),
  pastDueSince: at(-6),
  ...overrides,
})
const select = (subs: EntitlementSubscription[], grace?: number) =>
  selectEntitlements(subs, free, {
    now,
    ...(grace === undefined ? {} : { pastDueGraceDays: grace }),
  })

describe('read-time subscription selection', () => {
  it('does not grant a paid plan before a confirmed service period exists', () => {
    expect(select([sub('active', pro, { currentPeriodEnd: null })])).toBe(free)
  })

  it('expires past-due entitlements at the grace boundary without cron', () => {
    expect(select([sub('past_due')])).toBe(pro)
    expect(select([sub('past_due', pro, { pastDueSince: at(-7) })])).toBe(free)
    expect(select([sub('past_due', pro, { pastDueSince: at(-8) })])).toBe(free)
    expect(select([sub('past_due', pro, { pastDueSince: null })])).toBe(free)
    expect(select([sub('past_due')], 5)).toBe(free)
  })

  it.each(['canceled', 'expired'] as const)('keeps %s until the period ends', (status) => {
    expect(select([sub(status)])).toBe(pro)
    expect(select([sub(status, pro, { currentPeriodEnd: now.toISOString() })])).toBe(free)
  })

  it('chooses the highest sort among overlapping effective subscriptions', () => {
    expect(
      select([sub('canceled'), sub('active', team), sub('paused', { ...pro, sort: 30 })]),
    ).toBe(team)
    expect(select([sub('trialing', team), sub('active')])).toBe(team)
  })

  it('uses persisted free features for paused subscriptions, or canonical defaults before seed', () => {
    const persisted = {
      ...free,
      features: { ...DEFAULT_FREE_FEATURES, models: ['basic'], maxSeats: 2 },
    }
    expect(selectEntitlements([sub('paused')], persisted, { now })).toBe(persisted)
    expect(selectEntitlements([], undefined, { now })).toEqual(free)
  })
})

describe('capabilities and limits', () => {
  it('allows exact model keys, model tags, and wildcard plans', () => {
    expect(can(pro, 'ai.useModel', { modelKey: 'premium' })).toBe(true)
    expect(can(pro, 'ai.useModel', { modelKey: 'other', tags: ['text'] })).toBe(true)
    expect(
      can({ ...pro, features: { ...pro.features, models: ['*'] } }, 'ai.useModel', {
        modelKey: 'other',
      }),
    ).toBe(true)
    expect(can(pro, 'ai.useModel', { modelKey: 'other' })).toBe(false)
    expect(can({ entitlements: pro }, 'publicApi')).toBe(true)
    expect(limit({ entitlements: free }, 'maxSeats')).toBe(1)
  })

  it('rejects a paid model on free with a distinguishable upgrade AppError', () => {
    try {
      requireEntitlement(free, { capability: 'ai.useModel', modelKey: 'premium' })
      expect.fail('paid model must be denied')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect(error).toMatchObject({ code: UPGRADE_REQUIRED, status: 403 })
      expect((error as AppError).toJSON()).toMatchObject({ error: { code: UPGRADE_REQUIRED } })
    }
  })

  it('validates requested totals against the numeric limit', () => {
    expect(() => requireEntitlement(free, { limit: 'maxSeats', value: 1 })).not.toThrow()
    expect(() => requireEntitlement(free, { limit: 'maxSeats', value: 2 })).toThrow(AppError)
    expect(() => requireEntitlement(free, { capability: 'publicApi' })).toThrow(AppError)
  })
})
