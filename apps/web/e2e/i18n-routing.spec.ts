import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'

// 语言路由（openspec add-marketing-i18n-seo tasks.md 1.1）：默认语言无前缀、其他配置语言加前缀、
// 未配置的前缀 404；应用区不加语言前缀。
const { defaultLocale } = templateConfig.i18n
const locales: readonly string[] = templateConfig.i18n.locales
const otherLocales = locales.filter((locale) => locale !== defaultLocale)
const unconfigured = ['fr', 'de', 'ja', 'es'].find((locale) => !locales.includes(locale))

test('默认语言使用无前缀地址，带默认语言前缀的地址 307 到无前缀地址', async ({ page, request }) => {
  await page.goto('/pricing')
  await expect(page.locator('html')).toHaveAttribute('lang', defaultLocale)
  await expect(page).toHaveURL(/\/pricing$/)

  for (const [from, to] of [
    [`/${defaultLocale}`, '/'],
    [`/${defaultLocale}/pricing`, '/pricing'],
  ] as const) {
    const response = await request.get(from, {
      maxRedirects: 0,
      headers: { 'Sec-Fetch-Dest': 'document' },
    })
    expect(response.status()).toBe(307)
    expect(new URL(response.headers().location ?? '', 'http://localhost').pathname).toBe(to)
  }
})

for (const locale of otherLocales) {
  test(`其他配置语言 /${locale}/... 以该语言显示`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const home = await page.goto(`/${locale}`)
    expect(home?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)

    const pricing = await page.goto(`/${locale}/pricing`)
    expect(pricing?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // 水合后地址不变（客户端路由同样去掉 / 加回语言前缀）
    await expect(page).toHaveURL(new RegExp(`/${locale}/pricing$`))
    expect(errors).toEqual([])
  })
}

test('未配置的语言前缀返回 404', async ({ request }) => {
  test.skip(!unconfigured)
  for (const path of [`/${unconfigured}`, `/${unconfigured}/pricing`]) {
    expect((await request.get(path)).status(), path).toBe(404)
  }
})

test('应用区不加语言前缀：带前缀访问返回 404', async ({ request }) => {
  for (const locale of locales) {
    for (const path of ['/app', '/account', '/admin', '/api/health']) {
      const response = await request.get(`/${locale}${path}`, { maxRedirects: 0 })
      expect(response.status(), `/${locale}${path}`).toBe(404)
    }
  }
  expect((await request.get('/api/health')).status()).toBe(200)
})
