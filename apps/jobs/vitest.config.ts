import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@product-res/db/test/postgres-socket-rejection'
import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

// 测试库按环境变量、.env.worktree、本地 <项目>_test 的顺序解析。
// ALLOW_TEST_ON_DEV_DATABASE=1 时允许使用开发库。
// CI 中未显式提供连接串时跳过集成测试（与 @product-res/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const database = resolveTestDatabase('@product-res/jobs', { devFallback: true })
const appUrl = database?.appUrl
const migratorUrl = database?.migratorUrl

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
      // src 内的单元测试（如 notifications/analytics.test.ts）此前未被任何 project 收录，一并运行。
      { test: { name: 'unit', include: ['test/**/*.unit.test.ts', 'src/**/*.test.ts'] } },
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
