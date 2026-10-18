import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { robots, sitemap } from './crawlers.ts'
import { localizedPath, pageHead, privateMeta } from './metadata.ts'
import { OgCard } from './og-card.ts'
import { publicPages } from './pages.ts'
import { articleData, organizationData, pricingData, websiteData } from './structured-data.ts'

const origin = 'https://seo.example'
const content = {
  posts: [
    {
      slug: 'published',
      locale: 'en',
      title: 'Published article',
      summary: 'A published summary',
      date: '2026-01-01',
      tags: ['guide'],
      draft: false,
    },
    {
      slug: 'published',
      locale: 'zh',
      title: '已发布文章',
      summary: '已发布摘要',
      date: '2026-01-01',
      tags: ['guide'],
      draft: false,
    },
    {
      slug: 'draft',
      locale: 'en',
      title: 'Draft',
      summary: 'Draft',
      date: '2026-01-01',
      tags: ['secret'],
      draft: true,
    },
    {
      slug: 'future',
      locale: 'en',
      title: 'Future',
      summary: 'Future',
      date: '2099-01-01',
      tags: ['future'],
      draft: false,
    },
  ],
  legal: [
    { slug: 'terms', locale: 'en', title: 'Terms', description: 'Terms of service' },
    { slug: 'terms', locale: 'zh', title: '服务条款', description: '服务使用条款' },
  ],
  docs: [
    { slug: 'guide', locale: 'en', title: 'Getting started', description: 'Setup guide' },
    { slug: 'guide', locale: 'zh', title: '入门指南', description: '配置说明' },
  ],
}
const config = {
  ...templateConfig,
  marketing: { ...templateConfig.marketing, enabled: true },
  features: {
    ...templateConfig.features,
    blog: true,
    docs: true,
    newsletter: true,
    waitlist: true,
  },
}
const pages = publicPages(content, new Date('2026-10-01'), config)
const locales = config.i18n.enabled ? config.i18n.locales : [config.i18n.defaultLocale]
const locale = locales.includes('en') ? 'en' : config.i18n.defaultLocale

