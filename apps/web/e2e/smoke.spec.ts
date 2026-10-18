import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { APP_URL, login, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

const NAV = ['工作台', '跟卖选品', '品牌选品', '选品档案库', '算法验证', '数据中心', '设置']

test('register, see the workbench navigation, sign out and back in', async ({
  page,
  context,
  baseURL,
}) => {
  const externalRequests: string[] = []
  // 后注册的 route 先执行：stubTurnstile 处理测试脚本，其余外部请求立即阻止（含字体服务）。
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(baseURL ?? '').origin) return route.continue()
    externalRequests.push(url.origin)
    await route.abort()
  })
  await stubTurnstile(page)
  await simulateClientIp(page)
  const email = `ci-smoke-${randomUUID()}@example.com`
  await register(page, email)
  await expect(page.getByTestId('current-user')).toContainText(email)

  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('link')).toHaveText(NAV)
  await expect(nav.getByRole('link', { name: '工作台' })).toHaveAttribute('aria-current', 'page')
  // 不出现评审、定价、订阅、充值入口
  await expect(
    page.getByRole('link', { name: /评审|定价|订阅|充值|账单|Billing|Pricing/ }),
  ).toHaveCount(0)

  await nav.getByRole('link', { name: '数据中心' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '数据中心' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '数据中心' })).toHaveAttribute('aria-current', 'page')
  const workspaceURL = page.url()

  const signedOut = await context.request.post('/api/auth/sign-out', {
    headers: { origin: baseURL ?? '' },
    data: {},
  })
  expect(signedOut.ok()).toBe(true)
  await page.goto(workspaceURL)
  await expect(page).toHaveURL(/\/login/)
  await login(page, email)
  await expect(page).toHaveURL(APP_URL)
  await expect(page.getByTestId('current-user')).toContainText(email)
  expect(externalRequests).toEqual([])
})
