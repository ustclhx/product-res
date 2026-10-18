import { fileURLToPath } from 'node:url'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const valkeyUrl = readLocalEnv('TEST_VALKEY_URL')
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Node billing/admin tests require isolated database URLs and TEST_VALKEY_URL')
const app = new URL(appUrl)
const migrator = new URL(migratorUrl)
if (
  app.host !== migrator.host ||
  app.pathname !== migrator.pathname ||
  (!app.pathname.startsWith('/product_res_wt_') &&
    !(process.env.CI && app.pathname === '/product_res_ci'))
)
  throw new Error('Node billing/admin tests require matching isolated worktree or CI databases')
process.env.NODE_ADMIN_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl
process.env.TEST_VALKEY_URL = valkeyUrl

export default defineConfig({
  resolve: {
    alias: [
      {
        find: './admin-test-resources.ts',
        replacement: fileURLToPath(new URL('./test/admin-node-resources.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/admin*.test.ts'],
    // 运行时设置与固定历史指标共享同一个隔离库，保持既有 CF 项目的串行方式。
    fileParallelism: false,
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
