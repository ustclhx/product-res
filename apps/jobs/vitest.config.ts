import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@product-res/db/test/postgres-socket-rejection'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

// 集成测试连接的本地库：环境变量 → .env.worktree → 主 checkout 的 product_res_dev。
// CI 中未显式提供连接串时跳过集成测试（与 @product-res/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const fallback = (url: string) => (process.env.CI ? undefined : url)
const appUrl =
  readLocalEnv(HYPERDRIVE_ENV) ?? fallback('postgres://app:app@localhost:5432/product_res_dev')
const migratorUrl =
  readLocalEnv('MIGRATION_DATABASE_URL') ??
  fallback('postgres://migrator:migrator@localhost:5432/product_res_dev')

const integration = appUrl && migratorUrl
if (integration) {
  // 两个 Hyperdrive 绑定在本地都直连同一个库
  process.env[HYPERDRIVE_ENV] = appUrl
  process.env[`${HYPERDRIVE_ENV}_CACHED`] = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
} else {
  console.warn(`[@product-res/jobs] 未配置 ${HYPERDRIVE_ENV}，跳过集成测试`)
}

export default defineConfig({
  test: {
    // postgres.js 在 workerd 中连接失败 / 断开时内部未处理的 rejection，见该函数注释
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      { test: { name: 'unit', include: ['test/**/*.unit.test.ts'] } },
      ...(integration
        ? [
            {
              plugins: [
                cloudflareTest({
                  // 所有推理由测试注入假绑定，禁止 AI 绑定建立远程连接。
                  remoteBindings: false,
                  // 直接使用部署配置（Workflow、Queue consumer、Cron、Hyperdrive）；
                  // compatibility_date 受限于 vitest-plugin 自带的 workerd 版本
                  wrangler: { configPath: './wrangler.jsonc' },
                  miniflare: {
                    compatibilityDate: '2026-08-01',
                    // 跨绑定 smoke 测试 mock 所有外部步骤，只需通过 Provider 的配置校验。
                    bindings: { FAL_KEY: 'workflow-fixture-only' },
                    // audit_log 对 app 只追加（@product-res/db 迁移 0009），清理审计行改用 migrator
                    hyperdrives: { HYPERDRIVE_MIGRATOR: migratorUrl },
                  },
                }),
              ],
              test: {
                name: 'integration',
                include: ['test/**/*.test.ts'],
                exclude: ['test/**/*.unit.test.ts', 'test/node-*.integration.test.ts'],
                globalSetup: ['@product-res/db/test/global-setup'],
              },
            },
          ]
        : []),
    ],
    passWithNoTests: true,
  },
})
