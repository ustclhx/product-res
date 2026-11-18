// 预渲染营销页的构建后处理（openspec add-marketing-critical-path design D3）。纯函数，便于单测；
// 读写文件由 inline-critical-css.mjs 负责。只改写 dist/client 下的预渲染 HTML，Worker 动态渲染的页面不经过这里。
import Beasties from 'beasties'

/** `marketing.performance` 的默认值：与改动前的构建输出一致 */
export const DEFAULT_PERFORMANCE = Object.freeze({
  hydration: 'eager',
  criticalCss: 'full',
  homeScriptGzipBudget: null,
})

// `<link rel="stylesheet" href="/assets/xxx.css">`，属性顺序不限，只处理本站 assets 下的样式表
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*>/g
const STYLESHEET_HREF = /\bhref="(\/assets\/[^"]+\.css)"/
const MODULE_PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*\/?>/g
// 水合入口：`<script type="module" async src="/assets/xxx.js" ...></script>`
const MODULE_SCRIPT = /<script\b[^>]*\btype="module"[^>]*><\/script>/g
const SCRIPT_SRC = /\bsrc="(\/assets\/[^"]+\.js)"/
const CRITICAL_MARK = 'data-product-res-critical'

/**
 * head 中与 SEO 和分享相关的内容：标题、meta（name / property / http-equiv / charset）、
 * canonical、alternate、图标、manifest 与 JSON-LD。忽略 nonce（每次构建不同，且静态页按哈希授权）。
 */
export function headSignature(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''
  const strip = (tag) => tag.replace(/\s+nonce="[^"]*"/g, '')
  const parts = [
    ...(head.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) ?? []),
    ...(head.match(/<meta\b[^>]*>/gi) ?? []),
    ...(head.match(
      /<link\b[^>]*\brel="(?:canonical|alternate|icon|apple-touch-icon|manifest)"[^>]*>/gi,
    ) ?? []),
    ...(head.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) ?? []),
  ]
  return parts.map(strip).join('\n')
}

/** 品牌层（brand.css，去掉注释后）是否覆盖了正文字体变量 */
export function brandOverridesFontSans(brandCss) {
  return /--font-sans\s*:/.test(brandCss.replace(/\/\*[\s\S]*?\*\//g, ''))
}

/** 样式表中的全部 @font-face 规则（构建产物已压缩，规则体内没有嵌套花括号） */
export function fontFaceRules(css) {
  return css.match(/@font-face\s*\{[^}]*\}/g) ?? []
}

/**
 * 首帧后加载器：见到 first-contentful-paint 后（下一个任务中）先追加样式表，再插入水合入口；
 * 只有不支持 paint 观察时才用 load 事件（小页面的 load 可能早于首帧），最晚 3 秒兜底。内联脚本由静态页 CSP 的脚本哈希授权，
 * 插入的同源资源由 `'self'` 授权。
 */
export function afterPaintLoader({ styles = [], scripts = [] }) {
  const list = (items) => JSON.stringify(items).replace(/</g, '\\u003c')
  return `<script>(function(){var d=document,done=0,css=${list(styles)},js=${list(scripts)};function run(){if(done)return;done=1;css.forEach(function(h){var l=d.createElement('link');l.rel='stylesheet';l.href=h;d.head.appendChild(l)});js.forEach(function(s){var e=d.createElement('script');e.type='module';e.src=s;d.head.appendChild(e)})}function soon(){setTimeout(run,0)}var P=window.PerformanceObserver;if(P&&P.supportedEntryTypes&&P.supportedEntryTypes.indexOf('paint')>=0){var o=new P(function(l){if(l.getEntriesByName('first-contentful-paint').length){o.disconnect();soon()}});o.observe({type:'paint',buffered:true})}else if(d.readyState==='complete')soon();else addEventListener('load',soon);setTimeout(run,3000)})()</script>`
}

/**
 * 无论是否匹配都保留的规则：
 * - `.dark`：深色模式类名由 head 内联脚本在首帧前写入 <html>，预渲染 DOM 中没有；
 * - `:has(`：beasties 无法静态求值，会整条丢弃，这类规则很少（模板约 3KB），全部保留；
 * - `::before` / `::after` 以外的伪元素（preflight 的 `::placeholder`、`::file-selector-button`、
 *   `::-webkit-*` 与滚动条工具类）：beasties 会整条丢弃，表单占位文字颜色等因此与完整样式不一致；体积很小，全部保留。
 * 另外 usedCss 总会保留「选择器中的类名全部出现在本页」（ClassTokenRule）与
 * 「根元素属性条件与本页 `<html>` 相符」（RootAttributeRule）的规则；项目可经 critical-css.project.mjs 追加。
 */
export const DEFAULT_ALLOW_RULES = [/\.dark\b/, /:has\(/, /::(?!before\b|after\b)[\w-]/]

const CLASS_TOKEN = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g

/** 选择器中的类名（去掉 CSS 转义）：`.\[\&_a\]\:underline` → `[&_a]:underline`，`.\32 xl\:p-4` → `2xl:p-4` */
export function selectorClasses(selector) {
  return [...selector.matchAll(CLASS_TOKEN)].map(([, token]) =>
    token.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, char) =>
      hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char,
    ),
  )
}

