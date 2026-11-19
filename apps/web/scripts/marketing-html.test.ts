import { describe, expect, it } from 'vitest'
import {
  afterPaintLoader,
  assertSameHead,
  brandOverridesFontSans,
  decodeClassAttributes,
  documentClasses,
  fontFaceRules,
  headSignature,
  optimizeHtml,
  RootAttributeRule,
  rootAttributes,
  selectorClasses,
  usedCss,
} from './marketing-html.mjs'

// 与预渲染产物同形的夹具：字体 preload、modulepreload、外链样式表、SEO head、水合入口
const HEAD = [
  '<meta charSet="utf-8" nonce="n1"/>',
  '<title>Home | product-res</title>',
  '<meta name="description" content="Desc"/>',
  '<meta property="og:url" content="https://product.ezarouter.cc/"/>',
  '<link rel="canonical" href="https://product.ezarouter.cc/"/>',
  '<link rel="alternate" hreflang="zh" href="https://product.ezarouter.cc/zh"/>',
  '<link rel="preload" href="/assets/inter-latin-opsz-normal-x.woff2" as="font" crossorigin="" type="font/woff2"/>',
  '<link rel="stylesheet" href="/assets/app-1.css"/>',
  '<link rel="modulepreload" href="/assets/index-1.js" nonce="n1"/>',
  '<link rel="modulepreload" href="/assets/routes-1.js" nonce="n1"/>',
  '<script type="application/ld+json" nonce="n1">{"@type":"Organization"}</script>',
].join('')
const BODY =
  '<main class="hero"><h1 class="title">Hi</h1></main><script type="module" async="" src="/assets/index-1.js" nonce="n1"></script>'
const HTML = `<!DOCTYPE html><html lang="en"><head>${HEAD}</head><body>${BODY}</body></html>`
const CSS = [
  '@layer base{:root{--fg:#111}}',
  '@font-face{font-family:Inter Variable;src:url(/assets/inter.woff2) format("woff2")}',
  '@font-face{font-family:Other;src:url(/assets/other.woff2)}',
  '.hero{display:grid}',
  '.title{font-family:var(--font-sans)}',
  '.dark .title{color:#fff}',
  '.unused-panel{position:fixed;inset:0}',
  '@media (min-width:48rem){.title{font-size:3rem}.unused-panel{display:none}}',
].join('')
const readCss = async (href: string) => {
  expect(href).toBe('/assets/app-1.css')
  return CSS
}