describe('公开页面 SEO（4.1–4.3）', () => {
  it('每种语言的所有公开页面具有唯一标题、描述、canonical 和分享元数据', () => {
    const canonicals = new Set<string>()
    for (const locale of locales) {
      const titles = new Set<string>()
      for (const page of pages.filter((page) => page.locale === locale)) {
        const head = pageHead(page, origin)
        const title = head.meta.find((meta) => 'title' in meta)?.title
        const canonical = head.links.find((link) => link.rel === 'canonical')?.href
        expect(title).toBeTruthy()
        expect(titles.has(title ?? '')).toBe(false)
        expect(canonicals.has(canonical ?? '')).toBe(false)
        titles.add(title ?? '')
        canonicals.add(canonical ?? '')
        expect(canonical).toBe(`${origin}${localizedPath(page.path, locale)}`)
        for (const key of [
          'description',
          'twitter:card',
          'twitter:title',
          'twitter:description',
          'twitter:image',
        ]) {
          expect(
            head.meta.find((meta) => 'name' in meta && meta.name === key)?.content,
          ).toBeTruthy()
        }
        for (const key of ['og:title', 'og:description', 'og:url', 'og:image']) {
          expect(
            head.meta.find((meta) => 'property' in meta && meta.property === key)?.content,
          ).toBeTruthy()
        }
        expect(head.links.filter((link) => link.rel === 'alternate')).toHaveLength(
          locales.length + 1,
        )
        expect(head.links).toContainEqual({
          rel: 'alternate',
          hrefLang: 'x-default',
          href: `${origin}${page.path}`,
        })
      }
    }
  })

  it('私有路径禁止索引，公开页面保持可索引', () => {
    for (const path of ['/app', '/app/me/chat', '/account', '/admin', '/api/health']) {
      expect(privateMeta(path)).toContainEqual({ name: 'robots', content: 'noindex, nofollow' })
    }
    for (const path of ['/', '/pricing', '/blog/published', '/legal/terms', '/docs/guide'])
      expect(privateMeta(path)).toEqual([])
  })

  it('地图包含已发布文章的全部语言，排除草稿、未来文章与关闭的功能', () => {
    const xml = sitemap(pages, origin)
    for (const locale of locales) {
      const prefix =
        !config.i18n.enabled || locale === config.i18n.defaultLocale ? '' : `/${locale}`
      expect(xml).toContain(`<loc>${origin}${prefix}/blog/published</loc>`)
    }
    for (const path of [
      '/app',
      '/admin',
      '/account',
      '/api',
      '/blog/draft',
      '/blog/future',
      '/blog/tags/secret',
    ])
      expect(xml).not.toContain(path)
    const disabled = publicPages(content, new Date('2026-10-01'), {
      ...config,
      features: {
        ...templateConfig.features,
        docs: false,
        blog: false,
        newsletter: false,
        waitlist: false,
      },
    })
    for (const prefix of ['/docs', '/blog', '/newsletter', '/waitlist'])
      expect(sitemap(disabled, origin)).not.toContain(prefix)
    expect(robots(origin)).toContain(`Sitemap: ${origin}/sitemap.xml`)
    for (const path of ['/app', '/admin', '/api'])
      expect(robots(origin)).toContain(`Disallow: ${path}`)
  })

  it('三类页面 JSON-LD 为合法 JSON 且具备类型所需字段，价格来自套餐目录', () => {
    const home = pages.find((page) => page.path === '/' && page.locale === locale)
    if (!home) throw new Error('Missing homepage')
    const article = pages.find((page) => page.path === '/blog/published' && page.locale === locale)
    if (!article) throw new Error('Missing article')
    const catalog = {
      plans: [
        {
          id: 'plan-1',
          key: 'pro',
          name: 'Pro',
          credits: 500,
          type: 'subscription' as const,
          creditExpiryDays: null,
          features: {
            models: [],
            maxConcurrentTasks: 1,
            maxSeats: 1,
            storageGb: 1,
            publicApi: false,
            priorityQueue: false,
            watermark: false,
          },
        },
      ],
      prices: [
        {
          id: 'price-1',
          planId: 'plan-1',
          provider: 'stripe' as const,
          interval: 'month' as const,
          amount: 2345,
          currency: 'usd',
          active: true,
          available: true,
        },
      ],
      providers: [],
    }
    const products = pricingData(catalog, origin, locale)
    const data = [
      organizationData(origin),
      websiteData(origin),
      articleData(article, origin),
      ...products,
    ]
    const head = pageHead(home, origin, data)
    const fields: Record<string, string[]> = {
      Organization: ['name', 'url'],
      WebSite: ['name', 'url'],
      BlogPosting: ['headline', 'datePublished', 'author', 'image', 'mainEntityOfPage'],
      Product: ['name', 'image', 'offers'],
    }
    for (const script of head.scripts) {
      const schema = JSON.parse(script.children)
      expect(schema['@context']).toBe('https://schema.org')
      expect(fields[schema['@type']]).toBeDefined()
      for (const field of fields[schema['@type']] ?? []) expect(schema[field], field).toBeTruthy()
    }
    expect(products[0]?.offers[0]).toMatchObject({
      '@type': 'Offer',
      price: '23.45',
      priceCurrency: 'USD',
      url: `${origin}${localizedPath('/pricing', locale)}`,
    })
    expect(articleData(article, origin).author.name).toBe(templateConfig.app.name)
    expect(
      pageHead(home, origin, [{ text: '</script><script>' }]).scripts[0]?.children,
    ).not.toContain('</script>')
  })
})

it('关闭营销时没有公开页面，单语言只生成默认语言页面', () => {
  expect(
    publicPages(content, new Date('2026-10-01'), {
      ...config,
      marketing: { ...config.marketing, enabled: false },
    }),
  ).toEqual([])
  const single = publicPages(content, new Date('2026-10-01'), {
    ...config,
    i18n: { ...config.i18n, enabled: false, defaultLocale: 'zh' },
  })
  expect(new Set(single.map((page) => page.locale))).toEqual(new Set(['zh']))
  expect(single.find((page) => page.path === '/')).toMatchObject({
    locale: 'zh',
    title: 'AI 工作空间',
  })
  expect(single.find((page) => page.path === '/blog/published')?.title).toBe('已发布文章')
  if (!templateConfig.i18n.enabled) {
    for (const locale of ['en', 'zh', 'fr']) {
      expect(localizedPath('/pricing/', locale)).toBe('/pricing')
      expect(localizedPath('/', locale)).toBe('/')
    }
  }
})

describe('分享图与缓存（4.4）', () => {
  it('无封面页面的卡片包含站点名称和页面标题', () => {
    const page = pages.find((page) => page.path === '/legal/terms' && page.locale === locale)
    if (!page) throw new Error('Missing legal page')
    const markup = renderToStaticMarkup(<OgCard title={page.title} />)
    expect(markup).toContain(templateConfig.app.name)
    expect(markup).toContain(page.title)
  })
})
