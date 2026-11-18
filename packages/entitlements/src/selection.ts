import type { PlanFeatures, SubscriptionStatus } from '@product-res/db'
import { AppError } from '@product-res/shared'

export type { PlanFeatures } from '@product-res/db'

/**
 * Canonical pre-seed free defaults; seed code should reuse this export.
 * Numeric/boolean defaults follow docs/05-billing.md §5 (3 tasks, 5 GB). Seats are 10 in this project
 * (add-team-invite-links): billing has no payment providers, production has no seeded plan rows,
 * and team workspaces must accept invitees on this fallback.
 * No models are granted until a persisted free plan supplies its allowlist.
 */
export const DEFAULT_FREE_FEATURES: PlanFeatures = {
  models: [],
  maxConcurrentTasks: 3,
  maxSeats: 10,
  storageGb: 5,
  publicApi: false,
  priorityQueue: false,
  watermark: true,
}

export interface Entitlements {
  readonly key: string
  /** 套餐显示名；只有内置免费兜底没有名称（账单页据此显示本地化文案而不是 key） */
  readonly name?: string
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

/** 与套餐选择和账单摘要共用订阅生效规则。 */
export function isSubscriptionEffective(
  sub: Pick<EntitlementSubscription, 'status' | 'pastDueSince' | 'currentPeriodEnd'>,
  { now = new Date(), pastDueGraceDays = 7 }: EntitlementOptions = {},
): boolean {
  // Provider 尚未确认服务周期时，不授予付费权益。
  if (sub.currentPeriodEnd === null) return false
  switch (sub.status) {
    case 'trialing':
    case 'active':
      return true
    case 'past_due':
      return (
        sub.pastDueSince !== null &&
        now.getTime() < new Date(sub.pastDueSince).getTime() + pastDueGraceDays * 86_400_000
      )
    case 'canceled':
    case 'expired':
      return now.getTime() < new Date(sub.currentPeriodEnd).getTime()
    case 'paused':
      return false
  }
}

export function selectEntitlements(
  subscriptions: readonly EntitlementSubscription[],
  free: Entitlements | undefined,
  { now = new Date(), pastDueGraceDays = 7 }: EntitlementOptions = {},
): Entitlements {
  let highest: Entitlements | undefined
  for (const sub of subscriptions) {
    if (
      isSubscriptionEffective(sub, { now, pastDueGraceDays }) &&
      (!highest || sub.plan.sort > highest.sort)
    )
      highest = sub.plan
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
export function can<const Capability extends string>(
  ctx: Context,
  capability: Exclude<Capability, 'ai.useModel'>,
): boolean
export function can(
  ctx: Context,
  capability: string,
  options?: { readonly modelKey: string; readonly tags?: readonly string[] },
): boolean {
  const features = featuresOf(ctx)
  if (capability === 'publicApi' || capability === 'priorityQueue' || capability === 'watermark')
    return features[capability]
  if (capability !== 'ai.useModel')
    return (
      features.capabilities !== undefined &&
      Object.hasOwn(features.capabilities, capability) &&
      features.capabilities[capability] === true
    )
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

export type EntitlementRequirement<Capability extends string = never> =
  | { readonly capability: BooleanCapability }
  | { readonly capability: Exclude<Capability, 'ai.useModel'> }
  | {
      readonly capability: 'ai.useModel'
      readonly modelKey: string
      readonly tags?: readonly string[]
    }
  | { readonly limit: EntitlementLimit; readonly value: number }

export const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED'

/** Numeric value is the requested total (e.g. current tasks + the new task). */
export function requireEntitlement<const Capability extends string>(
  ctx: Context,
  requirement: EntitlementRequirement<Capability>,
): void {
  const allowed =
    'limit' in requirement
      ? Number.isFinite(requirement.value) &&
        requirement.value >= 0 &&
        requirement.value <= limit(ctx, requirement.limit)
      : requirement.capability === 'ai.useModel'
        ? 'modelKey' in requirement && can(ctx, 'ai.useModel', requirement)
        : can<string>(ctx, requirement.capability)
  if (!allowed)
    throw new AppError(UPGRADE_REQUIRED, 'Upgrade your plan to use this feature', { status: 403 })
}
