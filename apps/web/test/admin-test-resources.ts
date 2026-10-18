import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import type { KeyValueStore, RateLimiter } from '@product-res/platform'

/** CF 目标夹具；Node 项目精确替换此模块，业务断言不导入平台 binding。 */
export function createAdminTestDb(role: 'app' | 'migrator' = 'app') {
  return createDb(role === 'app' ? env.HYPERDRIVE : env.HYPERDRIVE_MIGRATOR)
}

export const cacheValues = new Map<string, string>()
function get(key: string): Promise<string | null>
function get<T>(key: string, type: 'json'): Promise<T | null>
async function get<T>(key: string, type?: 'json'): Promise<T | string | null> {
  const value = cacheValues.get(key) ?? null
  return value === null || type !== 'json' ? value : (JSON.parse(value) as T)
}
export const adminCache: KeyValueStore = {
  get,
  async put(key, value) {
    cacheValues.set(key, value)
  },
  async delete(key) {
    cacheValues.delete(key)
  },
}
export const rateLimiter: RateLimiter = {
  limit: (_policy, key) => env.RL_AUTH.limit({ key }),
}
