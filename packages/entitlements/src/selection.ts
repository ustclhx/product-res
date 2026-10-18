import type { PlanFeatures, SubscriptionStatus } from '@product-res/db'
import { AppError } from '@product-res/shared'

export type { PlanFeatures } from '@product-res/db'

/**
 * Canonical pre-seed free defaults; seed code should reuse this export.
 * Numeric/boolean defaults follow docs/05-billing.md §5 (3 tasks, 1 seat, 5 GB).
 * No models are granted until a persisted free plan supplies its allowlist.
 */
export const DEFAULT_FREE_FEATURES: PlanFeatures = {
  models: [],
  maxConcurrentTasks: 3,
  maxSeats: 1,
  storageGb: 5,
  publicApi: false,
  priorityQueue: false,
  watermark: true,
}

export interface Entitlements {
  readonly key: string
  readonly sort: number
  readonly features: PlanFeatures
}

export interface EntitlementSubscription {
  readonly status: SubscriptionStatus
  readonly pastDueSince: Date | string | null
  readonly currentPeriodEnd: Date | string | null
  readonly plan: Entitlements
}

export interface EntitlementOptions {
  readonly now?: Date
  readonly pastDueGraceDays?: number
}

export function selectEntitlements(
  subscriptions: readonly EntitlementSubscription[],
  free: Entitlements | undefined,
  { now = new Date(), pastDueGraceDays = 7 }: EntitlementOptions = {},
): Entitlements {
  let highest: Entitlements | undefined
  for (const sub of subscriptions) {
    // A provider activation without a confirmed period grants no paid entitlement.
    if (sub.currentPeriodEnd === null) continue
    let effective: boolean
    switch (sub.status) {
      case 'trialing':
      case 'active':
        effective = true
        break
      case 'past_due':
        effective =
          sub.pastDueSince !== null &&
          now.getTime() < new Date(sub.pastDueSince).getTime() + pastDueGraceDays * 86_400_000
        break
      case 'canceled':
      case 'expired':
        effective = now.getTime() < new Date(sub.currentPeriodEnd).getTime()
        break
      case 'paused':
        effective = false
        break
    }
    if (effective && (!highest || sub.plan.sort > highest.sort)) highest = sub.plan
  }
  return highest ?? free ?? { key: 'free', sort: 0, features: DEFAULT_FREE_FEATURES }
}

type Context = Entitlements | { readonly entitlements: Entitlements }
export type BooleanCapability = 'publicApi' | 'priorityQueue' | 'watermark'
export type EntitlementLimit = 'maxConcurrentTasks' | 'maxSeats' | 'storageGb'

const featuresOf = (ctx: Context) =>
  'entitlements' in ctx ? ctx.entitlements.features : ctx.features

export function can(
  ctx: Context,
  capability: 'ai.useModel',
  options: { readonly modelKey: string; readonly tags?: readonly string[] },
): boolean
export function can(ctx: Context, capability: BooleanCapability): boolean
export function can(
  ctx: Context,
  capability: 'ai.useModel' | BooleanCapability,
  options?: { readonly modelKey: string; readonly tags?: readonly string[] },
): boolean {
  const features = featuresOf(ctx)
  if (capability !== 'ai.useModel') return features[capability]
  return (
    options !== undefined &&
    features.models.some(
      (key) => key === '*' || key === options.modelKey || options.tags?.includes(key),
    )
  )
}

export function limit(ctx: Context, key: EntitlementLimit): number {
  return featuresOf(ctx)[key]
}

export type EntitlementRequirement =
  | { readonly capability: BooleanCapability }
  | {
      readonly capability: 'ai.useModel'
      readonly modelKey: string
      readonly tags?: readonly string[]
    }
  | { readonly limit: EntitlementLimit; readonly value: number }

export const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED'

/** Numeric value is the requested total (e.g. current tasks + the new task). */
export function requireEntitlement(ctx: Context, requirement: EntitlementRequirement): void {
  const allowed =
    'limit' in requirement
      ? Number.isFinite(requirement.value) &&
        requirement.value >= 0 &&
        requirement.value <= limit(ctx, requirement.limit)
      : requirement.capability === 'ai.useModel'
        ? can(ctx, requirement.capability, requirement)
        : can(ctx, requirement.capability)
  if (!allowed)
    throw new AppError(UPGRADE_REQUIRED, 'Upgrade your plan to use this feature', { status: 403 })
}
