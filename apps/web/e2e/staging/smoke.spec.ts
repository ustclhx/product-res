import { randomUUID } from 'node:crypto'
import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * 认证页 fieldset 在 hydration 前保持 disabled。发布刚生效时曾两次出现 30 秒内未 hydration
 * （2026-10-14/15 的 staging 发布），且没有 trace 可查；导航前开始记录页面错误与失败的同源请求，
 * 首次超时打 warning 后刷新重试一次。真实 hydration 缺陷刷新后仍会失败，不会被掩盖。
 */
function collectProblems(page: Page): string[] {
  const problems: string[] = []
  const origin = new URL(process.env.STAGING_URL ?? 'http://localhost').origin
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(origin))
      problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })
  page.on('response', (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400)
      problems.push(`response ${response.status()}: ${response.url()}`)
  })
  return problems
}

async function waitHydrated(page: Page, field: Locator, problems: string[]) {
  for (const attempt of [1, 2]) {
    try {
      await expect(field).toBeEnabled({ timeout: 15_000 })
      return
    } catch (error) {
      const detail = problems.join('\n') || '(no page errors or failed same-origin requests)'
      if (attempt === 2)
        throw new Error(`Register page never hydrated:\n${detail}`, { cause: error })
      // GitHub Actions 注解：重试通过时仍能在 run 摘要中看到这次未 hydration
      console.log(
        `::warning::Register page not hydrated after 15s, reloading once:%0A${detail.replaceAll('\n', '%0A')}`,
      )
      problems.length = 0
      await page.reload()
    }
  }
}

test('首页渲染', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.locator('section#features')).toBeVisible()
})

test('定价页渲染', async ({ page }) => {
  const response = await page.goto('/pricing')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible()
})

test('随机邮箱注册后进入个人空间', async ({ page }) => {
  // hydration 重试 + 注册跳转 + 注销各自有独立等待，默认 30 秒总时长不够
  test.setTimeout(120_000)
  const sha = (process.env.APP_VERSION ?? process.env.GITHUB_SHA ?? 'local').slice(0, 12)
  const email = `smoke+${sha}-${randomUUID()}@example.com`
  // staging 使用真实 Turnstile 脚本和官方测试 key；不依赖本地桩、日志或邮件。
  const problems = collectProblems(page)
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  await waitHydrated(page, form.getByLabel('Name'), problems)
  await form.getByLabel('Name').fill('Staging Smoke User')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill('staging-smoke-password')
  await form.getByRole('button', { name: 'Create account' }).click()
  // 发布后首个注册请求含冷启动与连接建立，注册→建个人空间→跳转可能超过默认 5 秒。
  await expect(page).toHaveURL(/\/app\/u-[a-z0-9]+\/?$/, { timeout: 20_000 })
  await expect(page.getByTestId('current-user')).toContainText(email)
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()

  // 每次发布都会注册一个用户；走真实的注销流程删除，避免 staging 库中冒烟账号累积
  await page.goto('/account')
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete account' }).click()
  // 注销经多次跨区数据库往返，刚发布后可能超过默认 5 秒；失败时带出页面提示便于定位
  const alert = page.getByRole('alert')
  await Promise.race([
    page.waitForURL(/\/login(\?|$)/, { timeout: 30_000 }).catch(() => {}),
    alert.waitFor({ timeout: 30_000 }).catch(() => {}),
  ])
  if (await alert.isVisible())
    throw new Error(`Account deletion failed: ${await alert.textContent()}`)
  await expect(page).toHaveURL(/\/login(\?|$)/)
})
