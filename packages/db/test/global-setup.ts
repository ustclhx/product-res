import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { assertIsolatedTestDatabase, missingLocalTestDatabaseError } from '../test-database.ts'

// 集成测试前以 migrator 账号把迁移应用到选定的测试库（已应用的迁移会跳过）。
// 也被 apps/web、apps/jobs 的集成测试复用（导出为 @product-res/db/test/global-setup）。
// turbo 会并行运行多个包的测试，迁移前先取会话级 advisory lock，避免并发迁移互相冲突。
const MIGRATION_LOCK_ID = 7_200_501

export default async function setup() {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) throw new Error('MIGRATION_DATABASE_URL 未设置')
  // 最后一道防线：任何配置路径都不能把迁移应用到开发主库等非隔离库
  assertIsolatedTestDatabase({ migrator: url }, '@product-res/db/test/global-setup')
  // max: 1 保证加锁、迁移、解锁走同一个连接
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`.catch((error: unknown) => {
      if (error instanceof postgres.PostgresError && error.code === '3D000') {
        throw missingLocalTestDatabaseError('@product-res/db/test/global-setup', url) ?? error
      }
      throw error
    })
    await migrate(drizzle(sql), {
      migrationsFolder: new URL('../migrations', import.meta.url).pathname,
    })
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
  } finally {
    await sql.end()
  }
}
