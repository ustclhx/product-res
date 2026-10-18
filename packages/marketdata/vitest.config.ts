import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

// 与 @product-res/entitlements 一致：只在隔离的 worktree 或 CI 数据库上运行集成测试。
const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const fallbackApp = process.env.CI ? undefined : 'postgres://app:app@localhost:5432/product_res_dev'
const fallbackMigrator = process.env.CI
  ? undefined
  : 'postgres://migrator:migrator@localhost:5432/product_res_dev'
const app = appUrl ?? fallbackApp
const migrator = migrationUrl ?? fallbackMigrator
if (app && migrator) {
  process.env.MIGRATION_DATABASE_URL = migrator
  process.env.MARKETDATA_TEST_DATABASE_URL = app
} else console.warn('[@product-res/marketdata] 未配置数据库，跳过集成测试')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    ...(app && migrator ? { globalSetup: ['@product-res/db/test/global-setup'] } : {}),
    // 额度与观测表是部署级共享表，集成测试串行运行，避免互相干扰
    fileParallelism: false,
  },
})
