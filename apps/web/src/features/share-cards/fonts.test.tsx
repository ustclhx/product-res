import { describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { projectFonts, resolveProjectShareCardFonts, shareCardFontFingerprint } from './fonts.ts'
import { sampleShareCardLayout } from './layout.tsx'
import { shareCardImagePath, shareCardVariant } from './meta.ts'
import { collectText } from './renderer.ts'
import {
  isBareHost,
  resolveRequestShareCardSite,
  resolveShareCardSite,
  shareCardLocale,
  shareCardUrlLocale,
} from './site.ts'
import { fallbackFontPlan, needsFallbackFont, sanitizeText, textWidth } from './text.ts'
import { resolveShareCardTheme } from './theme.ts'

const hangul = resolveProjectShareCardFonts([
  { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf', scripts: ['Hangul'] },
])
const cyrillic = resolveProjectShareCardFonts([
  { name: 'Noto Sans', file: 'NotoSans-Regular.ttf', scripts: ['Cyrillic'] },
])

describe('项目回退字体登记', () => {
  it('模板默认不登记任何项目字体，指纹为空', () => {
    expect(projectFonts).toEqual([])
    expect(shareCardFontFingerprint()).toBe('')
  })

  it.each([
    '../NotoSansKR.otf',
    'fonts/NotoSansKR.otf',
    'fonts\\NotoSansKR.otf',
    'NotoSansKR.woff2',
    'NotoSansKR..otf',
    '.hidden.otf',
    '',
  ])('拒绝不合法的文件名 %j', (file) => {
    expect(() =>
      resolveProjectShareCardFonts([{ name: 'Noto Sans KR', file, scripts: ['Hangul'] }]),
    ).toThrow(TypeError)
  })

  it('拒绝未知文字、Common 文字、空文字列表、模板字体族名与重复登记', () => {
    const font = { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf' }
    expect(() => resolveProjectShareCardFonts([{ ...font, scripts: ['Klingon'] }])).toThrow(
      /Unknown Unicode script/,
    )
    expect(() => resolveProjectShareCardFonts([{ ...font, scripts: ['Common'] }])).toThrow(
      TypeError,
    )
    expect(() => resolveProjectShareCardFonts([{ ...font, scripts: ['Han}]'] }])).toThrow(TypeError)
    expect(() => resolveProjectShareCardFonts([{ ...font, scripts: [] }])).toThrow(TypeError)
    expect(() =>
      resolveProjectShareCardFonts([{ ...font, name: 'Noto Sans SC', scripts: ['Hangul'] }]),
    ).toThrow(TypeError)
    expect(() =>
      resolveProjectShareCardFonts([
        { ...font, scripts: ['Hangul'] },
        { ...font, scripts: ['Hangul'] },
      ]),
    ).toThrow(/Duplicate/)
    // 同一字体族的两个字重可以同时登记
    expect(
      resolveProjectShareCardFonts([
        { ...font, scripts: ['Hangul'] },
        { ...font, file: 'NotoSansKR-SemiBold.otf', scripts: ['Hangul'], weight: 600 },
      ]).map((entry) => entry.weight),
    ).toEqual([400, 600])
  })

  it('指纹随登记的族名、文件、字重与文字变化', () => {
    const base = { name: 'Noto Sans KR', file: 'NotoSansKR-Regular.otf', scripts: ['Hangul'] }
    const fingerprint = (font: Parameters<typeof resolveProjectShareCardFonts>[0][number]) =>
      shareCardFontFingerprint(resolveProjectShareCardFonts([font]))
    const original = fingerprint(base)
    expect(original).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint({ ...base })).toBe(original)
    expect(fingerprint({ ...base, file: 'NotoSansKR-Medium.otf' })).not.toBe(original)
    expect(fingerprint({ ...base, name: 'Pretendard' })).not.toBe(original)
    expect(fingerprint({ ...base, scripts: ['Hangul', 'Han'] })).not.toBe(original)
    expect(fingerprint({ ...base, weight: 600 })).not.toBe(original)
  })
})

describe('文本与项目字体', () => {
  it('没有谚文字体时谚文不触发回退；登记后触发项目字体而不是 Noto', () => {
    expect(needsFallbackFont('보고서', [])).toBe(false)
    expect(fallbackFontPlan('보고서', hangul)).toEqual({ cjk: false, project: hangul })
    expect(needsFallbackFont('보고서', hangul)).toBe(true)
    // 拉丁与中文文本不加载谚文字体
    expect(fallbackFontPlan('Report', hangul)).toEqual({ cjk: false, project: [] })
    expect(fallbackFontPlan('报告', hangul)).toEqual({ cjk: true, project: [] })
    // 混排同时需要两者，项目字体排在 Noto 之后
    expect(fallbackFontPlan('报告 보고서', hangul)).toEqual({ cjk: true, project: hangul })
    // 泰文仍不支持
    expect(needsFallbackFont('ภาษาไทย', hangul)).toBe(false)
  })

  it('项目字体覆盖的文字不再降级为基本字母', () => {
    // 白俄罗斯文 ў（U+045E）Noto 简体子集没有字形：没有项目字体时去掉附加符号降级为 у
    expect(sanitizeText('ўзор', [])).toBe('узор')
    expect(sanitizeText('ўзор', cyrillic)).toBe('ўзор')
    expect(sanitizeText('보고서 🚀', hangul)).toBe('보고서')
  })

  it('谚文按全角字宽计算，截断不会溢出', () => {
    expect(textWidth('보고서')).toBe(3)
  })
})

describe('卡片地址与字体指纹', () => {
  const card = { version: 2, digest: () => 'abcdef1234' }

  it('没有项目字体与站点覆盖时地址与之前相同', () => {
    expect(shareCardVariant(card, null)).toBe('2-abcdef12')
    expect(shareCardVariant(card, null, { fingerprint: '' }, '')).toBe('2-abcdef12')
  })

  it('字体登记变化时地址变化', () => {
    const one = shareCardVariant(card, null, undefined, shareCardFontFingerprint(hangul))
    const two = shareCardVariant(card, null, undefined, shareCardFontFingerprint(cyrillic))
    expect(one).toMatch(/^2-abcdef12-[0-9a-f]{8}$/)
    expect(two).not.toBe(one)
  })
})

describe('多站点解析', () => {
  const east = {
    theme: { brandAccent: '#b91c1c' },
    brand: { name: 'Ganjiday', initial: '干' },
    host: 'ganjiday.com',
  }
  const resolver = vi.fn((context: { host?: string | undefined }) =>
    context.host === 'ganjiday.com' ? east : undefined,
  )

  it('没有解析函数（模板默认）时与单站点完全相同', () => {
    const { site, themeOverride } = resolveShareCardSite({ host: 'ganjiday.com' })
    const theme = resolveShareCardTheme('light', themeOverride)
    expect(theme).toEqual(resolveShareCardTheme('light'))
    expect(site).toMatchObject({
      brand: { name: templateConfig.app.name },
      host: new URL(templateConfig.app.url).host,
      fingerprint: '',
    })
    const appUrl = 'https://product.ezarouter.cc'
    expect(resolveRequestShareCardSite('https://other.test/share-card/x', appUrl).origin).toBe(
      appUrl,
    )
  })

  it('按 host 替换主题、品牌与域名，其余站点沿用默认', () => {
    const matched = resolveShareCardSite({ host: 'ganjiday.com' }, resolver)
    const matchedTheme = resolveShareCardTheme('light', matched.themeOverride)
    expect(matchedTheme.brandAccent).toBe('#b91c1c')
    expect(matchedTheme.background).toBe(resolveShareCardTheme('light').background)
    expect(matched.site.brand).toEqual(east.brand)
    expect(matched.site.host).toBe('ganjiday.com')
    const text = collectText(
      sampleShareCardLayout(
        { title: 'Report', description: '', label: '', meta: '' },
        matchedTheme,
        matched.site,
      ),
    )
    expect(text).toContain('Ganjiday')
    expect(text).toContain('ganjiday.com')
    expect(text).not.toContain(templateConfig.app.name)

    const other = resolveShareCardSite({ host: 'arcanumber.com' }, resolver)
    expect(other.site.fingerprint).toBe('')
    expect(other.site.brand.name).toBe(templateConfig.app.name)
  })

  it('不同站点的卡片地址不同，绝对地址使用站点声明的规范域名而不是请求 Host', () => {
    const card = { version: 1, digest: () => 'deadbeef00' }
    const eastSite = resolveShareCardSite({ host: 'ganjiday.com' }, resolver).site
    const westSite = resolveShareCardSite({ host: 'arcanumber.com' }, resolver).site
    expect(shareCardVariant(card, null, eastSite, '')).not.toBe(
      shareCardVariant(card, null, westSite, ''),
    )
    // www 变体与预览域名都映射到同一站点：绝对地址仍是规范域名
    const canonical = vi.fn(() => east)
    for (const requestUrl of [
      'https://www.ganjiday.com/s/report/x',
      'https://product-res-web-preview.example.workers.dev/s/report/x',
    ]) {
      const request = resolveRequestShareCardSite(
        requestUrl,
        'https://product.ezarouter.cc',
        canonical,
      )
      expect(request.origin).toBe('https://ganjiday.com')
      // 同一站点多次解析得到同一地址
      expect(request.site.fingerprint).toBe(eastSite.fingerprint)
    }
    // 覆盖未声明 host：绝对地址仍用 APP_URL
    const noHost = resolveRequestShareCardSite(
      'https://evil.test/s/report/x',
      'https://product.ezarouter.cc',
      () => ({ brand: { name: 'Ganjiday' } }),
    )
    expect(noHost.origin).toBe('https://product.ezarouter.cc')
    expect(noHost.site.brand.name).toBe('Ganjiday')
  })

  it.each([
    'https://ganjiday.com',
    'ganjiday.com/path',
    'user@ganjiday.com',
    'ganjiday.com?x=1',
    'ganjiday.com#x',
    'gan jiday.com',
    '',
  ])('站点 host %j 不是裸主机名时整个覆盖无效', (host) => {
    const resolved = resolveRequestShareCardSite(
      'https://ganjiday.com/s/report/x',
      'https://product.ezarouter.cc',
      () => ({ ...east, host }),
    )
    expect(resolved.origin).toBe('https://product.ezarouter.cc')
    expect(resolved.site.fingerprint).toBe('')
    expect(resolved.site.brand.name).toBe(templateConfig.app.name)
    expect(resolved.themeOverride).toEqual({})
  })

  describe('运行时语言（0.5.0）', () => {
    const { defaultLocale, locales, enabled } = templateConfig.i18n
    const other = enabled ? locales.find((locale) => locale !== defaultLocale) : undefined
    // 地址只用到 type、version 与 digest
    const card = {
      type: 'report',
      version: 1,
      digest: () => 'deadbeef00',
    } as unknown as Parameters<typeof shareCardImagePath>[0]
    const byLocale = vi.fn((context: { locale?: string | undefined }) => ({
      ...east,
      brand: { name: context.locale === defaultLocale ? 'Ganjiday' : `Ganjiday ${context.locale}` },
    }))

    it('只接受模板配置的语言，其余为默认语言', () => {
      expect(shareCardLocale(undefined)).toBe(defaultLocale)
      expect(shareCardLocale(null)).toBe(defaultLocale)
      expect(shareCardLocale('xx')).toBe(defaultLocale)
      expect(shareCardLocale('../en')).toBe(defaultLocale)
      if (other) expect(shareCardLocale(other)).toBe(other)
    })

    it('默认语言的指纹与地址与 0.4.x（不传语言）相同', () => {
      const legacy = resolveShareCardSite({ host: 'ganjiday.com' }, resolver).site
      const page = resolveRequestShareCardSite(
        'https://ganjiday.com/s/report/x',
        'https://product.ezarouter.cc',
        resolver,
        defaultLocale,
      ).site
      expect(page.fingerprint).toBe(legacy.fingerprint)
      expect(shareCardUrlLocale(page)).toBeUndefined()
      expect(shareCardImagePath(card, 'tok', null, page)).not.toContain('&l=')
    })

    it.skipIf(!other)('非默认语言传给解析函数、计入 v 并以 l 参数带到卡片地址', () => {
      const page = resolveRequestShareCardSite(
        'https://ganjiday.com/s/report/x',
        'https://product.ezarouter.cc',
        byLocale,
        other,
      ).site
      expect(byLocale).toHaveBeenLastCalledWith(expect.objectContaining({ locale: other }))
      expect(page.brand.name).toBe(`Ganjiday ${other}`)
      const fallback = resolveRequestShareCardSite(
        'https://ganjiday.com/s/report/x',
        'https://product.ezarouter.cc',
        byLocale,
        'xx',
      ).site
      expect(page.fingerprint).not.toBe(fallback.fingerprint)
      const path = shareCardImagePath(card, 'tok', null, page)
      expect(path).toMatch(new RegExp(`\\?v=[^&]+&l=${other}$`))
      // 卡片路由用地址里的 l 解析，得到同一站点与同一 v
      const route = resolveRequestShareCardSite(
        `https://ganjiday.com${path}`,
        'https://product.ezarouter.cc',
        byLocale,
        new URL(path, 'https://ganjiday.com').searchParams.get('l'),
      ).site
      expect(route.fingerprint).toBe(page.fingerprint)
    })

    it.skipIf(!other)('没有站点覆盖时非默认语言也不改变地址', () => {
      const site = resolveRequestShareCardSite(
        'https://ganjiday.com/s/report/x',
        'https://product.ezarouter.cc',
        () => undefined,
        other,
      ).site
      expect(site.fingerprint).toBe('')
      expect(shareCardImagePath(card, 'tok', null, site)).not.toContain('&l=')
    })
  })

  it('裸主机名可带端口，大小写归一', () => {
    expect(isBareHost('ganjiday.com')).toBe(true)
    expect(isBareHost('localhost:3000')).toBe(true)
    expect(isBareHost('Ganjiday.COM')).toBe(true)
    expect(isBareHost('ganjiday.com:99999')).toBe(false)
    const resolved = resolveShareCardSite({}, () => ({ host: 'Ganjiday.COM' }))
    expect(resolved.site.host).toBe('ganjiday.com')
  })
})
