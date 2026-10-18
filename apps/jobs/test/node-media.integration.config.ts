import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const app = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migrator = readLocalEnv('MIGRATION_DATABASE_URL')
if (!app || !migrator) throw new Error('Node media integration requires worktree PG configuration')
const appUrl = new URL(app)
const migrationUrl = new URL(migrator)
if (
  !appUrl.pathname.startsWith('/product_res_wt_') ||
  appUrl.pathname !== migrationUrl.pathname ||
  appUrl.host !== migrationUrl.host ||
  appUrl.username !== 'app' ||
  migrationUrl.username !== 'migrator'
)
  throw new Error('Node media integration requires app/migrator on the same isolated worktree PG')
process.env.TEST_JOB_DATABASE_URL = app
process.env.MIGRATION_DATABASE_URL = migrator
process.env.TEST_JOB_MIGRATOR_URL = migrator

export default defineConfig({
  test: {
    include: ['test/node-media.integration.test.ts'],
    fileParallelism: false,
    globalSetup: ['test/node-jobs-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