/** 页面上出现的全部类名（类属性须已解码） */
export function documentClasses(html) {
  const classes = new Set()
  for (const [, value] of html.matchAll(/\sclass="([^"]*)"/g))
    for (const name of value.split(/\s+/)) if (name) classes.add(name)
  return classes
}

/**
 * beasties 的 allowRules 只接受字符串或 RegExp：用 RegExp 子类承载判断。
 * beasties 求不了值的选择器（`:where(.divide-y>:not(:last-child))`、`:is(...)` 组合等）会被整条丢弃；
 * 只要选择器里的类名都在本页出现就保留，宁多勿漏（多保留的规则对首屏无影响，只多几个字节）。
 */
class ClassTokenRule extends RegExp {
  constructor(classes) {
    // 永不匹配的模式：若 beasties 改用 match / exec 而不调用 test，退化为不额外保留，而不是保留全部规则
    super('(?!)')
    this.classes = classes
  }

  test(selector) {
    const tokens = selectorClasses(selector)
    return tokens.length > 0 && tokens.every((token) => this.classes.has(token))
  }
}

/** 预渲染 HTML 中 `<html>` 标签的属性（名称小写，无值属性记为空串） */
export function rootAttributes(html) {
  const tag = html.match(/<html\b[^>]*>/i)?.[0] ?? ''
  const attrs = new Map()
  for (const [, name, dq, sq, bare] of tag
    .slice(5)
    .matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
    attrs.set(name.toLowerCase(), dq ?? sq ?? bare ?? '')
  return attrs
}

// 选择器开头的根元素复合选择器（`:root[data-site=east]`、`html[data-x]:lang(ko)`）：条件只允许属性与 `:lang()`，
// 之后必须是选择器结束或组合符；带类名、`:not()` 等其他条件的不在此保留（宁可随完整样式表到达，也不内联不该生效的 token）
const ROOT_COMPOUND = /^(?::root|html)((?:\[[^\]]*\]|:lang\([^)]*\))+)(?=$|[\s>+~])/
const ROOT_SEGMENT = /\[[^\]]*\]|:lang\([^)]*\)/g
const ROOT_ATTRIBUTE = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+)))?\s*\]$/
const ROOT_LANG = /^:lang\(\s*["']?([\w-]+)["']?\s*\)$/

/**
 * beasties 求值时不认 `<html>` 上的属性：`:root[data-site=east]`、`:root[data-site]:lang(ko)` 这类按根元素属性
 * 切换品牌 token 的规则会被整条丢弃，关键样式失去品牌色与字体变量（衍生项目 xuanxue 反馈，模板 0.5.5 吸收）。
 * 根元素复合选择器只由 `[a]`、`[a=v]`、`:lang(x)` 条件组成、且全部与本页 `<html>` 相符时保留；
 * 其他属性运算符（`^=`、`|=`、`i` 标志等）、类名与否定条件一律不在此保留（仍随完整样式表加载）。
 */
export class RootAttributeRule extends RegExp {
  constructor(attrs) {
    // 同 ClassTokenRule：永不匹配的模式，只经 test 判断
    super('(?!)')
    this.attrs = attrs
  }

  test(selector) {
    const compound = selector.trim().match(ROOT_COMPOUND)?.[1]
    if (!compound) return false
    return (compound.match(ROOT_SEGMENT) ?? []).every((segment) => {
      const lang = segment.match(ROOT_LANG)?.[1]
      if (lang) {
        const own = (this.attrs.get('lang') ?? '').toLowerCase()
        const want = lang.toLowerCase()
        return own === want || own.startsWith(`${want}-`)
      }
      const attribute = segment.match(ROOT_ATTRIBUTE)
      if (!attribute) return false
      const [, name, dq, sq, bare] = attribute
      const key = name.toLowerCase()
      if (!this.attrs.has(key)) return false
      const value = dq ?? sq ?? bare
      return value === undefined || this.attrs.get(key) === value
    })
  }
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }

/**
 * beasties 解析 HTML 时不解码属性里的字符引用：Tailwind 任意变体的类名（如 `[&_a]:underline`、
 * `[body:has([data-site-footer])_&]:hidden`、`content-['x']`）在 HTML 中写作 `&amp;`、`&#x27;`，
 * 与 CSS 选择器中的类名对不上，对应规则会被误删。只用于计算关键样式，交付的 HTML 不变。
 */
export function decodeClassAttributes(html) {
  return html.replace(/(\sclass=")([^"]*)(")/g, (_, open, value, close) => {
    const decoded = value.replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi,
      (entity, hex, dec, name) => {
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
        if (dec) return String.fromCodePoint(Number(dec))
        return ENTITIES[name.toLowerCase()] ?? entity
      },
    )
    // 解码出的双引号会提前结束属性：这类类名极少，保持原样（规则仍随完整样式表加载）
    return decoded.includes('"') ? `${open}${value}${close}` : `${open}${decoded}${close}`
  })
}

