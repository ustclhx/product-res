import { expect, test } from '@playwright/test'

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
