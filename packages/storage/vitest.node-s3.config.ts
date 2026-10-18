import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const integration = Boolean(appUrl && migratorUrl)
if (!integration) throw new Error('Node storage tests require an isolated database for replay')
if (appUrl || migratorUrl) {
  if (!appUrl || !migratorUrl) throw new Error('Node storage tests require both database URLs')
  const app = new URL(appUrl)
  const migrator = new URL(migratorUrl)
  if (
    app.host !== migrator.host ||
    app.pathname !== migrator.pathname ||
    (!app.pathname.startsWith('/product_res_wt_') &&
      !(process.env.CI && app.pathname === '/product_res_ci'))
  )
    throw new Error('Node storage tests require matching isolated worktree or CI databases')
  process.env.NODE_DB_TEST_URL = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
}

export default defineConfig({
  test: {
    name: 'node-s3',
    environment: 'node',
    include: [
      'test/node-s3/**/*.test.ts',
      'test/node-media/**/*.test.ts',
      ...(integration ? ['test/node-media-replay.integration.test.ts'] : []),
    ],
    ...(integration ? { globalSetup: ['@product-res/db/test/global-setup'] } : {}),
    hookTimeout: 120_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
