import { createDb, type HyperdriveBinding } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { newRequestId } from '@product-res/shared/log'
import type {
  BackgroundTasks,
  ConfigScalar,
  DatabaseAccess,
  KeyValueStore,
  PlatformEnv,
  RateLimiter,
  RequestMetadata,
} from '../index.ts'

export * from './queue.ts'
export * from './scheduler.ts'
export * from './workflow.ts'

/** app 先用自己的 schema 校验，再显式挑选标量；不把原始 env/bindings 交给业务。 */
export function createCloudflareEnv<C extends { [K in keyof C]: ConfigScalar }>(
  config: C,
  capabilities: PlatformEnv['capabilities'],
): PlatformEnv<C> {
  return { config, capabilities }
}

/** 必须在每个请求/事件内创建；闭包只复用该次调用的客户端，不调用 sql.end。 */
export function createCloudflareDatabase(bindings: {
  HYPERDRIVE: HyperdriveBinding
  HYPERDRIVE_CACHED: HyperdriveBinding
}): DatabaseAccess {
  let business: ReturnType<typeof createDb> | undefined
  let publicData: ReturnType<typeof createDb> | undefined
  return {
    business: () => (business ??= createDb(bindings.HYPERDRIVE)),
    public: () => (publicData ??= createDb(bindings.HYPERDRIVE_CACHED)),
  }
}

export function createCloudflareKv(binding: KVNamespace): KeyValueStore {
  function get(key: string): Promise<string | null>
  function get<T>(key: string, type: 'json'): Promise<T | null>
  function get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    return type === 'json' ? binding.get<T>(key, 'json') : binding.get(key)
  }
  return {
    get,
    put: (key, value, options) =>
      binding.put(
        key,
        value,
        options?.expirationTtl === undefined
          ? undefined
          : { expirationTtl: Math.max(60, options.expirationTtl) },
      ),
    delete: (key) => binding.delete(key),
  }
}

export function createCloudflareRateLimiter(bindings: {
  RL_AUTH?: RateLimit
  RL_AI?: RateLimit
  RL_API?: RateLimit
}): RateLimiter {
  const policies = { auth: bindings.RL_AUTH, ai: bindings.RL_AI, api: bindings.RL_API }
  return {
    limit(policy, key) {
      const binding = policies[policy]
      if (!binding)
        throw new AppError('CAPABILITY_UNAVAILABLE', `${policy} rate limit is unavailable`, {
          status: 503,
        })
      return binding.limit({ key })
    },
  }
}

export function createCloudflareBackgroundTasks(
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): BackgroundTasks {
  return { waitUntil: (promise) => ctx.waitUntil(promise) }
}

/** 仅可信 CF composition entry 调用；Node 不得把 cf-connecting-ip 作为客户端 IP。 */
export function createCloudflareRequestMetadata(request: Request): RequestMetadata {
  const cfRay = request.headers.get('cf-ray')
  return {
    requestId: newRequestId(),
    clientIp: request.headers.get('cf-connecting-ip'),
    ...(cfRay === null ? {} : { cfRay }),
  }
}
