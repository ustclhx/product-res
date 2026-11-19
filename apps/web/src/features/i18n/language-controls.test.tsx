import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseLocale, locales, localizeHref, overwriteGetLocale } from '../../paraglide/runtime.js'

const route = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('@tanstack/react-router', () => ({ useLocation: () => route }))
vi.mock('./preference.functions.ts', () => ({ saveLanguagePreference: vi.fn() }))

import { LanguageControls } from './language-controls.tsx'

const candidates = locales.filter((locale) => locale !== baseLocale)
const banners = (html: string) =>
  html.match(/<aside\b[^>]*data-locale-suggestion-for="[^"]+"[^>]*>/g) ?? []

afterEach(() => {
  route.pathname = '/'
  overwriteGetLocale(() => baseLocale)
})

describe('语言建议横幅（首帧即在最终位置）', () => {
  it.skipIf(candidates.length === 0)(
    '默认语言营销页服务端输出每个候选语言的隐藏横幅与显示规则，由首帧前脚本选择显示哪一条',
    () => {
      for (const pathname of ['/', '/pricing']) {
        route.pathname = pathname
        const html = renderToString(<LanguageControls />)
        expect(banners(html)).toHaveLength(candidates.length)
        for (const banner of banners(html)) {
          expect(banner).toMatch(/class="hidden /)
          // 水合标记只在客户端 effect 中加上，服务端输出不带
          expect(banner).not.toContain('data-hydrated')
        }
        expect(html).toContain(`[data-locale-suggestion-for="${candidates[0]}"]{display:flex}`)
        // 「切换」是指向目标语言地址的真实链接（水合前、无 JS 也可用），两个按钮带委托监听识别的属性
        const target = localizeHref(pathname, { locale: candidates[0] ?? baseLocale })
        expect(html).toMatch(
          new RegExp(`<a[^>]*href="${target}"[^>]*data-locale-suggestion-action="switch"`),
        )
        expect(html).toMatch(/<button[^>]*data-locale-suggestion-action="dismiss"/)
        // 横幅文案不进入搜索摘要
        expect(html.match(/<div data-nosnippet=""/g)).toHaveLength(candidates.length)
      }
    },
  )

  it.skipIf(candidates.length === 0)('只输出可建议语言的横幅与显示规则', () => {
    const [first] = candidates
    const html = renderToString(<LanguageControls suggestableLocales={first ? [first] : []} />)
    expect(banners(html)).toHaveLength(1)
    expect(banners(html)[0]).toContain(`data-locale-suggestion-for="${first}"`)
    expect(banners(renderToString(<LanguageControls suggestableLocales={[]} />))).toHaveLength(0)
  })

  it('非营销页、非默认语言页与关闭建议的实例不输出横幅', () => {
    route.pathname = '/login'
    expect(banners(renderToString(<LanguageControls />))).toHaveLength(0)
    route.pathname = '/'
    expect(banners(renderToString(<LanguageControls suggest={false} />))).toHaveLength(0)
    const other = candidates[0]
    if (other) {
      overwriteGetLocale(() => other)
      route.pathname = `/${other}`
      expect(banners(renderToString(<LanguageControls />))).toHaveLength(0)
    }
  })
})
