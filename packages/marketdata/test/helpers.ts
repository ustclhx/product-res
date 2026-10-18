import type { ConnectorContext } from '@product-res/datasources'
import { createDb } from '@product-res/db'
import { newId } from '@product-res/shared'
import { afterAll } from 'vitest'

const url = process.env.MARKETDATA_TEST_DATABASE_URL
/** 未配置数据库时跳过集成测试 */
export const integration = Boolean(url)

export function testDb() {
  // describe.skipIf 仍会执行回调收集用例；未配置时用占位地址（postgres.js 惰性连接，不会真正连库）
  const db = createDb(url ?? 'postgres://skip@127.0.0.1:1/skip')
  afterAll(() => db.$client.end())
  return db
}

/** 每个用例使用独立的数据源 ID 与商品 ID，部署级共享表互不干扰 */
export const uniqueId = (prefix: string) => `${prefix}-${newId().slice(-12)}`

export function context(now: Date, overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    fetch: (() => {
      throw new Error('network disabled in tests')
    }) as unknown as typeof fetch,
    secret: () => undefined,
    now: () => now,
    ...overrides,
  }
}
