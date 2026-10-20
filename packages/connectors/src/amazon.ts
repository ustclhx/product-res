import type { EntityKey, Marketplace, NormalizedCategory } from '@product-res/datasources'

/**
 * Amazon 页面文本的解析（DataForSEO 与 SerpApi 共用）。页面字段随 Amazon 改版而变化，
 * 解析失败一律返回缺失（undefined / 空数组），不补零、不猜测。
 */

export interface BestSellersRank {
  readonly rank: number
  readonly category: string
}

/**
 * 解析 "Best Sellers Rank" 文本：
 * "#19,248 in Clothing, Shoes & Jewelry ( See Top 100 in ... )  #67 in Men's Fashion Sneakers"
 * → [{ 19248, 'Clothing, Shoes & Jewelry' }, { 67, "Men's Fashion Sneakers" }]。第一个为主类目。
 */
export function parseBestSellersRank(text: string | null | undefined): BestSellersRank[] {
  if (!text) return []
  const ranks: BestSellersRank[] = []
  const pattern = /#\s*([\d,]+)\s+in\s+([^#(]+?)\s*(?:\([^)]*\))?\s*(?=#|$)/g
  for (const match of text.matchAll(pattern)) {
    const rank = Number((match[1] as string).replace(/,/g, ''))
    const category = (match[2] as string).trim()
    if (Number.isInteger(rank) && rank > 0 && category) ranks.push({ rank, category })
  }
  return ranks
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const isoDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined
  return date.toISOString().slice(0, 10)
}

/**
 * 解析 Amazon 详情页日期（Date First Available 等）："November 26, 2011" / "Nov 26, 2011" /
 * "26 Nov. 2011" / "2011-11-26" → "2011-11-26"；无法识别返回 undefined。
 */
export function parseAmazonDate(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const value = text.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1
  const us = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(value)
  if (us && monthOf(us[1] as string) > 0)
    return isoDate(Number(us[3]), monthOf(us[1] as string), Number(us[2]))
  const eu = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/.exec(value)
  if (eu && monthOf(eu[2] as string) > 0)
    return isoDate(Number(eu[3]), monthOf(eu[2] as string), Number(eu[1]))
  return undefined
}

/**
 * DataForSEO 详情的 `details` 纯文本 → 键值（"Key\n:\nValue" 形式）；"Best Sellers Rank: ..."
 * 这类同一行带冒号的条目单独解析。`product_information` 有结构化区块时优先用它。
 */
export function parseDetailsText(text: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!text) return result
  const lines = text.split('\n').map((l) => l.trim())
  for (let i = 1; i + 1 < lines.length; i++) {
    if (lines[i] !== ':') continue
    const key = (lines[i - 1] as string).replace(/^Product details\s+/i, '').trim()
    const value = (lines[i + 1] as string).trim()
    if (key && value) result[key] = value
  }
  for (const line of lines) {
    const inline = /^(Best Sellers Rank|Date First Available|Customer Reviews):\s*(.+)$/i.exec(line)
    if (inline && !result[inline[1] as string])
      result[inline[1] as string] = (inline[2] as string).trim()
  }
  return result
}

/** "Visit the Skechers Store" → "Skechers"；其他形式原样返回（去空白） */
export function brandFromByline(byline: string | null | undefined): string | undefined {
  if (!byline) return undefined
  const store = /^Visit the (.+?) Store$/i.exec(byline.trim())
  if (store) return (store[1] as string).trim()
  const brand = /^Brand:\s*(.+)$/i.exec(byline.trim())
  return brand ? (brand[1] as string).trim() : byline.trim() || undefined
}

/** 商品页规范链接（去掉 ref 与跟踪参数） */
export const amazonProductUrl = (marketplace: Marketplace, asin: string) =>
  `https://www.${AMAZON_DOMAIN[marketplace] ?? 'amazon.com'}/dp/${asin}`

export const AMAZON_DOMAIN: Partial<Record<Marketplace, string>> = {
  'amazon-us': 'amazon.com',
  'amazon-uk': 'amazon.co.uk',
  'amazon-de': 'amazon.de',
  'amazon-jp': 'amazon.co.jp',
  'amazon-ca': 'amazon.ca',
}

export const productKey = (marketplace: Marketplace, asin: string): EntityKey => ({
  type: 'product',
  marketplace,
  platformId: asin,
})

/** 面包屑（名称 + 节点 ID，根在前）→ 类目节点；任一节点缺 ID 时到此为止 */
export function breadcrumbCategories(
  marketplace: Marketplace,
  crumbs: readonly {
    readonly name?: string | null | undefined
    readonly node?: string | null | undefined
  }[],
): NormalizedCategory[] {
  const nodes: NormalizedCategory[] = []
  const names: string[] = []
  let parentId: string | null = null
  for (const crumb of crumbs) {
    if (!crumb.name || !crumb.node) break
    names.push(crumb.name)
    nodes.push({
      marketplace,
      categoryId: crumb.node,
      name: crumb.name,
      parentId,
      // 面包屑只说明路径，不说明是否叶子
      leaf: false,
      path: names.join(' > '),
      treeVersion: 'amazon-breadcrumb',
    })
    parentId = crumb.node
  }
  return nodes
}

/** 从类目链接中取节点 ID：...?node=7141123011 */
export function nodeFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return /[?&]node=(\d+)/.exec(url)?.[1]
}

/** 从卖家链接中取卖家 ID：...?seller=AH1YFAUS3NHX2 / me=... */
export function sellerIdFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return /[?&](?:seller|me)=([A-Z0-9]+)/i.exec(url)?.[1]
}
