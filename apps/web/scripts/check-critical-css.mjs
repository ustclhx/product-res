// 关键样式视觉核对（openspec add-marketing-critical-path 4.1，验收用，不在 pnpm build 中运行）：
// 对预渲染页分别以「只有内联关键样式」（拦截完整样式表）和「完整样式」渲染，阻止水合脚本使两次都停在预渲染 DOM，
// 在手机与桌面宽度、浅色与深色下整页截图并逐字节比较。需要先 `pnpm build` 并启动 `vite preview`。
// 只拦截构建后处理延后的样式表（页面 <noscript> 回退中列出的那些）；项目在首帧后自行插入的样式表（如站点字体）
// 两次都正常加载，避免因字体不同误判（衍生项目 xuanxue 反馈，0.5.5）。
// 用法：node scripts/check-critical-css.mjs <base-url> [输出目录] [路径,…]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const [base = 'http://localhost:3000', out = 'test-results/critical-css', list] =
  process.argv.slice(2)
const paths = list ? list.split(',') : ['/', '/zh', '/blog', '/blog/welcome', '/legal/privacy']
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]
const schemes = ['light', 'dark']

/** 页面 <noscript> 回退中列出的样式表：即构建后处理延后、由首帧后加载器追加的完整样式表 */
function deferredStylesheets(html) {
  const hrefs = []
  for (const [, block] of html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/gi))
    for (const [, href] of block.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g))
      hrefs.push(href)
  return hrefs
}

/**
 * 经 Chromium 取页面原始 HTML：Node 的 fetch 解析 `*.localhost` 走系统 DNS，
 * 在使用 fake-IP 代理的机器上会解析到代理地址而失败，Chromium 固定解析到回环地址
 */
async function pageHtml(browser, url) {
  const page = await browser.newPage()
  await page.route(/\/assets\//, (route) => route.abort())
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  const html = (await response?.text()) ?? ''
  await page.close()
  return html
}

/** 截图文件名：保留各语言的字母与数字（CJK 路径不再塌缩成同名），其余字符换成下划线 */
function shotName(path) {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {}
  return decoded.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '') || 'home'
}

async function shot(browser, url, viewport, colorScheme, fullCss, deferred) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' })
  const page = await context.newPage()
  // 两次都不水合：比较的只是样式
  await page.route(/\/assets\/.*\.js$/, (route) => route.abort())
  if (!fullCss)
    await page.route(
      (target) => deferred.includes(target.pathname),
      (route) => route.abort(),
    )
  const sheets = []
  page.on('requestfinished', (request) => {
    if (deferred.includes(new URL(request.url()).pathname)) sheets.push(request.url())
  })
  // networkidle：等项目在首帧后插入的样式表与字体也加载完
  await page.goto(url, { waitUntil: 'networkidle' })
  // 加载器在首帧后追加完整样式表：等它完成，再等字体
  if (fullCss)
    await page.waitForFunction(
      (hrefs) =>
        hrefs.every((href) =>
          [...document.styleSheets].some((sheet) => sheet.href?.endsWith(href)),
        ),
      deferred,
    )
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  const image = await page.screenshot({ fullPage: true, animations: 'disabled' })
  await context.close()
  return { image, sheets }
}

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const failures = []
let compared = 0
for (const path of paths)
  for (const viewport of viewports)
    for (const scheme of schemes) {
      const url = new URL(path, base).href
      const deferred = deferredStylesheets(await pageHtml(browser, url))
      if (deferred.length === 0) {
        failures.push(
          `${path}: 页面没有延后的样式表（criticalCss 不是 'used'，或该页不是预渲染页）`,
        )
        continue
      }
      const critical = await shot(browser, url, viewport, scheme, false, deferred)
      const full = await shot(browser, url, viewport, scheme, true, deferred)
      if (full.sheets.length === 0)
        failures.push(`${path} ${viewport.name} ${scheme}: 完整样式表未加载`)
      const name = `${shotName(path)}-${viewport.name}-${scheme}`
      compared += 1
      if (!critical.image.equals(full.image)) {
        writeFileSync(join(out, `${name}.critical.png`), critical.image)
        writeFileSync(join(out, `${name}.full.png`), full.image)
        failures.push(`${path} ${viewport.name} ${scheme}: 关键样式与完整样式截图不一致`)
      }
    }
await browser.close()
console.log(`critical-css 视觉核对：${compared} 组，${failures.length} 组不一致`)
for (const failure of failures) console.error(`  - ${failure}`)
if (failures.length) process.exitCode = 1
