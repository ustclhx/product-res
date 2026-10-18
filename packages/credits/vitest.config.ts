import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const integration = Boolean(appUrl && migrationUrl)
if (appUrl || migrationUrl) {
  if (!appUrl || !migrationUrl) throw new Error('Credits tests require both database URLs')
  const app = new URL(appUrl)
  const migrator = new URL(migrationUrl)
  const isolated = app.pathname.startsWith('/product_res_wt_')
  const ci = Boolean(process.env.CI) && app.pathname === '/product_res_ci'
  if (app.host !== migrator.host || app.pathname !== migrator.pathname || (!isolated && !ci)) {
    throw new Error('Credits tests require matching isolated worktree or CI databases')
  }
  process.env.CREDITS_TEST_DATABASE_URL = appUrl
  process.env.MIGRATION_DATABASE_URL = migrationUrl
}

export default defineConfig({
  test: {
    environment: 'node',
    include: integration ? ['test/**/*.test.ts'] : [],
    passWithNoTests: !integration,
    globalSetup: integration ? ['@product-res/db/test/global-setup'] : [],
  },
})
