import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'
import { paymentKeys } from '../../scripts/local-payment-env.mjs'

// 认证页面的 e2e（tasks.md 7.2）：在本地 `vite dev`（web）上运行；默认注册无需邮件消费者，
// 端口取自 Orca worktree 的 .env.worktree（docs/09-parallel-plan.md §2），不存在时用默认端口。
// 离线 suite 使用独立 dev 子进程并清空支付绑定，避免读取根 dotenv 真值或复用旧 Worker。
// 测试结束后只停止 Playwright 自己启动的进程。
const repoRoot = new URL('../../', import.meta.url).pathname
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const webPort = Number(worktreeEnv.WEB_PORT ?? 3000)
const authLogPath = process.env.E2E_AUTH_LOG ?? '/tmp/p1-phase-e2e-auth.log'
const quotedAuthLogPath = `'${authLogPath.replaceAll("'", "'\\''")}'`
const stagingURL = process.env.STAGING_URL
// 生产只读冒烟（add-cloud-production-neon 3.2）：只访问页面与健康接口，不注册、不支付、不写库
const productionURL = process.env.PRODUCTION_URL
const remoteURL = stagingURL || productionURL

export default defineConfig({
  testDir: './e2e',
  testIgnore: [
    /\/e2e\/staging-acceptance\//,
    // 只忽略 CI 本地冒烟（由 playwright.smoke.config.ts 运行），不能误伤 e2e/staging/smoke.spec.ts。
    /\/e2e\/smoke\.spec\.ts$/,
    ...(!stagingURL ? ['**/staging/**', '**/ai-chat-disconnect.spec.ts'] : []),
    ...(!productionURL ? ['**/production/**'] : []),
  ],
  // 认证入口按 IP 限流（RL_AUTH 每分钟 10 次），串行执行避免并发请求触发 429
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: remoteURL || `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: stagingURL
    ? [
        {
          name: 'staging',
          testDir: './e2e/staging',
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : productionURL
      ? [
          {
            name: 'production',
            testDir: './e2e/production',
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(!remoteURL && {
    webServer: [
      {
        command: `pnpm dev > ${quotedAuthLogPath} 2>&1`,
        url: `http://localhost:${webPort}/api/health`,
        reuseExistingServer: false,
        env: Object.fromEntries(paymentKeys.map((key) => [key, ''])),
        timeout: 120_000,
      },
    ],
  }),
})
