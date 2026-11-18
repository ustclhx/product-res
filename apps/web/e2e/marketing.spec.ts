import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'

test.skip(!templateConfig.marketing.enabled, '模板配置关闭了营销站')

// 营销站（openspec add-marketing-i18n-seo tasks.md 3.1、3.3、3.4、3.5）：首页区块、博客、法律页与文档站，
// 默认语言与其他语言路径都可访问。数据库停止时的访问与草稿的生产构建检查见 PR 说明与 scripts/content.test.ts。
const { defaultLocale } = templateConfig.i18n
const otherLocales = templateConfig.i18n.locales.filter((locale) => locale !== defaultLocale)
const prefixes = ['', ...otherLocales.map((locale) => `/${locale}`)]

for (const prefix of prefixes) {
  const lang = prefix === '' ? defaultLocale : prefix.slice(1)

  test(`首页各区块（${lang}）`, async ({ page }) => {
    const response = await page.goto(prefix || '/')
    expect(response?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', lang)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    for (const id of ['features', 'pricing', 'testimonials', 'faq']) {
      await expect(page.locator(`section#${id}`)).toBeVisible()
    }
    // 页脚的法律页链接带当前语言前缀
    await expect(page.locator(`footer a[href="${prefix}/legal/refund"]`)).toBeVisible()
  })

  test(`首页新区块：三步流程、编号产品矩阵与悬浮 AI 入口（${lang}）`, async ({ page }) => {
    // openspec add-ui-design-system 8.5：背书数值未配置时整个区块不渲染
    await page.goto(prefix || '/')
    const { stats, steps, products, aiEntry } = templateConfig.marketing
    if (stats.items.length === 0) {
      await expect(
        page.locator('section[aria-label]').filter({ has: page.locator('dl') }),
      ).toHaveCount(0)
    }
    await expect(page.locator('section#steps ol > li')).toHaveCount(steps.length)
    const cards = page.locator('section#products ol > li')
    await expect(cards).toHaveCount(products.length)
    for (const [index, card] of (await cards.all()).entries()) {
      await expect(card).toContainText(String(index + 1).padStart(2, '0'))
      await expect(card.locator('a')).toHaveCount(2)
    }

    const entry = page.locator('a.fixed[aria-label]')
    if (!aiEntry.enabled || !templateConfig.ai.text.enabled) {
      await expect(entry).toHaveCount(0)
      return
    }
    await expect(entry).toHaveAttribute('href', aiEntry.href)
    // 水合后键盘可聚焦（开发服务器首次编译较慢，放宽等待）
    await expect(
      page.locator('[data-theme-option="system"]').filter({ visible: true }),
    ).toBeEnabled({ timeout: 30_000 })
    await entry.focus()
    await expect(entry).toBeFocused()
    // 滚到页面底部：页脚链接位于入口与浮动主题切换之上，仍可点击
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      // 整个页脚内容盒（不含底部留白）都在入口上方
      const gap = await page.evaluate(() => {
        const footer = document.querySelector('footer')
        const entryEl = document.querySelector('a.fixed[aria-label]')
        if (!footer || !entryEl) return null
        const contentBottom =
          footer.getBoundingClientRect().bottom -
          Number.parseFloat(getComputedStyle(footer).paddingBottom)
        return entryEl.getBoundingClientRect().top - contentBottom
      })
      expect(gap, `width ${width}`).not.toBeNull()
      expect(gap ?? -1, `width ${width}`).toBeGreaterThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
    }
  })

  test(`博客列表、文章与标签（${lang}）`, async ({ page }) => {
    await page.goto(`${prefix}/blog`)
    await expect(page.locator('html')).toHaveAttribute('lang', lang)
    const post = page.locator(`a[href="${prefix}/blog/welcome"]`).first()
    await expect(post).toBeVisible()
    // 定时发布的文章到期前不出现在列表
    await expect(page.locator(`a[href="${prefix}/blog/scheduled-example"]`)).toHaveCount(0)
    await post.click()
    await expect(page).toHaveURL(new RegExp(`${prefix}/blog/welcome$`))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.goto(`${prefix}/blog/tags/guide`)
    await expect(page.locator(`a[href="${prefix}/blog/welcome"]`).first()).toBeVisible()
    expect((await page.goto(`${prefix}/blog/scheduled-example`))?.status()).toBe(404)
  })

  test(`法律页（${lang}）`, async ({ page }) => {
    for (const slug of ['privacy', 'terms', 'refund']) {
      const response = await page.goto(`${prefix}/legal/${slug}`)
      expect(response?.status(), slug).toBe(200)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
    // 退款政策说明默认不退款与申请途径（tasks.md 3.5）
    const article = page.locator('article')
    await expect(article).toContainText(lang === 'zh' ? '默认不退款' : 'not refunded by default')
    await expect(article).toContainText(lang === 'zh' ? '申请退款' : 'Request refund')
    // 模板占位邮箱不公开展示，配置真实地址后才显示。
    if (/@example\./.test(templateConfig.app.supportEmail)) {
      await expect(article).not.toContainText(templateConfig.app.supportEmail)
      await expect(article).toContainText(lang === 'zh' ? '尚未配置支持邮箱' : 'not configured')
    } else await expect(article).toContainText(templateConfig.app.supportEmail)
  })

  test(`文档站按 features.docs 开关（${lang}，当前 ${templateConfig.features.docs}）`, async ({
    page,
  }) => {
    for (const path of ['/docs', '/docs/getting-started']) {
      const response = await page.goto(`${prefix}${path}`)
      expect(response?.status(), path).toBe(templateConfig.features.docs ? 200 : 404)
    }
    if (!templateConfig.features.docs) {
      await page.goto(prefix || '/')
      await expect(page.locator(`a[href="${prefix}/docs"]`)).toHaveCount(0)
      return
    }
    await page.goto(`${prefix}/docs`)
    // 搜索在客户端执行：等水合完成（主题切换按钮在水合后才可用）再输入
    await expect(
      page.locator('[data-theme-option="system"]').filter({ visible: true }),
    ).toBeEnabled()
    await page.getByRole('searchbox').fill('template.config')
    await expect(page.locator(`search a[href="${prefix}/docs/configuration"]`)).toBeVisible()
  })
}