/**
 * 用 beasties 按该页 DOM 裁剪样式：只把结果中的 CSS 文本取回，HTML 仍用原文拼接，
 * 避免 beasties 重新序列化文档影响水合。
 * allowRules：默认见 DEFAULT_ALLOW_RULES；传入时整体替换（项目扩展由 critical-css.project.mjs 在默认值基础上增减）。
 */
export async function usedCss(html, css, { allowRules = DEFAULT_ALLOW_RULES } = {}) {
  // 外链样式表先去掉：beasties 只处理标记的内联样式，不去读取文件
  const decoded = decodeClassAttributes(html)
  const marked = decoded
    .replace(STYLESHEET, '')
    .replace(/<\/head>/i, () => `<style ${CRITICAL_MARK}>${css}</style></head>`)
  const beasties = new Beasties({
    path: '/nonexistent',
    reduceInlineStyles: true,
    preload: false,
    preloadFonts: false,
    inlineFonts: false,
    keyframes: 'critical',
    compress: false,
    pruneSource: false,
    logLevel: 'error',
    allowRules: [
      ...allowRules,
      new ClassTokenRule(documentClasses(decoded)),
      new RootAttributeRule(rootAttributes(decoded)),
    ],
  })
  const out = await beasties.process(marked)
  const match = out.match(new RegExp(`<style ${CRITICAL_MARK}[^>]*>([\\s\\S]*?)</style>`))
  return match?.[1] ?? ''
}

/**
 * 按 `marketing.performance` 改写一个预渲染 HTML。
 * - criticalCss full：整份样式表内联（改动前的行为）；used：只内联该页用到的规则并补回全部 @font-face，
 *   完整样式表由首帧后加载器追加。
 * - hydration after-paint：去掉 modulepreload，水合入口改由首帧后加载器插入。
 * 处理前后 head 的 SEO 内容必须一致，否则抛错。
 */
export async function optimizeHtml(html, performance, readCss, { allowRules } = {}) {
  const options = { ...DEFAULT_PERFORMANCE, ...performance }
  let out = html
  let inlined = 0
  const styles = []
  const scripts = []
  for (const [tag] of html.matchAll(STYLESHEET)) {
    const href = tag.match(STYLESHEET_HREF)?.[1]
    if (!href) continue
    inlined += 1
    const css = await readCss(href)
    if (css.includes('</style')) throw new Error(`${href} 含有 </style>，无法内联`)
    let inline = css
    if (options.criticalCss === 'used') {
      inline = `${fontFaceRules(css).join('')}${await usedCss(html, css, { allowRules })}`
      styles.push(href)
    }
    // 用函数替换，避免 CSS 中的 `$&`、`$'` 等被当作替换模式
    out = out.replace(tag, () => `<style>${inline}</style>`)
  }
  if (options.hydration === 'after-paint') {
    out = out.replace(MODULE_PRELOAD, '')
    out = out.replace(MODULE_SCRIPT, (tag) => {
      const src = tag.match(SCRIPT_SRC)?.[1]
      if (!src) return tag
      scripts.push(src)
      return ''
    })
  }
  // 关闭 JS 的访客：加载器不会运行，用 noscript 引入完整样式表（开启 JS 时 noscript 内容不解析、不发请求）
  if (styles.length) {
    const fallback = `<noscript>${styles.map((href) => `<link rel="stylesheet" href="${href}"/>`).join('')}</noscript>`
    out = out.replace(/<\/head>/i, () => `${fallback}</head>`)
  }
  if (styles.length || scripts.length) {
    const loader = afterPaintLoader({ styles, scripts })
    out = /<\/body>/i.test(out)
      ? out.replace(/<\/body>/i, () => `${loader}</body>`)
      : `${out}${loader}`
  }
  assertSameHead(html, out)
  return { html: out, inlined, styles, scripts }
}

/** 改写前后 head 的 SEO 内容必须一致 */
export function assertSameHead(before, after) {
  if (headSignature(after) !== headSignature(before))
    throw new Error(
      '构建后处理改变了 head 中的 SEO 内容（title / meta / canonical / alternate / JSON-LD）',
    )
}
