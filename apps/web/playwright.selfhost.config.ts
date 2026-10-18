import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.SELFHOST_BASE_URL ?? 'https://selfhost-final.local'
const hostname = new URL(baseURL).hostname

export default defineConfig({
  testDir: './e2e/selfhost',
  // 独立命名避免普通 Cloudflare/dev suite 自动发现 Compose 验收。
  testMatch: '**/*.selfhost.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL,
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    // 验证链接和会话不能落入 trace/video；CA 信任由 Compose 验收的 curl 单独验证。
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'selfhost-chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'],
        },
      },
    },
  ],
})
