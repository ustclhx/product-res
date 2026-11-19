// 构建后处理预渲染页面（LCP 优化，docs/runbooks/launch-v1.md 2.3；openspec add-marketing-critical-path）。
// 样式表是阻塞首绘的请求，首屏文字要等它下载完成；与同时加载的脚本抢带宽时可慢 1 秒以上，因此内联进 HTML。
// 模板配置 marketing.performance（构建时写到 dist/.build/marketing-performance.json）决定：
// - criticalCss：full 内联整份；used 只内联该页用到的规则，完整样式表首帧后加载；
// - hydration：after-paint 时去掉 modulepreload，水合入口首帧后加载。
// 样式表文件保留不删：Worker 动态渲染的页面仍引用它。
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { projectCriticalCssAllowRules } from './critical-css.project.mjs'
import {
  brandOverridesFontSans,
  DEFAULT_ALLOW_RULES,
  DEFAULT_PERFORMANCE,
  optimizeHtml,
} from './marketing-html.mjs'

const dist = new URL('../dist/', import.meta.url).pathname
const root = join(dist, 'client')
const optionsFile = join(dist, '.build/marketing-performance.json')
// 配置文件缺失（直接对旧产物运行本脚本）时按默认值处理，与改动前一致
const performance = existsSync(optionsFile)
  ? { ...DEFAULT_PERFORMANCE, ...JSON.parse(readFileSync(optionsFile, 'utf8')) }
  : DEFAULT_PERFORMANCE
if (performance.prerender === false) {
  console.log('inline-critical-css: 本次构建未启用营销预渲染，跳过关键 CSS 内联')
  process.exit(0)
}
const allowRules = [...projectCriticalCssAllowRules(DEFAULT_ALLOW_RULES)]

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* htmlFiles(path)
    else if (entry.name.endsWith('.html')) yield path
  }
}

const sheets = new Map()
const readCss = async (href) => {
  if (!sheets.has(href)) sheets.set(href, await readFile(join(root, href), 'utf8'))
  return sheets.get(href)
}

let pages = 0
let inlined = 0
for await (const file of htmlFiles(root)) {
  const html = await readFile(file, 'utf8')
  let result
  try {
    result = await optimizeHtml(html, performance, readCss, { allowRules })
  } catch (error) {
    throw new Error(`${relative(root, file)}: ${error instanceof Error ? error.message : error}`)
  }
  if (result.html === html) continue
  await writeFile(file, result.html)
  inlined += result.inlined
  pages += 1
}

if (pages === 0) throw new Error('未找到可内联样式表的 HTML，检查构建产物')
console.log(
  `inline-critical-css: ${inlined} 处内联（criticalCss=${performance.criticalCss}，hydration=${performance.hydration}），${pages} 个 HTML（${relative(process.cwd(), root)}）`,
)

// 品牌层换了正文字体、首页却仍预加载 Inter：首帧前白白下载约 71KB（fonts.project.ts 可清空或替换）
const brand = new URL('../src/styles/brand.css', import.meta.url)
const home = join(root, 'index.html')
if (
  existsSync(brand) &&
  existsSync(home) &&
  brandOverridesFontSans(readFileSync(brand, 'utf8')) &&
  /<link\b[^>]*rel="preload"[^>]*inter-latin[^>]*>/.test(readFileSync(home, 'utf8'))
)
  console.warn(
    'inline-critical-css: brand.css 覆盖了 --font-sans，但首页仍预加载 Inter；营销页不用 Inter 时在 apps/web/src/features/theme/fonts.project.ts 返回 []',
  )
