import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const valkeyUrl = process.env.TEST_VALKEY_URL
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Production smoke requires isolated PG and Valkey')
const app = new URL(appUrl)
const migrator = new URL(migratorUrl)
if (
  app.host !== migrator.host ||
  app.pathname !== migrator.pathname ||
  (!app.pathname.startsWith('/product_res_wt_') &&
    !(process.env.CI && app.pathname === '/product_res_ci'))
)
  throw new Error('Production smoke requires matching isolated worktree or CI databases')
process.env.NODE_PRODUCTION_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/fixtures/production-node/*.node.ts'],
    globalSetup: ['@product-res/db/test/global-setup'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
})
