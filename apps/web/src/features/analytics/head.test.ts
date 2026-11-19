import { themeInitScript } from '@product-res/ui'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../seo/origin.functions.ts', () => ({
  getSafeImpersonation: vi.fn(),
  getSeoOrigin: vi.fn(),
}))
vi.mock('../admin/settings-announcement.functions.ts', () => ({ getAnnouncement: vi.fn() }))
vi.mock('../admin/impersonation-banner.tsx', () => ({ ImpersonationBanner: () => null }))
vi.mock('../admin/settings-announcement-banner.tsx', () => ({ AnnouncementBanner: () => null }))
vi.mock('../i18n/language-controls.tsx', () => ({ LanguageControls: () => null }))

import { baseLocale, cookieName, locales } from '../../paraglide/runtime.js'
import { Route } from '../../routes/__root.tsx'
import { templateConfig } from '../../server/template-config.ts'
import { LOCALE_COOKIE_MAX_AGE, PREFERENCE_COOKIE } from '../i18n/preference.ts'
import { localeSuggestionScript } from '../i18n/suggestion.ts'
import { analyticsHeadScripts } from './head.ts'

const site = { domain: 'acme-staging', scriptUrl: 'https://plausible.example/js/script.manual.js' }

describe('分析脚本页面 head', () => {
  it('Plausible 按环境注入本站 site，应用区加载，后台与接口不加载', () => {
    for (const pathname of ['/', '/zh/pricing', '/app/personal/chat', '/account'])
      expect(analyticsHeadScripts(pathname, templateConfig, site)).toEqual([
        { src: site.scriptUrl, defer: true, 'data-domain': 'acme-staging' },
      ])
    for (const pathname of ['/admin', '/admin/users', '/api/health'])
      expect(analyticsHeadScripts(pathname, templateConfig, site)).toEqual([])
    expect(analyticsHeadScripts('/', templateConfig, null)).toEqual([])
  })

  it('多站时只输出内联映射，不带 data-domain 的脚本，后台与接口同样不输出', () => {
    const multi = { ...site, domain: '', sites: { 'a.example': 'a', 'b.example': 'b</script>' } }
    for (const pathname of ['/', '/app/personal/chat']) {
      const scripts = analyticsHeadScripts(pathname, templateConfig, multi)
      expect(scripts).toEqual([
        { type: 'application/json', id: 'product-res-plausible', children: expect.any(String) },
      ])
      const children = (scripts[0] as { children: string }).children
      expect(children).not.toContain('<')
      expect(JSON.parse(children)).toEqual({
        sites: multi.sites,
        fallback: '',
        scriptUrl: site.scriptUrl,
      })
      expect(JSON.stringify(scripts)).not.toContain('data-domain')
    }
    for (const pathname of ['/admin', '/api/health'])
      expect(analyticsHeadScripts(pathname, templateConfig, multi)).toEqual([])
  })

  it('默认页面 head 无 PostHog 或 beacon，主题与语言建议内联脚本保持原样', async () => {
    const head = Route.options.head
    if (!head) throw new Error('Root head is missing')
    const inline = [
      { children: themeInitScript() },
      ...(templateConfig.i18n.enabled
        ? [
            {
              children: localeSuggestionScript({
                baseLocale,
                locales,
                preferenceCookie: PREFERENCE_COOKIE,
                localeCookie: cookieName,
                cookieMaxAge: LOCALE_COOKIE_MAX_AGE,
              }),
            },
          ]
        : []),
    ]
    for (const pathname of ['/', '/zh/pricing', '/app/personal/chat', '/admin/users']) {
      const result = await head({ matches: [{ pathname }] } as Parameters<typeof head>[0])
      expect(result?.scripts).toEqual(inline)
      expect(JSON.stringify(result?.scripts)).not.toMatch(/posthog|beacon/i)
    }
  })

  it('有 token 时公开页面输出 defer beacon，应用与后台不输出', () => {
    const config = {
      ...templateConfig,
      analytics: { ...templateConfig.analytics, cloudflareToken: 'public-token' },
    }
    expect(analyticsHeadScripts('/zh/pricing', config)).toEqual([
      {
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        defer: true,
        'data-cf-beacon': '{"token":"public-token","spa":false}',
      },
    ])
    for (const pathname of ['/app', '/account', '/admin', '/admin/users', '/api/health'])
      expect(analyticsHeadScripts(pathname, config)).toEqual([])
  })
})
