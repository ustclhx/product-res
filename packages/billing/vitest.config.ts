import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const integration = Boolean(appUrl && migrationUrl)
if (appUrl || migrationUrl) {
  if (!appUrl || !migrationUrl) throw new Error('Billing tests require both database URLs')
  const app = new URL(appUrl)
  const migration = new URL(migrationUrl)
  if (
    app.host !== migration.host ||
    app.pathname !== migration.pathname ||
    !(
      app.pathname.startsWith('/product_res_wt_') ||
      (process.env.CI && app.pathname === '/product_res_ci')
    )
  ) {
    throw new Error('Billing tests require matching isolated worktree or CI databases')
  }
  process.env.BILLING_TEST_DATABASE_URL = appUrl
  process.env.MIGRATION_DATABASE_URL = migrationUrl
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'offline',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/pipeline.test.ts', 'src/**/*.postgres.test.ts'],
        },
      },
      ...(integration
        ? [
            {
              test: {
                name: 'postgres',
                // Maintenance jobs scan all workspaces; serialize fixtures in the shared isolated database.
                fileParallelism: false,
                environment: 'node',
                include: ['src/pipeline.test.ts', 'src/**/*.postgres.test.ts'],
                globalSetup: ['@product-res/db/test/global-setup'],
              },
            },
          ]
        : []),
    ],
  },
})
