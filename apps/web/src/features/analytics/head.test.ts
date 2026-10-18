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

import { Route } from '../../routes/__root.tsx'
import { templateConfig } from '../../server/template-config.ts'
import { analyticsHeadScripts } from './head.ts'

describe('分析脚本页面 head', () => {
  it('默认页面 head 无 PostHog 或 beacon，主题内联脚本保持原样', async () => {
    const head = Route.options.head
    if (!head) throw new Error('Root head is missing')
    for (const pathname of ['/', '/zh/pricing', '/app/personal/chat', '/admin/users']) {
      const result = await head({ matches: [{ pathname }] } as Parameters<typeof head>[0])
      expect(result?.scripts).toEqual([{ children: themeInitScript() }])
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
