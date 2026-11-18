import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

// 未配置数据库时不运行用例；配置了则必须是同一个隔离库（@product-res/db/test-database）。
const database = resolveTestDatabase('@product-res/credits')
const integration = Boolean(database)
if (database) {
  process.env.CREDITS_TEST_DATABASE_URL = database.appUrl
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
}

export default defineConfig({
  test: {
    environment: 'node',
    include: integration ? ['test/**/*.test.ts'] : [],
    passWithNoTests: !integration,
    globalSetup: integration ? ['@product-res/db/test/global-setup'] : [],
  },
})
