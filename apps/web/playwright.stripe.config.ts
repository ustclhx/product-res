import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'
import { liveTarget, stagingUrl } from './e2e-live/live-env.ts'

// 真实 Stripe 测试模式的端到端验收（openspec add-billing-and-credits tasks.md 10.1，staging 场景复用于 11.1）。
// 与离线 suite（playwright.config.ts）分开，两种目标：
// - 本地（默认）：只允许在 Orca worktree 的隔离库中运行；保留根目录 .env.local 中的测试支付凭据，
//   启动本 worktree 的 web，并由 globalSetup 启动 `stripe listen` 把测试回调转发到本地。
//   pnpm --filter @product-res/web exec playwright test -c playwright.stripe.config.ts
// - staging：设置 STAGING_URL（与只读核对用的 STAGING_READONLY_DATABASE_URL）；不起本地服务，
//   回调由 Stripe 直接投递到 staging 登记的 webhook 地址。
//   STAGING_URL=https://web-staging.product-res-jobs.workers.dev pnpm --filter @product-res/web exec playwright test -c playwright.stripe.config.ts
const repoRoot = new URL('../../', import.meta.url).pathname
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const webPort = Number(worktreeEnv.WEB_PORT ?? 3000)
const authLogPath = process.env.E2E_AUTH_LOG ?? '/tmp/p2-stripe-live-auth.log'
const local = liveTarget === 'local'

export default defineConfig({
  testDir: './e2e-live',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // 托管结账页与真实回调都有网络往返
  timeout: 180_000,
  ...(local && { globalSetup: './e2e-live/stripe-listen.ts' }),
  use: {
    baseURL: stagingUrl ?? `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(local && {
    webServer: [
      {
        command: `pnpm dev > '${authLogPath.replaceAll("'", "'\\''")}' 2>&1`,
        url: `http://localhost:${webPort}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
    ],
  }),
})
