import { describe, expect, it, vi } from 'vitest'

vi.mock('./origin.functions.ts', () => ({ getSafeImpersonation: vi.fn(), getSeoOrigin: vi.fn() }))
vi.mock('../admin/settings-announcement.functions.ts', () => ({ getAnnouncement: vi.fn() }))

vi.mock('../admin/impersonation-banner.tsx', () => ({ ImpersonationBanner: () => null }))
vi.mock('../admin/settings-announcement-banner.tsx', () => ({ AnnouncementBanner: () => null }))
vi.mock('../i18n/language-controls.tsx', () => ({ LanguageControls: () => null }))

import { Route } from '../../routes/__root.tsx'

describe('根布局页面 head', () => {
  it('应用、账号与后台页面输出 noindex，公开营销和内容页面可索引', async () => {
    const head = Route.options.head
    if (!head) throw new Error('Root head is missing')
    for (const pathname of [
      '/app',
      '/app/personal/chat',
      '/account',
      '/admin',
      '/',
      '/blog/welcome',
      '/legal/terms',
      '/docs/content',
    ]) {
      const result = await head({ matches: [{ pathname }] } as Parameters<typeof head>[0])
      const robots = result?.meta?.find((meta) => meta && 'name' in meta && meta.name === 'robots')
      const isPrivate = ['/app', '/account', '/admin'].some((prefix) => pathname.startsWith(prefix))
      expect(robots?.content, pathname).toBe(isPrivate ? 'noindex, nofollow' : undefined)
    }
  })
})
