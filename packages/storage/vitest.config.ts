import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@product-res/db/test/postgres-socket-rejection'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migratorUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const integration = Boolean(appUrl && migratorUrl)
if (appUrl || migratorUrl) {
  if (!appUrl || !migratorUrl) throw new Error('Storage tests require both database URLs')
  const app = new URL(appUrl)
  const migrator = new URL(migratorUrl)
  if (
    app.host !== migrator.host ||
    app.pathname !== migrator.pathname ||
    (!app.pathname.startsWith('/product_res_wt_') &&
      !(process.env.CI && app.pathname === '/product_res_ci'))
  )
    throw new Error('Storage tests require matching isolated worktree or CI databases')
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
}

export default defineConfig({
  test: {
    // 与 db/web/jobs 复用已确认的 postgres.js workerd socket 关闭处理。
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      { test: { name: 'unit', include: ['test/**/*.unit.test.ts'] } },
      ...(integration
        ? [
            {
              plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
              test: {
                name: 'integration',
                include: ['test/**/*.integration.test.ts'],
                exclude: ['test/node-media-replay.integration.test.ts'],
                globalSetup: ['@product-res/db/test/global-setup'],
              },
            },
          ]
        : []),
    ],
  },
})
