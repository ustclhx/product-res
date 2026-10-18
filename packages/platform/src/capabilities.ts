import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'

/** 未装配的能力不能以空实现冒充成功；调用方在副作用发生前检查。 */
export type Capability<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false }

export function requireCapability<T>(capability: Capability<T>, name: string): T {
  if (!capability.available)
    throw new AppError('CAPABILITY_UNAVAILABLE', `${name} is unavailable`, { status: 503 })
  return capability.value
}

export type ConfigScalar = string | number | boolean | undefined
export interface PlatformEnv<
  C extends { [K in keyof C]: ConfigScalar } = Readonly<Record<string, ConfigScalar>>,
> {
  /** composition root 传入已校验的标量配置；bindings 不进入业务 env。 */
  readonly config: Readonly<C>
  readonly capabilities: Readonly<{
    queue: boolean
    transactionalEnqueue: boolean
    workflow: boolean
    scheduler: boolean
    workersAi: boolean
    files: boolean
  }>
}

export interface DatabaseAccess {
  business(): Database
  /** 仅允许公开、可短暂陈旧的数据使用；不承诺 Node 有查询缓存。 */
  public(): Database
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  get<T>(key: string, type: 'json'): Promise<T | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export type RateLimitPolicy = 'auth' | 'ai' | 'api'
export interface RateLimiter {
  limit(policy: RateLimitPolicy, key: string): Promise<{ success: boolean }>
}

export interface BackgroundTasks {
  waitUntil(promise: Promise<unknown>): void
}

export interface RequestMetadata {
  readonly clientIp: string | null
  readonly requestId: string
  readonly cfRay?: string
}

export type DependencyStatus = 'up' | 'down' | 'unavailable'
export interface QueueHealth {
  readonly status: DependencyStatus
}
export interface SchedulerHealth {
  readonly status: DependencyStatus
  /** 最近成功心跳的 UTC ISO 时间，未装配或没有记录时为 null。 */
  readonly lastCronAt: string | null
}
export interface TaskHealth {
  queue(): Promise<QueueHealth>
  scheduler(): Promise<SchedulerHealth>
}
