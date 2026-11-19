import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@product-res/db/test/postgres-socket-rejection'
import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

// 未配置数据库时只跑单元测试；配置了则必须是同一个隔离库（@product-res/db/test-database）。
const database = resolveTestDatabase('@product-res/storage')
const integration = Boolean(database)
if (database) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = database.appUrl
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
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
