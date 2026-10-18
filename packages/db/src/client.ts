import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Options, type Sql } from 'postgres'
import * as schema from './schema/index.ts'

/** Hyperdrive 绑定中本包用到的部分；与 workers-types 的 `Hyperdrive` 结构兼容。 */
export interface HyperdriveBinding {
  readonly connectionString: string
}

export type Database = ReturnType<typeof facade>
export type DatabasePoolOptions = Options<Record<string, postgres.PostgresType>>

function facade(sql: Sql) {
  return drizzle(sql, { schema })
}

/**
 * CF 每请求/事件传 Hyperdrive，不缓存到模块作用域、不调用 end。
 * Node 在启动时传 string 创建自有池，请求内传 Sql 借用同一池。
 */
export function createDb(input: HyperdriveBinding | string | Sql, options?: DatabasePoolOptions) {
  const borrowed = typeof input === 'function'
  const cloudflare = typeof input === 'object'
  const sql = borrowed
    ? input
    : postgres(typeof input === 'string' ? input : input.connectionString, {
        max: cloudflare ? 5 : 10,
        fetch_types: false,
        prepare: true,
        ...options,
      })
  const db = facade(sql)
  return Object.assign(db, {
    /** 只有 string 模式拥有可关闭资源；借用 facade 与 CF 关闭均不影响底层池。 */
    ownsPool: !borrowed && !cloudflare,
    close: async () => {
      if (!borrowed && !cloudflare) await sql.end({ timeout: 5 })
    },
  })
}
