import { ConnectorError, httpRequest } from '@product-res/datasources'

/**
 * eBay 店铺名 → 卖家用户名（add-accuracy-store-tracking design「实测修正 2026-10-23」）。
 * `/str/<店铺名>` 常与卖家用户名不同，而 Browse 的 `sellers:{}` 过滤只认用户名；
 * 店铺页 SSR 数据中带唯一的 `"username":"<seller>"`，据此解析。
 * 只请求 https://www.ebay.com，跳转只跟随同站的 /str/ 路径，其余（含验证码页）一律视为失败。
 */

export const EBAY_STORE_ORIGIN = 'https://www.ebay.com'

/** 与 links.ts 的 eBay 用户名规则一致：字母数字与 . _ - */
const EBAY_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const USERNAME_FIELD = /"username"\s*:\s*"([^"\\]{1,80})"/g
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const MAX_REDIRECTS = 2

export type EbayStoreResolution =
  | { readonly ok: true; readonly username: string }
  | {
      readonly ok: false
      /**
       * - not-found：页面里没有用户名字段
       * - ambiguous：出现多个不同用户名，不猜测
       * - blocked：被跳转到验证码或其他页面
       * - unreachable：超时、网络错误、非 2xx 或响应过大
       */
      readonly reason: 'not-found' | 'ambiguous' | 'blocked' | 'unreachable'
    }

/** 纯函数：从店铺页 HTML 中取唯一的卖家用户名 */
export function extractEbayStoreUsername(html: string): EbayStoreResolution {
  const names = new Set<string>()
  for (const match of html.matchAll(USERNAME_FIELD)) {
    const name = match[1] as string
    if (EBAY_USERNAME.test(name)) names.add(name)
  }
  if (names.size === 0) return { ok: false, reason: 'not-found' }
  if (names.size > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, username: [...names][0] as string }
}

/** 店铺页地址；只接受符合规则的店铺名，避免拼出其他路径 */
export function ebayStorePageUrl(storeName: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\- ]{0,79}$/.test(storeName)) return undefined
  return `${EBAY_STORE_ORIGIN}/str/${encodeURIComponent(storeName)}`
}

/** 同站 /str/ 跳转（如大小写规范化）才跟随；验证码与站外地址都返回 undefined */
function sameSiteStoreRedirect(location: string | null, base: string): string | undefined {
  if (!location) return undefined
  let next: URL
  try {
    next = new URL(location, base)
  } catch {
    return undefined
  }
  if (next.origin !== EBAY_STORE_ORIGIN || !next.pathname.toLowerCase().startsWith('/str/'))
    return undefined
  next.hash = ''
  return next.toString()
}

export async function resolveEbayStoreUsername(
  storeName: string,
  options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<EbayStoreResolution> {
  let url = ebayStorePageUrl(storeName)
  if (!url) return { ok: false, reason: 'not-found' }
  const fetchImpl = options.fetch ?? fetch
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Awaited<ReturnType<typeof httpRequest>>
    try {
      response = await httpRequest(fetchImpl, {
        url,
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'manual',
        timeoutMs: options.timeoutMs ?? 8_000,
        // 店铺页 SSR 体积约 1–2 MiB，留出余量
        maxBytes: 4 * 1024 * 1024,
      })
    } catch (error) {
      if (error instanceof ConnectorError) return { ok: false, reason: 'unreachable' }
      throw error
    }
    if (response.status >= 300 && response.status < 400) {
      const next = sameSiteStoreRedirect(response.headers.get('location'), url)
      if (!next) return { ok: false, reason: 'blocked' }
      url = next
      continue
    }
    return extractEbayStoreUsername(response.body)
  }
  return { ok: false, reason: 'blocked' }
}
