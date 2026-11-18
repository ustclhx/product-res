import { describe, expect, it } from 'vitest'
import {
  handledBeforeHydration,
  localeSuggestionScript,
  PREHYDRATION_DETACH_KEY,
  SUGGESTION_ATTRIBUTE,
  scriptKey,
  suggestionCss,
  suggestionTargets,
} from './suggestion.ts'

const scriptFor = (options: Partial<Parameters<typeof localeSuggestionScript>[0]> = {}): string =>
  localeSuggestionScript({
    baseLocale: 'en',
    locales: ['en', 'zh', 'pt-BR'],
    preferenceCookie: 'locale-preference',
    localeCookie: 'PARAGLIDE_LOCALE',
    cookieMaxAge: 100,
    ...options,
  })
const script = scriptFor()

type Listener = (event: Record<string, unknown>) => void

/** 在假的 document / navigator / window 上执行首帧脚本 */
function load({
  lang = 'en',
  languages,
  cookie = '',
  protocol = 'https:',
  search = '',
  hash = '',
  source = script,
  intl = Intl,
}: {
  /** 首帧脚本，默认为 en / zh / pt-BR 配置 */
  source?: string
  /** 替换全局 Intl，模拟不支持 Intl.Locale 的浏览器 */
  intl?: unknown
  lang?: string
  languages: readonly string[] | undefined
  cookie?: string
  protocol?: string
  search?: string
  hash?: string
}) {
  const attributes = new Map<string, string>()
  const writes: string[] = []
  const listeners = new Set<Listener>()
  const document = {
    get cookie() {
      return cookie
    },
    set cookie(value: string) {
      writes.push(value)
    },
    documentElement: {
      lang,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
  }
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener, capture: boolean) => {
      if (type === 'click' && capture) listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  }
  const navigator = { languages, language: languages?.[0] }
  new Function('document', 'navigator', 'window', 'location', 'Intl', source)(
    document,
    navigator,
    window,
    { protocol, search, hash },
    intl,
  )
  /** 模拟点击横幅中某个操作按钮（或横幅外的元素） */
  const click = (action: 'switch' | 'dismiss' | null, target = 'zh', href = '/zh/pricing') => {
    const banner = { getAttribute: () => target }
    const button = {
      href,
      getAttribute: (name: string) => (name === 'href' ? button.href : action),
      setAttribute: (_name: string, value: string) => {
        button.href = value
      },
      closest: (selector: string) => (selector.includes('-for') ? banner : action ? button : null),
    }
    const event: Record<string, unknown> = {
      target: { closest: (selector: string) => (action ? button.closest(selector) : null) },
    }
    for (const listener of listeners) listener(event)
    return Object.assign(event, { href: button.href })
  }
  return {
    suggestion: attributes.get(SUGGESTION_ATTRIBUTE) ?? null,
    attributes,
    writes,
    listeners,
    click,
    detach: () => (window[PREHYDRATION_DETACH_KEY] as () => void)(),
  }
}

const run = (options: Parameters<typeof load>[0]) => load(options).suggestion

