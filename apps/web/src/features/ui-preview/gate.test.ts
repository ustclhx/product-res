import { describe, expect, it } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { isPrerenderedPath } from '../marketing/prerender.ts'
import { publicPages } from '../seo/pages.ts'
import { isUiPreviewEnabled, UI_PREVIEW_PATH } from './gate.ts'

describe('组件预览页开关（add-ui-design-system D6）', () => {
  it('只有 UI_PREVIEW=true 开放；生产不设该变量时返回 404', () => {
    expect(isUiPreviewEnabled({ UI_PREVIEW: 'true' })).toBe(true)
    // production 的 wrangler vars 不含 UI_PREVIEW（scripts/production/check-wrangler-envs.mjs 拦截）
    expect(isUiPreviewEnabled({})).toBe(false)
    for (const value of ['', 'false', 'TRUE', '1', 'yes']) {
      expect(isUiPreviewEnabled({ UI_PREVIEW: value }), value).toBe(false)
    }
  })

  it('不预渲染，也不进 sitemap', () => {
    const locales = ['en', 'zh']
    for (const path of [UI_PREVIEW_PATH, `/zh${UI_PREVIEW_PATH}`]) {
      expect(isPrerenderedPath(path, locales), path).toBe(false)
    }
    const pages = publicPages(
      { posts: [], legal: [], docs: [], guides: [] },
      new Date('2026-11-01'),
      { ...templateConfig, marketing: { ...templateConfig.marketing, enabled: true } },
    )
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.some((page) => page.path.startsWith('/dev'))).toBe(false)
  })
})
