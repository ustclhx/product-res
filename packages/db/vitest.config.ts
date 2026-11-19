import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { resolveTestDatabase } from './test-database.ts'

// 测试库按环境变量、.env.worktree、本地 <项目>_test 的顺序解析。
// ALLOW_TEST_ON_DEV_DATABASE=1 时允许使用开发库。
// CI 中没有本地 Postgres 时（未显式提供连接串）跳过集成测试，只跑单元测试。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const database = resolveTestDatabase('@product-res/db', { devFallback: true })
const appUrl = database?.appUrl
const migratorUrl = database?.migratorUrl

const integration = appUrl && migratorUrl
if (integration) {
  // wrangler 读取该变量作为 HYPERDRIVE 绑定的 localConnectionString
  process.env[HYPERDRIVE_ENV] = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
} else {
  console.warn(`[@product-res/db] 未配置 ${HYPERDRIVE_ENV}，跳过集成测试`)
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'lint/**/*.test.ts', '*.test.ts'],
          environment: 'node',
        },
      },
      ...(integration
        ? [
            {
              plugins: [
                cloudflareTest({
                  wrangler: { configPath: './test/wrangler.jsonc' },
                  // audit_log 对 app 只追加（迁移 0009），清理审计行改用 migrator
                  miniflare: { hyperdrives: { HYPERDRIVE_MIGRATOR: migratorUrl } },
                }),
              ],
              test: {
                name: 'integration',
                include: ['test/**/*.test.ts'],
                exclude: ['test/node/**'],
                globalSetup: ['./test/global-setup.ts'],
              },
            },
          ]
        : []),
    ],
  },
})