describe('营销页构建后处理', () => {
  it('默认（full / eager）：整份内联，modulepreload 与入口脚本保留，与改动前一致', async () => {
    const result = await optimizeHtml(HTML, {}, readCss)
    expect(result.html).toContain(`<style>${CSS}</style>`)
    expect(result.html).not.toContain('rel="stylesheet"')
    expect(result.html).toContain('rel="modulepreload"')
    expect(result.html).toContain('<script type="module" async="" src="/assets/index-1.js"')
    expect(result.html).not.toContain('PerformanceObserver')
    expect(result).toMatchObject({ inlined: 1, styles: [], scripts: [] })
  })

  it('criticalCss used：只内联用到的规则，保留全部 @font-face、深色规则与媒体查询，完整样式表首帧后加载', async () => {
    const { html, styles } = await optimizeHtml(HTML, { criticalCss: 'used' }, readCss)
    const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    expect(inline).toContain('.hero')
    expect(inline).toContain('.title')
    expect(inline).toContain('.dark .title')
    expect(inline).toContain('@media (min-width:48rem)')
    expect(inline).toContain('--fg:#111')
    expect(inline).not.toContain('unused-panel')
    // beasties 解析不了 var(--font-sans) 引用的字体族，全部 @font-face 由后处理补回
    expect(fontFaceRules(inline)).toHaveLength(2)
    expect(styles).toEqual(['/assets/app-1.css'])
    // 关闭 JS 时由 noscript 引入完整样式表
    expect(html).toContain(
      '<noscript><link rel="stylesheet" href="/assets/app-1.css"/></noscript></head>',
    )
    expect(html).toContain('"/assets/app-1.css"')
    // eager 时入口脚本不动，加载器只负责样式表
    expect(html).toContain('<script type="module" async="" src="/assets/index-1.js"')
    // 不新增 preload（字体 preload 只保留项目声明的那一个）
    expect(html.match(/rel="preload"/g)).toHaveLength(1)
  })

  it('hydration after-paint：去掉 modulepreload，入口改由加载器在首帧后插入', async () => {
    const { html, scripts } = await optimizeHtml(HTML, { hydration: 'after-paint' }, readCss)
    expect(html).not.toContain('modulepreload')
    expect(html).not.toMatch(/<script type="module"/)
    expect(scripts).toEqual(['/assets/index-1.js'])
    expect(html).toContain(afterPaintLoader({ styles: [], scripts: ['/assets/index-1.js'] }))
    expect(html.indexOf('PerformanceObserver')).toBeGreaterThan(html.indexOf('<main'))
  })

  it('两项同时开启：一个加载器先样式表后脚本；head SEO 内容不变', async () => {
    const { html } = await optimizeHtml(
      HTML,
      { hydration: 'after-paint', criticalCss: 'used' },
      readCss,
    )
    expect(html.match(/PerformanceObserver/g)).toHaveLength(1)
    expect(html).toContain('css=["/assets/app-1.css"],js=["/assets/index-1.js"]')
    expect(headSignature(html)).toBe(headSignature(HTML))
    expect(headSignature(HTML)).toContain('rel="canonical"')
    expect(headSignature(HTML)).toContain('application/ld+json')
    expect(headSignature(HTML)).not.toContain('nonce')
  })

  it('head 的 SEO 内容改变时抛错；只改样式、预加载与脚本时不抛', () => {
    expect(() => assertSameHead(HTML, HTML.replace('rel="modulepreload"', 'rel="x"'))).not.toThrow()
    for (const changed of [
      HTML.replace(
        'https://product.ezarouter.cc/"/><link rel="alternate"',
        'https://product.ezarouter.cc/x"/><link rel="alternate"',
      ),
      HTML.replace('<title>Home | product-res</title>', ''),
      HTML.replace('{"@type":"Organization"}', '{}'),
      HTML.replace('<meta name="description" content="Desc"/>', ''),
    ])
      expect(() => assertSameHead(HTML, changed)).toThrow(/head/)
  })

  it('类名中的字符引用（Tailwind 任意变体）解码后参与匹配，相关规则不被误删', async () => {
    const html = HTML.replace(
      '<main class="hero">',
      '<main class="hero"><div class="[&amp;_a]:underline [body:has([data-site-footer])_&amp;]:hidden content-[&#x27;x&#x27;]"><a>x</a></div><footer data-site-footer="true"></footer>',
    )
    const css = [
      '.\\[\\&_a\\]\\:underline a{text-decoration-line:underline}',
      'body:has([data-site-footer]) .\\[body\\:has\\(\\[data-site-footer\\]\\)_\\&\\]\\:hidden{display:none}',
      ".content-\\[\\'x\\'\\]{content:'x'}",
      '.unused{color:red}',
    ].join('')
    const inline = (await optimizeHtml(html, { criticalCss: 'used' }, async () => css)).html.match(
      /<style>([\s\S]*?)<\/style>/,
    )?.[1]
    expect(inline).toContain('text-decoration-line:underline')
    expect(inline).toContain('display:none')
    expect(inline).toContain("content:'x'")
    expect(inline).not.toContain('.unused')
    // 交付的 HTML 保持原样
    expect(decodeClassAttributes('<p class="a &amp; b" title="&amp;">')).toBe(
      '<p class="a & b" title="&amp;">',
    )
  })

  it('beasties 求不了值的选择器：类名都在本页时保留（divide-y 的 :where 组合）', async () => {
    const html = HTML.replace(
      '<main class="hero">',
      '<main class="hero"><div class="divide-y"><p>a</p><p>b</p></div>',
    )
    const css = [
      ':where(.divide-y>:not(:last-child)){border-bottom-width:1px}',
      ':where(.space-y-4>:not(:last-child)){margin-block-end:1rem}',
    ].join('')
    const inline = (await optimizeHtml(html, { criticalCss: 'used' }, async () => css)).html.match(
      /<style>([\s\S]*?)<\/style>/,
    )?.[1]
    expect(inline).toContain('divide-y')
    expect(inline).not.toContain('space-y-4')
  })

  it('选择器类名去转义与页面类名收集', () => {
    expect(selectorClasses('.\\[\\&_a\\]\\:underline a')).toEqual(['[&_a]:underline'])
    expect(selectorClasses('.\\32 xl\\:p-4:hover')).toEqual(['2xl:p-4'])
    expect(selectorClasses(':where(.group\\/item:hover) .py-0\\.5')).toEqual([
      'group/item',
      'py-0.5',
    ])
    expect(selectorClasses('[data-x] a')).toEqual([])
    expect([...documentClasses('<a class=" a  b"></a><p class="c"></p>')]).toEqual(['a', 'b', 'c'])
  })

  it('样式表含 </style> 时拒绝内联', async () => {
    await expect(optimizeHtml(HTML, {}, async () => 'a{}</style>')).rejects.toThrow(/<\/style>/)
  })

  it('加载器：观察首帧、load 与 3 秒兜底，转义 <', () => {
    const loader = afterPaintLoader({ styles: ['/assets/a.css'], scripts: ['/assets/</x.js'] })
    expect(loader).toContain("type:'paint',buffered:true")
    expect(loader).toContain('first-contentful-paint')
    // load 只在不支持 paint 观察时使用：小页面的 load 可能早于首帧
    expect(loader).toContain("supportedEntryTypes.indexOf('paint')>=0")
    expect(loader).toMatch(
      /\}else if\(d\.readyState==='complete'\)soon\(\);else addEventListener\('load',soon\)/,
    )
    expect(loader).toContain('setTimeout(run,3000)')
    expect(loader).not.toContain('</x.js')
  })

  it('brand.css 覆盖 --font-sans 的判断忽略注释', () => {
    expect(brandOverridesFontSans(':root{--font-sans:"Brand",sans-serif}')).toBe(true)
    expect(brandOverridesFontSans('/* :root { --font-sans: x } */ :root{--primary:red}')).toBe(
      false,
    )
    expect(brandOverridesFontSans(':root{--font-serif:x}')).toBe(false)
  })
})

