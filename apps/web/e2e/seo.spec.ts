import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'

const { locales, defaultLocale } = templateConfig.i18n
const publicPaths = ['/', '/pricing', '/legal/privacy', '/legal/terms', '/legal/refund']
if (templateConfig.features.blog)
  publicPaths.push(
    '/blog',
    '/blog/welcome',
    '/blog/writing-posts',
    '/blog/tags/guide',
    '/blog/tags/announcement',
  )
if (templateConfig.features.docs)
  publicPaths.push('/docs', '/docs/getting-started', '/docs/content', '/docs/configuration')
if (templateConfig.features.waitlist) publicPaths.push('/waitlist')
if (templateConfig.features.newsletter) publicPaths.push('/newsletter')

for (const locale of locales) {
  test(`公开路由 head 与唯一 canonical（${locale}）`, async ({ page }) => {
    const titles = new Set<string>()
    const canonicals = new Set<string>()
    for (const path of publicPaths) {
      const prefix = locale === defaultLocale ? '' : `/${locale}`
      const response = await page.goto(`${prefix}${path === '/' ? '' : path}` || '/')
      expect(response?.status(), path).toBe(200)
      const title = await page.title()
      expect(title, path).toContain(templateConfig.app.name)
      expect(titles.has(title), path).toBe(false)
      titles.add(title)
      const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
      expect(canonical, path).toBeTruthy()
      expect(canonicals.has(canonical ?? ''), path).toBe(false)
      canonicals.add(canonical ?? '')
      expect(new URL(canonical ?? '').pathname).toBe(`${prefix}${path === '/' ? '' : path}` || '/')
      for (const name of ['description', 'twitter:card', 'twitter:image'])
        await expect(page.locator(`meta[name="${name}"]`)).toHaveAttribute('content', /\S/)
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        'content',
        canonical ?? '',
      )
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        'content',
        /^https?:\/\//,
      )
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1)
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0)
    }
    // 客户端导航也必须更换 canonical 与标题。
    await page.goto(locale === defaultLocale ? '/' : `/${locale}`)
    await page
      .locator(`header a[href="${locale === defaultLocale ? '' : `/${locale}`}/pricing"]`)
      .click()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/pricing$/)
  })
}

test('地图发布过滤、robots 与 构建期 PNG 输出', async ({ request }) => {
  const response = await request.get('/sitemap.xml')
  expect(response.status()).toBe(200)
  const xml = await response.text()
  for (const locale of locales) {
    const prefix = locale === defaultLocale ? '' : `/${locale}`
    if (templateConfig.features.blog) expect(xml).toContain(`${prefix}/blog/welcome</loc>`)
  }
  for (const path of ['/app', '/admin', '/api', 'draft-example', 'scheduled-example'])
    expect(xml).not.toContain(path)
  const rules = await (await request.get('/robots.txt')).text()
  for (const path of ['/app', '/admin', '/api']) expect(rules).toContain(`Disallow: ${path}`)
  for (const path of ['/legal/terms', '/zh/legal/terms']) {
    const image = await request.get(
      `/og/${path.startsWith('/zh/') ? 'zh' : 'en'}${path.replace(/^\/zh/, '')}.png`,
    )
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toBe('image/png')
    const data = await image.body()
    expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(data.readUInt32BE(16)).toBe(1200)
    expect(data.readUInt32BE(20)).toBe(630)
  }
  expect((await request.get('/og/en/blog/draft-example.png')).status()).toBe(404)
})
