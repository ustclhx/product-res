import { fileURLToPath } from 'node:url'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
if (!appUrl || !migratorUrl) throw new Error('Media tests require isolated worktree database')
const app = new URL(appUrl)
const migrator = new URL(migratorUrl)
if (
  app.host !== migrator.host ||
  app.pathname !== migrator.pathname ||
  !app.pathname.startsWith('/product_res_wt_')
)
  throw new Error('Media tests require matching isolated worktree database')
process.env.TEST_JOB_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./fixtures/media-node-env.ts', import.meta.url)),
      '@product-res/storage/cloudflare': fileURLToPath(
        new URL('./fixtures/media-node-storage.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'test/media-workflow.test.ts',
      'test/media-settlement.test.ts',
      'test/media-hold-sweep.test.ts',
    ],
    fileParallelism: false,
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