describe('首帧前的语言建议脚本', () => {
  it('按浏览器偏好顺序取第一个配置语言：地区标签退回主语言，完整标签优先', () => {
    expect(run({ languages: ['fr', 'zh-CN', 'en'] })).toBe('zh')
    expect(run({ languages: ['pt-BR', 'zh'] })).toBe('pt-BR')
    expect(run({ languages: ['ZH-tw'] })).toBe('zh')
  })

  it('配置按书写系统区分的语言时，地区标签按补全后的书写系统匹配', () => {
    const source = scriptFor({ locales: ['en', 'zh-Hant', 'zh-Hans'] })
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'])
      expect(run({ source, languages: [tag] }), tag).toBe('zh-Hant')
    for (const tag of ['zh-CN', 'zh-SG', 'zh', 'zh-hans-cn'])
      expect(run({ source, languages: [tag] }), tag).toBe('zh-Hans')
    // 完整标签仍优先于书写系统
    expect(
      run({ source: scriptFor({ locales: ['en', 'zh-Hans', 'zh-TW'] }), languages: ['zh-TW'] }),
    ).toBe('zh-TW')
    // 不支持 Intl.Locale 时跳过这一步，退回主语言子标签（zh 不在配置中，不建议）
    expect(run({ source, languages: ['zh-TW'], intl: null })).toBeNull()
    expect(run({ languages: ['zh-TW'], intl: {} })).toBe('zh')
  })

  it('只配置 zh 时结果与此前相同：繁体地区标签由主语言子标签兜底', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-CN', 'zh-Hant', 'zh'])
      expect(run({ languages: [tag] }), tag).toBe('zh')
    expect(run({ languages: ['en-GB', 'zh'] })).toBeNull()
    expect(run({ languages: ['pt-PT'] })).toBe('pt-BR')
    expect(run({ languages: ['pt'] })).toBe('pt-BR')
  })

  it('只建议允许的语言：最先匹配的语言不允许时不建议、不写属性、不注册监听', () => {
    const source = scriptFor({ suggestableLocales: ['pt-BR'] })
    expect(run({ source, languages: ['pt-BR'] })).toBe('pt-BR')
    const page = load({ source, languages: ['zh-CN', 'pt-BR'] })
    // 不跳到后面的 pt-BR：zh 是使用者更想要的语言
    expect(page.attributes.size).toBe(0)
    expect(page.listeners.size).toBe(0)
    // 不在配置中的允许值被忽略
    expect(run({ source: scriptFor({ suggestableLocales: ['fr'] }), languages: ['fr'] })).toBeNull()
  })

  it('默认语言排在前面、没有匹配或缺少 languages 时不建议', () => {
    expect(run({ languages: ['en-US', 'zh'] })).toBeNull()
    expect(run({ languages: ['fr', 'de'] })).toBeNull()
    expect(run({ languages: [] })).toBeNull()
    expect(run({ languages: undefined })).toBeNull()
  })

  it('非默认语言页面或已手动选择（偏好 Cookie）时不建议', () => {
    expect(run({ lang: 'zh', languages: ['zh-CN'] })).toBeNull()
    expect(run({ languages: ['zh-CN'], cookie: 'a=1; locale-preference=en' })).toBeNull()
    // 名称相近的其他 Cookie 不影响
    expect(run({ languages: ['zh-CN'], cookie: 'x-locale-preference=en' })).toBe('zh')
  })

  it('水合前点击「切换」写入目标语言的两个 Cookie 并交给链接导航，只处理一次', () => {
    const page = load({ languages: ['zh-CN'] })
    const event = page.click('switch')
    expect(page.writes).toEqual([
      'PARAGLIDE_LOCALE=zh; Path=/; Max-Age=100; SameSite=Lax; Secure',
      'locale-preference=zh; Path=/; Max-Age=100; SameSite=Lax; Secure',
    ])
    expect(handledBeforeHydration(event as unknown as Event)).toBe(true)
    // 同一事件再次分发（如 React 重放）不重复处理
    for (const listener of page.listeners) listener(event)
    expect(page.writes).toHaveLength(2)
    expect(page.attributes.get(SUGGESTION_ATTRIBUTE)).toBe('zh')
  })

  it('水合前点击「切换」保留当前地址的查询参数与锚点（如 UTM）', () => {
    const page = load({ languages: ['zh-CN'], search: '?utm_source=x', hash: '#faq' })
    expect(page.click('switch').href).toBe('/zh/pricing?utm_source=x#faq')
    expect(load({ languages: ['zh-CN'] }).click('switch').href).toBe('/zh/pricing')
    expect(page.click('dismiss').href).toBe('/zh/pricing')
  })

  it('水合前点击「保留当前语言」记住当前语言并隐藏横幅；横幅外的点击不处理', () => {
    const page = load({ languages: ['zh-CN'], protocol: 'http:' })
    page.click(null)
    expect(page.writes).toEqual([])
    page.click('dismiss')
    expect(page.writes).toEqual([
      'PARAGLIDE_LOCALE=en; Path=/; Max-Age=100; SameSite=Lax',
      'locale-preference=en; Path=/; Max-Age=100; SameSite=Lax',
    ])
    expect(page.attributes.has(SUGGESTION_ATTRIBUTE)).toBe(false)
  })

  it('水合后摘除监听，点击交给 React；没有建议时不注册监听', () => {
    const page = load({ languages: ['zh-CN'] })
    page.detach()
    const event = page.click('dismiss')
    expect(page.writes).toEqual([])
    expect(handledBeforeHydration(event as unknown as Event)).toBe(false)
    expect(load({ languages: ['en-US'] }).listeners.size).toBe(0)
  })

  it('scriptKey 与可建议语言', () => {
    expect(scriptKey('zh-TW')).toBe('zh-hant')
    expect(scriptKey('zh')).toBe('zh-hans')
    expect(scriptKey('en')).toBe('en-latn')
    expect(scriptKey('not a tag')).toBe('')
    expect(suggestionTargets({ baseLocale: 'en', locales: ['en', 'zh', 'pt-BR'] })).toEqual([
      'zh',
      'pt-BR',
    ])
    expect(
      suggestionTargets({
        baseLocale: 'en',
        locales: ['en', 'zh', 'pt-BR'],
        suggestableLocales: ['pt-BR', 'en', 'fr'],
      }),
    ).toEqual(['pt-BR'])
  })

  it('显示规则只匹配与 <html> 属性相同的候选横幅', () => {
    expect(suggestionCss(['zh', 'pt-BR'])).toBe(
      ':root[data-locale-suggestion="zh"] [data-locale-suggestion-for="zh"]{display:flex}' +
        ':root[data-locale-suggestion="pt-BR"] [data-locale-suggestion-for="pt-BR"]{display:flex}',
    )
  })
})
