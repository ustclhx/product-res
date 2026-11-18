import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test.skip(!templateConfig.marketing.enabled, '模板配置关闭了本用例访问的公开营销页面')

test('默认公开页面 head 不加载 PostHog 或 Cloudflare beacon，保留首屏主题脚本', async ({
  page,
}) => {
  const analyticsRequests: string[] = []
  page.on('request', (request) => {
    if (/posthog|cloudflareinsights/.test(request.url())) analyticsRequests.push(request.url())
  })
  for (const pathname of ['/', '/zh/pricing', '/legal/privacy']) {
    const response = await page.goto(pathname)
    expect(response?.status()).toBe(200)
    await expect(page.locator('head script[src*="posthog"]')).toHaveCount(0)
    await expect(
      page.locator('head script[src*="beacon"], head script[data-cf-beacon]'),
    ).toHaveCount(0)
    expect(await page.locator('head').innerHTML()).not.toMatch(/posthog|beacon\.min\.js/i)
    expect(await page.locator('head').innerHTML()).toContain('prefers-color-scheme')
  }
  expect(analyticsRequests).toEqual([])
})

test('首触 Cookie 只写一次，注册后绑定到用户，账号归因可查', async ({ page, context }) => {
  const sql = fixtureDb()
  const email = `attribution-${randomUUID()}@example.com`
  try {
    await page.goto('/pricing?utm_source=chatgpt&utm_medium=geo&token=secret')
    await expect
      .poll(async () =>
        (await context.cookies()).some((cookie) => cookie.name === 'product_res_ft'),
      )
      .toBe(true)
    const first = (await context.cookies()).find(
      (cookie) => cookie.name === 'product_res_ft',
    )?.value
    expect(first).not.toContain('secret')
    await page.goto('/?utm_source=other')
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'product_res_ft')?.value,
    ).toBe(first)
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [row] = await sql`
      select a.source, a.medium, a.landing_path from user_attribution a
      join "user" u on u.id = a.user_id where u.email = ${email}`
    expect(row).toEqual({ source: 'chatgpt', medium: 'geo', landing_path: '/pricing' })
  } finally {
    await sql.end()
  }
})

test('未配置 Plausible 时公开页没有分析脚本，站点资源可用', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('script[data-domain]')).toHaveCount(0)
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1)
  expect((await request.get('/favicon.ico')).status()).toBe(200)
  const llms = await request.get('/llms.txt')
  expect(llms.status()).toBe(200)
  expect(await llms.text()).toContain('## Pages')
  expect((await request.get('/indexnow.txt')).status()).toBe(404)
})

test('答案页结论置顶并输出 FAQ 结构化数据，进入站点地图', async ({ page, request }) => {
  // 指南页关闭时 /guides 路由 404，答案页不存在。
  test.skip(!templateConfig.features.guides, 'features.guides 已关闭')
  const response = await request.get('/guides/is-it-free')
  expect(response.status()).toBe(200)
  const html = await response.text()
  expect(html).toContain('FAQPage')
  await page.goto('/guides/is-it-free')
  const summary = page.getByTestId('answer-summary')
  await expect(summary).toBeVisible()
  const answerFirst = await page.evaluate(() => {
    const answer = document.querySelector('[data-testid="answer-summary"]')
    const faq = document.querySelector('article h2')
    return Boolean(
      answer && faq && answer.compareDocumentPosition(faq) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
  expect(answerFirst).toBe(true)
  expect(await (await request.get('/sitemap.xml')).text()).toContain('/guides/is-it-free</loc>')
})

test('定价页有站点导航，CTA 未登录经登录页；首页 CTA 到注册；404 有回导航', async ({ page }) => {
  await page.goto('/pricing')
  await expect(page.locator('header nav')).toBeVisible()
  await expect(page.locator('footer')).toBeVisible()
  const cta = page.getByRole('link', { name: /^Subscribe to / }).first()
  if (await cta.count()) {
    await cta.click()
    await expect(page).toHaveURL(/\/login/)
  }
  await page.goto('/')
  const hrefs = await page
    .locator('#pricing a, section a[href$="/register"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  expect(hrefs).toContain('/register')
  const missing = await page.goto('/no-such-page')
  expect(missing?.status()).toBe(404)
  await expect(page.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/')
})
