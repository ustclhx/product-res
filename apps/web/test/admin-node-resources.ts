import { createDb } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { createNodeCache } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { afterAll } from 'vitest'

const appUrl = process.env.NODE_ADMIN_DATABASE_URL
const migratorUrl = process.env.MIGRATION_DATABASE_URL
const cacheUrl = process.env.TEST_VALKEY_URL
if (!appUrl || !migratorUrl || !cacheUrl) throw new Error('Missing Node admin test resources')
const db = createDb(appUrl, { max: 5 })
const migrator = createDb(migratorUrl, { max: 1 })
const cache = await createNodeCache({
  url: cacheUrl,
  namespace: `node-admin-test-${newId()}`,
})
export function createAdminTestDb(role: 'app' | 'migrator' = 'app') {
  return createDb((role === 'app' ? db : migrator).$client)
}
// 镜像记录供现有事务回滚断言使用，实际读写仍经过真实 Valkey。
export const cacheValues = new Map<string, string>()
const kv = cache.kv('auth')
export const adminCache: KeyValueStore = {
  get: kv.get,
  async put(key, value, options) {
    await kv.put(key, value, options)
    cacheValues.set(key, value)
  },
  async delete(key) {
    await kv.delete(key)
    cacheValues.delete(key)
  },
}
export const rateLimiter = cache.rateLimiter
// 默认 stack 顺序确保测试清理完成后才关闭本文件拥有的连接。
afterAll(async () => {
  await Promise.all([cache.close(), db.close(), migrator.close()])
})
