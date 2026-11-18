import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

// 未配置数据库时只跑不连库的用例；配置了则必须是同一个隔离库（@product-res/db/test-database），不回落到开发库。
const database = resolveTestDatabase('@product-res/marketdata')
if (database) {
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
  process.env.MARKETDATA_TEST_DATABASE_URL = database.appUrl
} else console.warn('[@product-res/marketdata] 未配置隔离数据库，跳过集成测试')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    ...(database ? { globalSetup: ['@product-res/db/test/global-setup'] } : {}),
    // 额度与观测表是部署级共享表，集成测试串行运行，避免互相干扰
    fileParallelism: false,
  },
})
