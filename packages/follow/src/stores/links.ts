/**
 * 店铺链接解析（add-accuracy-store-tracking design D4，specs/store-tracking「店铺池」）。
 * 纯函数：只认表中列出的链接形式，无法识别时返回明确原因，不猜测。
 *
 * | 平台 | 链接形式 |
 * |---|---|
 * | eBay | `ebay.com/str/<store>`、`ebay.com/usr/<user>`、带 `_ssn=<user>` 的搜索链接 |
 * | Amazon | 带 `seller=<ID>` 或 `me=<ID>` 的链接（含 `/sp?seller=<ID>`） |
 */

export type StoreLinkPlatform = 'ebay' | 'amazon'

export type StoreLinkForm = 'ebay-store' | 'ebay-user' | 'ebay-search' | 'amazon-seller'

export type StoreLinkResult =
  | {
      readonly ok: true
      readonly platform: StoreLinkPlatform
      /** 平台站点，取值同 marketplace_product.marketplace */
      readonly marketplace: string
      /** eBay 店铺名或用户名；Amazon 卖家 ID（大写） */
      readonly sellerKey: string
      readonly form: StoreLinkForm
      /** 规范化后的店铺链接 */
      readonly url: string
    }
  | {
      readonly ok: false
      /**
       * - empty：没有输入
       * - invalid-url：不是链接
       * - unsupported-site：不是已支持的 eBay / Amazon 站点
       * - not-a-store：是平台链接，但不是店铺链接（如商品详情页）
       */
      readonly reason: 'empty' | 'invalid-url' | 'unsupported-site' | 'not-a-store'
    }

/** 目前采集只覆盖 eBay 美国站；其他 eBay 站点明确拒绝 */
const EBAY_HOSTS: Readonly<Record<string, string>> = { 'ebay.com': 'ebay-us' }

const AMAZON_HOSTS: Readonly<Record<string, string>> = {
  'amazon.com': 'amazon-us',
  'amazon.co.uk': 'amazon-uk',
  'amazon.de': 'amazon-de',
  'amazon.co.jp': 'amazon-jp',
  'amazon.ca': 'amazon-ca',
}

const AMAZON_ORIGINS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(AMAZON_HOSTS).map(([host, marketplace]) => [marketplace, `https://www.${host}`]),
)

/** eBay 用户名 / 店铺名：字母数字与 . _ -（店铺路径可能带 URL 编码的空格，解码后保留） */
const EBAY_KEY = /^[A-Za-z0-9][A-Za-z0-9._\- ]{0,79}$/
/** Amazon 卖家 ID（Merchant Token）：大写字母与数字 */
const AMAZON_SELLER = /^[A-Z0-9]{6,20}$/

/** 去掉 www. / m. 等前缀后的注册域 */
function baseHost(hostname: string, known: Readonly<Record<string, string>>) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  for (const domain of Object.keys(known))
    if (host === domain || host.endsWith(`.${domain}`)) return domain
  return undefined
}

function toUrl(input: string): URL | undefined {
  const text = input.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (!url.hostname.includes('.')) return undefined
    return url
  } catch {
    return undefined
  }
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' ')).trim()
  } catch {
    return ''
  }
}

function parseEbay(url: URL, marketplace: string): StoreLinkResult {
  const segments = url.pathname.split('/').filter(Boolean)
  const head = segments[0]?.toLowerCase()
  if ((head === 'str' || head === 'usr') && segments[1]) {
    const key = decodeSegment(segments[1])
    if (!EBAY_KEY.test(key)) return { ok: false, reason: 'not-a-store' }
    return {
      ok: true,
      platform: 'ebay',
      marketplace,
      sellerKey: key,
      form: head === 'str' ? 'ebay-store' : 'ebay-user',
      url: `https://www.ebay.com/${head}/${encodeURIComponent(key)}`,
    }
  }
  const ssn = url.searchParams.get('_ssn')?.trim()
  if (ssn && EBAY_KEY.test(ssn))
    return {
      ok: true,
      platform: 'ebay',
      marketplace,
      sellerKey: ssn,
      form: 'ebay-search',
      url: `https://www.ebay.com/usr/${encodeURIComponent(ssn)}`,
    }
  return { ok: false, reason: 'not-a-store' }
}

function parseAmazon(url: URL, marketplace: string): StoreLinkResult {
  // 参数名大小写不敏感（部分分享链接写作 Seller=）
  let id: string | undefined
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase()
    if ((key === 'seller' || key === 'me') && value.trim()) {
      id = value.trim().toUpperCase()
      if (key === 'seller') break
    }
  }
  if (!id || !AMAZON_SELLER.test(id)) return { ok: false, reason: 'not-a-store' }
  return {
    ok: true,
    platform: 'amazon',
    marketplace,
    sellerKey: id,
    form: 'amazon-seller',
    url: `${AMAZON_ORIGINS[marketplace]}/sp?seller=${id}`,
  }
}

/** 解析店铺链接；无法识别时返回原因，调用方据此给出提示 */
export function parseStoreLink(input: string | null | undefined): StoreLinkResult {
  if (!input?.trim()) return { ok: false, reason: 'empty' }
  const url = toUrl(input)
  if (!url) return { ok: false, reason: 'invalid-url' }
  const ebay = baseHost(url.hostname, EBAY_HOSTS)
  if (ebay) return parseEbay(url, EBAY_HOSTS[ebay] as string)
  const amazon = baseHost(url.hostname, AMAZON_HOSTS)
  if (amazon) return parseAmazon(url, AMAZON_HOSTS[amazon] as string)
  return { ok: false, reason: 'unsupported-site' }
}

/** 失败原因的中文提示（服务端错误信息与页面共用） */
export const STORE_LINK_ERRORS: Readonly<
  Record<Exclude<StoreLinkResult, { ok: true }>['reason'], string>
> = {
  empty: '请粘贴店铺链接',
  'invalid-url': '这不是有效的链接',
  'unsupported-site': '只支持 eBay 美国站与 Amazon 店铺链接',
  'not-a-store':
    '无法识别店铺：请粘贴 eBay 店铺页（/str/ 或 /usr/）或 Amazon 卖家页（带 seller= 或 me= 参数）链接',
}
