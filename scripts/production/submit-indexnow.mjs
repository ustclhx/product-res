import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sitemapUrls } from '../staging/check-site-isolation.mjs'

/**
 * 生产发布后把站点地图中的本站地址提交给 IndexNow（docs/analytics.md）。
 * 收录加速不是发布条件：未配置时跳过，失败只告警，始终不阻断发布。
 */
const ENDPOINT = 'https://api.indexnow.org/indexnow'
const MAX_URLS = 10_000

export async function submitIndexNow({ baseUrl, key, fetchImpl = fetch, write = console.error }) {
  if (!key) {
    write('indexnow: INDEXNOW_KEY not set, skipped')
    return { status: 'skipped' }
  }
  try {
    const { origin, host } = new URL(baseUrl)
    const sameSite = (url) => URL.canParse(url) && new URL(url).origin === origin
    const read = async (url) => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`sitemap status ${response.status}`)
      return sitemapUrls(await response.text())
    }
    // 多语言站点的 sitemap.xml 是索引，提交的应是子地图里的页面而不是子地图本身。
    const root = await read(`${origin}/sitemap.xml`)
    const pages = root.index
      ? (await Promise.all(root.locs.filter(sameSite).map(read))).flatMap((child) => child.locs)
      : root.locs
    const urlList = [...new Set(pages.filter(sameSite))].slice(0, MAX_URLS)
    if (!urlList.length) throw new Error('sitemap has no URLs on this site')
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `${origin}/indexnow.txt`, urlList }),
    })
    if (!response.ok) throw new Error(`indexnow status ${response.status}`)
    write(`indexnow: submitted ${urlList.length} URLs`)
    return { status: 'submitted', count: urlList.length }
  } catch (error) {
    // 不输出请求体，避免密钥进入日志。
    write(`warning: indexnow failed: ${error instanceof Error ? error.message : 'unknown'}`)
    return { status: 'failed' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await submitIndexNow({ baseUrl: process.argv[2], key: process.env.INDEXNOW_KEY })
}
