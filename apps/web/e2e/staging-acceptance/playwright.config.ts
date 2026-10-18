import { defineConfig, devices } from '@playwright/test'

// 只读取进程环境；不隐式加载其他 checkout 的 dotenv，也不自动启动 staging 服务。
const target = process.env.STAGING_URL
// Playwright 的默认失败快照包含登录页输入与身份信息，独立验收关闭该快照及保留目录。
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'
if (target) {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('STAGING_URL must be a valid HTTP origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('STAGING_URL must be an HTTP origin without credentials or query')
  if (
    process.env.STAGING_ACCEPTANCE_LOCAL === '1' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Local acceptance only supports loopback targets')
}
export default defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  preserveOutput: 'never',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: './reporter.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: target,
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'acceptance', testMatch: 'acceptance.spec.ts' }],
})
