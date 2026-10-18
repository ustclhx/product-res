import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseLocale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import { NOT_FOUND_PATH } from '../admin/gate.ts'
import { gateLocaleRequest } from './gate.ts'
import { localeRewrite } from './routing.ts'

const otherLocale = locales.find((locale) => locale !== baseLocale) ?? baseLocale
const enabled = templateConfig.i18n.enabled

const origin = 'https://product.ezarouter.cc'
const url = (path: string) => new URL(path, origin)
const gated = (path: string) => new URL(gateLocaleRequest(new Request(url(path))).url).pathname
const input = (path: string) => new URL(String(localeRewrite.input({ url: url(path) }))).pathname
const output = (path: string) => new URL(String(localeRewrite.output({ url: url(path) }))).pathname

describe('语言路由（默认语言与其他配置语言）', () => {
  beforeEach(() => overwriteGetLocale(() => baseLocale))
  afterEach(() => overwriteGetLocale(() => baseLocale))

  it('默认语言无前缀：路由器看到的就是原地址，生成的链接也不加前缀', () => {
    expect(gated('/pricing')).toBe('/pricing')
    expect(input('/pricing')).toBe('/pricing')
    expect(output('/pricing')).toBe('/pricing')
  })

  it('其他配置语言：去掉语言前缀后交给路由器，生成链接时按当前语言加回前缀', () => {
    expect(gated(`/${otherLocale}/pricing`)).toBe(
      enabled ? `/${otherLocale}/pricing` : NOT_FOUND_PATH,
    )
    expect(input(`/${otherLocale}/pricing`)).toBe(enabled ? '/pricing' : `/${otherLocale}/pricing`)
    expect(input(`/${otherLocale}`)).toBe(enabled ? '/' : `/${otherLocale}`)
    overwriteGetLocale(() => otherLocale)
    expect(output('/pricing')).toBe(enabled ? `/${otherLocale}/pricing` : '/pricing')
  })

  it('配置语言前缀在单语言模式全部拒绝，语言改写保留原 URL', () => {
    for (const locale of templateConfig.i18n.locales) {
      const path = `/${locale}/pricing`
      expect(gated(path)).toBe(enabled ? path : NOT_FOUND_PATH)
      if (!enabled) {
        expect(input(path)).toBe(path)
        expect(output(path)).toBe(path)
      }
    }
  })

  it('未配置的前缀保持原样，由路由器按不存在的页面返回 404', () => {
    expect(gated('/fr/pricing')).toBe('/fr/pricing')
    expect(input('/fr/pricing')).toBe('/fr/pricing')
  })

  it('应用区不加语言前缀：带前缀访问改写到 404，链接也不加前缀', () => {
    for (const path of ['/zh/app', '/zh/app/acme', '/zh/account', '/zh/admin', '/zh/api/health']) {
      expect(gated(path)).toBe(NOT_FOUND_PATH)
    }
    expect(gated('/en/admin')).toBe(NOT_FOUND_PATH)
    expect(gated('/app')).toBe('/app')
    expect(gated('/zh/apple')).toBe(enabled ? '/zh/apple' : NOT_FOUND_PATH)
    overwriteGetLocale(() => otherLocale)
    expect(output('/app/acme')).toBe('/app/acme')
    expect(output('/api/health')).toBe('/api/health')
  })
})
