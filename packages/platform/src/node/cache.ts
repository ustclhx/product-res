import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { Redis } from 'ioredis'
import type { KeyValueStore, RateLimiter, RateLimitPolicy } from '../index.ts'

export type NodeRateLimitPolicies = Readonly<
  Record<RateLimitPolicy, { readonly limit: number; readonly periodSeconds: number }>
>

/** 与默认 Wrangler 三种策略保持一致；入口可显式传入经校验的配置。 */
export const defaultNodeRateLimitPolicies: NodeRateLimitPolicies = {
  auth: { limit: 10, periodSeconds: 60 },
  ai: { limit: 20, periodSeconds: 60 },
  api: { limit: 60, periodSeconds: 60 },
}

const fixedWindow = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count <= tonumber(ARGV[2]) and 1 or 0
`

export interface NodeCacheOptions {
  readonly url: string
  readonly namespace: string
  readonly policies?: NodeRateLimitPolicies
  readonly timeoutMs?: number
}

/** 进程拥有此连接；web/jobs 必须使用相同 namespace，并在排空后台任务后 close。 */
export async function createNodeCache(options: NodeCacheOptions) {
  const policies = options.policies ?? defaultNodeRateLimitPolicies
  if (!options.namespace.trim()) throw new Error('Cache namespace must not be empty')
  for (const { limit, periodSeconds } of Object.values(policies)) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(periodSeconds) ||
      periodSeconds < 1
    )
      throw new Error('Invalid rate limit policy')
  }
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid cache timeout')
  async function execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      throw new AppError('CACHE_UNAVAILABLE', 'Cache is unavailable', { status: 503 })
    }
  }
  const client = await execute(
    async () =>
      new Redis(options.url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: timeoutMs,
        commandTimeout: timeoutMs,
        maxRetriesPerRequest: 0,
        // 不自动重放 INCR，也不积压故障期间的防刷请求。
        retryStrategy: () => null,
        autoResendUnfulfilledCommands: false,
      }),
  )
  // 驱动异常可能包含连接信息，只记录固定事件；调用处转换为安全的 503。
  client.on('error', () => log.warn('platform.cache.connection_failed'))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await execute(() =>
      Promise.race([
        (async () => {
          await client.connect()
          await client.ping()
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cache connection timeout')), timeoutMs)
        }),
      ]),
    )
  } catch (error) {
    client.disconnect()
    throw error
  } finally {
    clearTimeout(timer)
  }
  // 长度前缀避免 namespace/purpose/key 中的分隔符造成跨用途碰撞。
  const keyFor = (...parts: string[]) =>
    [options.namespace, ...parts].map((part) => `${part.length}:${part}`).join(':')
  function kv(purpose: 'auth' | 'settings' | 'models'): KeyValueStore {
    function get(key: string): Promise<string | null>
    function get<T>(key: string, type: 'json'): Promise<T | null>
    async function get<T>(key: string, type?: 'json'): Promise<T | string | null> {
      const value = await execute(() => client.get(keyFor('kv', purpose, key)))
      return value === null || type !== 'json' ? value : (JSON.parse(value) as T)
    }
    return {
      get,
      async put(key, value, options) {
        const ttl = options?.expirationTtl
        if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1))
          throw new Error('Invalid cache TTL')
        await execute(() =>
          ttl === undefined
            ? client.set(keyFor('kv', purpose, key), value)
            : client.set(keyFor('kv', purpose, key), value, 'EX', ttl),
        )
      },
      async delete(key) {
        await execute(() => client.del(keyFor('kv', purpose, key)))
      },
    }
  }
  const rateLimiter: RateLimiter = {
    async limit(policy, key) {
      const { limit, periodSeconds } = policies[policy]
      const result = await execute(() =>
        client.eval(fixedWindow, 1, keyFor('rate', policy, key), periodSeconds, limit),
      )
      return { success: result === 1 }
    },
  }
  return {
    kv,
    rateLimiter,
    async ping(): Promise<void> {
      await execute(() => client.ping())
    },
    async close(): Promise<void> {
      try {
        if (client.status === 'ready') await execute(() => client.quit())
      } finally {
        client.disconnect()
      }
    },
  }
}
