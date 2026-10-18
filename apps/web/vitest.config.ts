import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@product-res/db/test/postgres-socket-rejection'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'

// 集成测试连接的本地库：环境变量 → .env.worktree → 主 checkout 的 product_res_dev。
// CI 中未显式提供连接串时跳过集成测试，只跑单元测试（与 @product-res/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const fallback = (url: string) => (process.env.CI ? undefined : url)
const appUrl =
  readLocalEnv(HYPERDRIVE_ENV) ?? fallback('postgres://app:app@localhost:5432/product_res_dev')
const migratorUrl =
  readLocalEnv('MIGRATION_DATABASE_URL') ??
  fallback('postgres://migrator:migrator@localhost:5432/product_res_dev')

const integration = appUrl && migratorUrl
if (integration) {
  process.env[HYPERDRIVE_ENV] = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
} else {
  console.warn(`[@product-res/web] 未配置 ${HYPERDRIVE_ENV}，跳过集成测试`)
}

export default defineConfig({
  test: {
    // postgres.js 在 workerd 中连接失败 / 断开时内部未处理的 rejection，见该函数注释
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      {
        // 单元测试会引用 Paraglide 编译产物（src/paraglide），与 vite dev / build 一样先编译
        plugins: [i18nMessages({ i18n: templateConfig.i18n, appAreaPrefixes: APP_AREA_PREFIXES })],
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      ...(integration
        ? [
            {
              plugins: [
                cloudflareTest(({ inject }) => ({
                  wrangler: { configPath: './test/wrangler.jsonc' },
                  miniflare: {
                    hyperdrives: {
                      HYPERDRIVE_HANGING: `postgres://app:app@127.0.0.1:${inject('hangingDbPort')}/db`,
                      HYPERDRIVE_REFUSED: `postgres://app:app@127.0.0.1:${inject('refusedDbPort')}/db`,
                      // audit_log 对 app 只追加（@product-res/db 迁移 0009），清理审计行改用 migrator
                      HYPERDRIVE_MIGRATOR: migratorUrl,
                    },
                  },
                })),
              ],
              test: {
                name: 'integration',
                // 多个测试会改写全局运行时设置（如 auth.signupEnabled 关闭注册），与并行运行的
                // 注册类测试共享同一个隔离库会偶发 403；与 @product-res/billing 的 postgres 项目一样串行执行。
                fileParallelism: false,
                include: ['test/**/*.test.ts'],
                globalSetup: ['./test/global-setup.ts'],
              },
            },
          ]
        : []),
    ],
  },
})
