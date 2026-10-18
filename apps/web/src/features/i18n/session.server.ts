import { AsyncLocalStorage } from 'node:async_hooks'
import { type FreshSession, requireFreshSession } from '@product-res/auth'

const sessions = new AsyncLocalStorage<{ value?: Promise<FreshSession> }>()

/** 仅供请求内的只读会话使用；认证端点和安全写操作仍直接 requireFreshSession。 */
export function withSessionCache<T>(next: () => T): T {
  return sessions.run({}, next)
}

export function readRequestSession(
  options: Parameters<typeof requireFreshSession>[0],
): Promise<FreshSession> {
  const cache = sessions.getStore()
  if (!cache) return requireFreshSession(options)
  cache.value ??= requireFreshSession(options)
  return cache.value
}
