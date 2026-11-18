import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  parseJsonc,
  parsePlausibleSites,
  resolvePlausibleSite,
} from '../production/check-wrangler-envs.mjs'

/**
 * 发布门禁（docs/analytics.md §门禁）：公开 SEO / 站点地图 / canonical / 分析脚本
 * 必须指向当前环境自己的 APP_URL 与 Plausible site，防止串到衍生站或生产站。
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export function expectedFromWrangler(environment, root = repoRoot) {
  const config = parseJsonc(readFileSync(resolve(root, 'apps/web/wrangler.jsonc'), 'utf8'))
  const vars = config.env?.[environment]?.vars
  if (!vars?.APP_URL) throw new Error(`apps/web/wrangler.jsonc: env.${environment}.vars.APP_URL`)
  const template = readFileSync(resolve(root, 'template.config.ts'), 'utf8')
  // 变量留着但模板选了别的工具或关闭时，页面不会有 Plausible 脚本，门禁也不能要求它。
  const analytics = /features["']?\s*:\s*\{[^}]*\banalytics["']?\s*:\s*['"]?(\w+)/.exec(
    template,
  )?.[1]
  const plausible = analytics === undefined || analytics === 'plausible'
  return {
    marketing: !/marketing:\s*\{\s*enabled:\s*false/.test(template),
    appUrl: vars.APP_URL,
    plausibleDomain: plausible ? (vars.PLAUSIBLE_DOMAIN ?? '') : '',
    plausibleHost: plausible ? (vars.PLAUSIBLE_HOST ?? '') : '',
    plausibleSites: plausible ? (vars.PLAUSIBLE_SITES ?? '') : '',
  }
}

function attributes(tag) {
  const result = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g))
    result[(match[1] ?? match[3]).toLowerCase()] = (match[2] ?? match[4]).replaceAll('&amp;', '&')
  return result
}

const tags = (html, name) =>
  (html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []).map(attributes)

/** 解析 HTML 中需要校验归属的地址与分析脚本；只看 head，正文外链不属于串扰范围。 */
export function inspectHtml(html) {
  const head = html.split(/<\/head>/i)[0] ?? ''
  const links = tags(head, 'link')
  const metas = tags(head, 'meta')
  return {
    urls: [
      ...links
        .filter((link) => link.rel === 'canonical' || link.rel === 'alternate')
        .map((link) => link.href),
      ...metas.filter((meta) => meta.property === 'og:url').map((meta) => meta.content),
    ].filter(Boolean),
    canonical: links.find((link) => link.rel === 'canonical')?.href,
    icons: links.filter((link) => /\bicon\b/.test(link.rel ?? '')).map((link) => link.href),
    plausible: tags(head, 'script').filter(
      (script) => 'data-domain' in script || /plausible|\/js\/script\./.test(script.src ?? ''),
    ),
    // 多站页面的内联映射（apps/web features/analytics/head.ts），浏览器据此按访问域名插入脚本。
    plausibleConfig:
      /<script\b[^>]*\bid\s*=\s*["']product-res-plausible["'][^>]*>([\s\S]*?)<\/script>/i.exec(head)?.[1],
  }
}

export function sitemapUrls(xml) {
  return {
    index: /<sitemapindex\b/i.test(xml),
    locs: [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]),
    alternates: [...xml.matchAll(/<xhtml:link\b[^>]*\bhref="([^"]+)"/gi)].map((match) => match[1]),
  }
}

