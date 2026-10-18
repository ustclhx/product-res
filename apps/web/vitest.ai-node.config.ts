import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
if (!appUrl || !migratorUrl) throw new Error('Node AI tests require isolated database URLs')
const app = new URL(appUrl)
const migrator = new URL(migratorUrl)
if (
  app.host !== migrator.host ||
  app.pathname !== migrator.pathname ||
  (!app.pathname.startsWith('/product_res_wt_') &&
    !(process.env.CI && app.pathname === '/product_res_ci'))
)
  throw new Error('Node AI tests require matching isolated worktree or CI databases')
process.env.NODE_AI_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/ai-node/*.node.ts'],
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
