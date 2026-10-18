import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { readLocalEnv } from './worktree-env.ts'

// 集成测试连接的本地库：环境变量 → .env.worktree → 主 checkout 的 product_res_dev。
// CI 中没有本地 Postgres 时（未显式提供连接串）跳过集成测试，只跑单元测试。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const fallback = (url: string) => (process.env.CI ? undefined : url)
const appUrl =
  readLocalEnv(HYPERDRIVE_ENV) ?? fallback('postgres://app:app@localhost:5432/product_res_dev')
const migratorUrl =
  readLocalEnv('MIGRATION_DATABASE_URL') ??
  fallback('postgres://migrator:migrator@localhost:5432/product_res_dev')

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
          include: ['src/**/*.test.ts', 'lint/**/*.test.ts'],
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