describe('关键样式保留规则（衍生项目反馈，0.5.5）', () => {
  const page = (htmlAttrs: string) =>
    `<!DOCTYPE html><html ${htmlAttrs}><head></head><body><main class="hero"><input class="field" placeholder="x"/></main></body></html>`
  const css = [
    ':root{--brand:#000}',
    ':root[data-site=east]{--brand:#c00}',
    ':root[data-site="west"]{--brand:#00c}',
    ':root[data-site]:lang(ko){--font:Pretendard}',
    'html[data-site=east] .hero{padding:1px}',
    '.hero{display:grid}',
    '.field::placeholder{color:gray}',
    '::file-selector-button{border:0}',
    '.unused::after{content:""}',
  ].join('')

  it('rootAttributes 读出 <html> 属性', () => {
    const attrs = rootAttributes(page('lang="ko" data-site=east class="x" hidden'))
    expect(Object.fromEntries(attrs)).toEqual({
      lang: 'ko',
      'data-site': 'east',
      class: 'x',
      hidden: '',
    })
  })

  it('RootAttributeRule 只保留条件全部与本页 <html> 相符的根元素规则', () => {
    const rule = new RootAttributeRule(rootAttributes(page('lang="ko-KR" data-site="east"')))
    expect(rule.test(':root[data-site=east]')).toBe(true)
    expect(rule.test(':root[data-site]:lang(ko)')).toBe(true)
    expect(rule.test('html[data-site="east"] .hero')).toBe(true)
    expect(rule.test(':root[data-site=west]')).toBe(false)
    expect(rule.test(':root:lang(en)')).toBe(false)
    expect(rule.test(':root')).toBe(false)
    expect(rule.test('.hero[data-site=east]')).toBe(false)
    // 解析不了或未核对的条件不保留（评审：避免别站 token 进入首帧）
    expect(rule.test(':root[lang=ko][data-site^=w]')).toBe(false)
    expect(rule.test(':root[data-site=east i]')).toBe(false)
    expect(rule.test(':root.theme-x[data-site=east]')).toBe(false)
    expect(rule.test(':root[data-site=east]:not([lang=ko])')).toBe(false)
    expect(rule.test(':root[data-site=east]>body')).toBe(true)
  })

  it('usedCss 保留本站根元素 token 与伪元素规则，丢弃别站与未用规则', async () => {
    const out = await usedCss(page('lang="ko" data-site="east"'), css)
    expect(out).toContain(':root[data-site=east]')
    expect(out).toContain(':root[data-site]:lang(ko)')
    expect(out).toContain('::placeholder')
    expect(out).toContain('::file-selector-button')
    expect(out).not.toContain('data-site="west"')
    expect(out).not.toContain('.unused')
  })

  it('optimizeHtml 接受项目追加的保留规则', async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="/assets/app-1.css"/></head><body><p class="a">x</p></body></html>`
    const read = async () => '.a{color:red}.js-only{color:blue}'
    const base = await optimizeHtml(html, { criticalCss: 'used' }, read)
    expect(base.html).not.toContain('.js-only')
    const extra = await optimizeHtml(html, { criticalCss: 'used' }, read, {
      allowRules: [/\.js-only/],
    })
    expect(extra.html).toContain('.js-only')
  })
})