export async function checkSiteIsolation({
  baseUrl,
  appUrl,
  plausibleDomain = '',
  plausibleHost = '',
  plausibleSites = '',
  marketing = true,
  fetchImpl = fetch,
  write = console.error,
  retryDelayMs = 3_000,
}) {
  const problems = []
  const origin = new URL(appUrl).origin
  if (new URL(baseUrl).origin !== origin)
    problems.push(`deploy URL ${new URL(baseUrl).origin} differs from APP_URL ${origin}`)
  const base = baseUrl.replace(/\/$/, '')
  // 网络抖动不等于串扰：重试后仍失败才记为问题（状态 0），不让脚本崩溃。
  const get = async (url) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
      } catch {
        if (attempt >= 3) return new Response(null, { status: 599 })
        await sleep(retryDelayMs)
      }
    }
  }
  const own = (where, url) => {
    if (!URL.canParse(url, origin) || new URL(url, origin).origin !== origin)
      problems.push(`${where}: ${url} is not on ${origin}`)
  }

  const seen = new Set()
  const sitemap = async (url) => {
    if (seen.has(url)) return
    seen.add(url)
    const response = await get(url)
    if (response.status !== 200) {
      problems.push(`sitemap ${url}: status ${response.status}`)
      return
    }
    const { index, locs, alternates } = sitemapUrls(await response.text())
    if (!locs.length) problems.push(`sitemap ${url}: no <loc>`)
    for (const loc of [...locs, ...alternates]) own(`sitemap ${url}`, loc)
    // 子地图同样要能打开；他站子地图已在上面报错，不再跟随。
    if (index)
      for (const loc of locs)
        if (URL.canParse(loc) && new URL(loc).origin === origin)
          await sitemap(`${base}${new URL(loc).pathname}`)
  }
  // 关闭营销站时没有 sitemap / robots / 首页，只校验登录页的脚本归属与 favicon。
  if (marketing) {
    await sitemap(`${base}/sitemap.xml`)
    const robots = await get(`${base}/robots.txt`)
    if (robots.status !== 200) problems.push(`robots.txt: status ${robots.status}`)
    else
      for (const match of (await robots.text()).matchAll(/^sitemap:\s*(\S+)/gim))
        own('robots.txt', match[1])
  }

  const entry = marketing ? '/' : '/login'
  const home = await get(`${base}${entry}`)
  if (home.status !== 200) problems.push(`${entry}: status ${home.status}`)
  else {
    const html = inspectHtml(await home.text())
    if (marketing && !html.canonical) problems.push('/: canonical missing')
    for (const url of html.urls) own('/ head', url)
    for (const icon of html.icons) {
      own('/ icon', icon)
      if (URL.canParse(icon, origin) && new URL(icon, origin).origin === origin) {
        const response = await get(`${base}${new URL(icon, origin).pathname}`)
        if (response.status !== 200) problems.push(`icon ${icon}: status ${response.status}`)
      }
    }
    // 期望的 site 按被检查地址的访问域名在映射中查找，未登记时取兜底 PLAUSIBLE_DOMAIN。
    const parsed = parsePlausibleSites(plausibleSites)
    if (parsed.error) problems.push(`PLAUSIBLE_SITES ${parsed.error}`)
    const multi = Object.keys(parsed.sites ?? {}).length > 0
    const hostname = new URL(baseUrl).hostname
    const expected = plausibleHost
      ? resolvePlausibleSite(parsed.sites, plausibleDomain, hostname)
      : ''
    if (!expected && (html.plausible.length || html.plausibleConfig !== undefined))
      problems.push(`/: analytics script present but this environment has no Plausible site`)
    if (expected && !multi) {
      if (html.plausible.length !== 1)
        problems.push(`/: expected one Plausible script, found ${html.plausible.length}`)
      if (html.plausibleConfig !== undefined)
        problems.push('/: unexpected multi-site Plausible config on a single-site environment')
      for (const script of html.plausible) {
        if (script['data-domain'] !== expected)
          problems.push(`/: Plausible site ${script['data-domain']} is not ${expected}`)
        if (
          !URL.canParse(script.src ?? '') ||
          new URL(script.src).origin !== new URL(plausibleHost).origin
        )
          problems.push(`/: Plausible script ${script.src} is not on ${plausibleHost}`)
      }
    }
    if (expected && multi) {
      // 多站页面不带静态 data-domain 脚本，校验内联映射对本访问域名解析出的 site 与脚本地址。
      if (html.plausible.length)
        problems.push(`/: expected no static Plausible script, found ${html.plausible.length}`)
      let config
      try {
        config = JSON.parse(html.plausibleConfig ?? '')
      } catch {
        problems.push('/: multi-site Plausible config missing or invalid')
      }
      if (config) {
        const site = resolvePlausibleSite(config.sites ?? {}, config.fallback ?? '', hostname)
        if (site !== expected)
          problems.push(`/: Plausible site for ${hostname} is ${site || '(none)'}, not ${expected}`)
        if (
          !URL.canParse(config.scriptUrl ?? '') ||
          new URL(config.scriptUrl).origin !== new URL(plausibleHost).origin
        )
          problems.push(`/: Plausible script ${config.scriptUrl} is not on ${plausibleHost}`)
      }
    }
  }

  // 关闭营销站的项目没有 llms.txt；存在时内容必须指向本站。
  const llms = await get(`${base}/llms.txt`)
  if (llms.status === 200)
    for (const match of (await llms.text()).matchAll(/\]\((https?:[^)\s]+)\)/g))
      own('llms.txt', match[1])
  else if (llms.status !== 404) problems.push(`llms.txt: status ${llms.status}`)

  // 占位文案不算串扰，只提示：模板自身的生产环境也可能尚未配置支持邮箱。
  const privacy = await get(`${base}/legal/privacy`)
  if (privacy.status === 200 && /support@example\.com/.test(await privacy.text()))
    write('warning: legal page still shows the template support email')

  const favicon = await get(`${base}/favicon.ico`)
  if (favicon.status !== 200) problems.push(`/favicon.ico: status ${favicon.status}`)

  for (const line of problems) write(line)
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [environment, baseUrl] = process.argv.slice(2)
  if (!environment || !baseUrl) {
    console.error('usage: check-site-isolation.mjs <staging|production> <base-url>')
    process.exit(2)
  }
  const problems = await checkSiteIsolation({ baseUrl, ...expectedFromWrangler(environment) })
  process.exitCode = problems.length ? 1 : 0
}
