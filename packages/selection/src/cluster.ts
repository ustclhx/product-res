import type { Marketplace } from '@product-res/datasources'

/**
 * 商品簇归并（design D3）：平台 ID → GTIN/UPC/ePID → 标题相似（同类目）。
 * 簇按站点划分，跨站点同款只作为簇属性（crossMarketplaceLinks），信号仍按平台分别计算。
 * 标题向量与图片相似需要 AI/向量依赖，本期不做；策略名预留 'similarity'。
 */

export type MergeMethod = 'platform-id' | 'gtin' | 'title' | 'similarity' | 'seed' | 'manual'

export const GTIN_CONFIDENCE = 0.95
export const TITLE_THRESHOLD = 0.6

export interface ClusterProduct {
  readonly marketplace: Marketplace
  readonly platformId: string
  readonly title?: string | undefined
  readonly brand?: string | undefined
  /** GTIN / UPC / EAN / ePID */
  readonly gtin?: string | undefined
  readonly categoryId?: string | undefined
}

export interface ClusterMember {
  readonly clusterId: string
  /** productKey(product) */
  readonly productKey: string
  readonly method: MergeMethod
  readonly confidence: number
  /** 手动拆分/合并后锁定，自动归并不再改动 */
  readonly locked: boolean
}

export function productKey(product: Pick<ClusterProduct, 'marketplace' | 'platformId'>): string {
  return `${product.marketplace}:${product.platformId}`
}

// 英文常见停用词与标题营销词；只影响相似度，不影响展示
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'for',
  'with',
  'of',
  'to',
  'in',
  'on',
  'by',
  'or',
  'at',
  'from',
  'new',
  'set',
  'pack',
  'pcs',
  'pc',
  'piece',
  'pieces',
  'count',
  'ct',
  'lot',
  'free',
  'shipping',
  'premium',
  'quality',
  'best',
  'hot',
  'sale',
  'upgraded',
])

// 数量与规格：纯数字、数字 + 单位（3pcs、16oz、2x、10inch）；“10 inch”先合并成一个词
const UNITS = 'x|pcs?|pack|packs|ct|count|oz|fl|ml|l|lbs?|g|kg|mm|cm|m|in|inch|inches|ft|qt|gal'
const QUANTITY = new RegExp(`^\\d+(\\.\\d+)?(${UNITS})?$`)
const SPACED_QUANTITY = new RegExp(`\\b(\\d+) (${UNITS})\\b`, 'g')

function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 标题规范化：小写、去品牌词与停用词、去数量单位，返回去重后的词集合（按字母序） */
export function normalizeTitle(title: string, brandWords: readonly string[] = []): string[] {
  let text = ` ${normalizeText(title)} `
  // 多词品牌按短语去除，长的先去，避免被短品牌截断
  const brands = brandWords
    .map(normalizeText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const brand of brands) text = text.split(` ${brand} `).join(' ')
  const tokens = text
    .replace(SPACED_QUANTITY, '$1$2')
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !QUANTITY.test(t))
  return [...new Set(tokens)].sort()
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection += 1
  return intersection / (setA.size + setB.size - intersection)
}

function normalizeGtin(gtin: string | undefined): string | null {
  if (!gtin) return null
  const digits = gtin.replace(/\D/g, '')
  // 去掉前导 0，使 UPC-A（12 位）与 EAN-13/GTIN-14 的同一编码相等
  const trimmed = digits.replace(/^0+/, '')
  return trimmed.length >= 8 ? trimmed : null
}

export interface AssignInput {
  readonly products: readonly ClusterProduct[]
  /** 已有成员（含手动锁定） */
  readonly existing: readonly ClusterMember[]
  /** 已知商品的属性（含不在本批的老成员），用于 GTIN 与标题匹配 */
  readonly knownProducts?: readonly ClusterProduct[] | undefined
  /** 品牌库词，用于标题规范化 */
  readonly brandWords?: readonly string[] | undefined
  readonly newClusterId: () => string
  readonly titleThreshold?: number | undefined
}

export interface AssignResult {
  /** 全部成员：已有成员原样保留，新商品追加 */
  readonly members: readonly ClusterMember[]
  readonly createdClusterIds: readonly string[]
}

interface Indexed {
  readonly product: ClusterProduct
  readonly clusterId: string
  readonly tokens: readonly string[]
  readonly gtin: string | null
}

/**
 * 自动归并。已有成员（锁定或未锁定）都不移动：平台 ID 相同即同一商品，保留原簇；
 * 锁定成员是团队手动修正的结果，自动归并绝不覆盖。新商品依次按 GTIN、标题相似匹配，否则新建簇。
 */
export function assignClusters(input: AssignInput): AssignResult {
  const threshold = input.titleThreshold ?? TITLE_THRESHOLD
  const members: ClusterMember[] = [...input.existing]
  const memberOf = new Map(members.map((m) => [m.productKey, m]))
  const created: string[] = []
  const brandWords = input.brandWords ?? []
  const tokensOf = (p: ClusterProduct) =>
    normalizeTitle(p.title ?? '', p.brand ? [...brandWords, p.brand] : brandWords)

  const index: Indexed[] = []
  const indexProduct = (product: ClusterProduct, clusterId: string) => {
    index.push({ product, clusterId, tokens: tokensOf(product), gtin: normalizeGtin(product.gtin) })
  }
  const seen = new Set<string>()
  for (const product of [...(input.knownProducts ?? []), ...input.products]) {
    const key = productKey(product)
    const member = memberOf.get(key)
    if (member && !seen.has(key)) {
      seen.add(key)
      indexProduct(product, member.clusterId)
    }
  }

  for (const product of input.products) {
    const key = productKey(product)
    if (memberOf.has(key)) continue
    const candidates = index.filter((i) => i.product.marketplace === product.marketplace)
    let assigned: ClusterMember | null = null

    const gtin = normalizeGtin(product.gtin)
    if (gtin) {
      const match = candidates.find((i) => i.gtin === gtin)
      if (match) {
        assigned = {
          clusterId: match.clusterId,
          productKey: key,
          method: 'gtin',
          confidence: GTIN_CONFIDENCE,
          locked: false,
        }
      }
    }

    if (!assigned && product.categoryId) {
      const tokens = tokensOf(product)
      let best: { clusterId: string; score: number } | null = null
      for (const candidate of candidates) {
        // 类目不同或缺失时不按标题归并
        if (candidate.product.categoryId !== product.categoryId) continue
        const score = jaccard(tokens, candidate.tokens)
        if (score >= threshold && (!best || score > best.score)) {
          best = { clusterId: candidate.clusterId, score }
        }
      }
      if (best) {
        assigned = {
          clusterId: best.clusterId,
          productKey: key,
          method: 'title',
          confidence: Math.round(best.score * 1000) / 1000,
          locked: false,
        }
      }
    }

    if (!assigned) {
      const clusterId = input.newClusterId()
      created.push(clusterId)
      assigned = { clusterId, productKey: key, method: 'seed', confidence: 1, locked: false }
    }
    members.push(assigned)
    memberOf.set(key, assigned)
    indexProduct(product, assigned.clusterId)
  }
  return { members, createdClusterIds: created }
}

/** 手动拆分：把成员移到新簇并锁定 */
export function splitMember(
  members: readonly ClusterMember[],
  key: string,
  newClusterId: string,
): ClusterMember[] {
  return members.map((m) =>
    m.productKey === key
      ? { ...m, clusterId: newClusterId, method: 'manual', confidence: 1, locked: true }
      : m,
  )
}

/** 手动合并：把 from 簇的全部成员并入 into 簇并锁定 */
export function mergeClusters(
  members: readonly ClusterMember[],
  fromClusterId: string,
  intoClusterId: string,
): ClusterMember[] {
  return members.map((m) =>
    m.clusterId === fromClusterId
      ? { ...m, clusterId: intoClusterId, method: 'manual', confidence: 1, locked: true }
      : m,
  )
}

/** 跨站点同款（GTIN 相同）：作为簇属性展示，不合并信号 */
export function crossMarketplaceLinks(
  members: readonly ClusterMember[],
  products: readonly ClusterProduct[],
): Array<readonly [string, string]> {
  const clusterOf = new Map(members.map((m) => [m.productKey, m.clusterId]))
  const byGtin = new Map<string, Map<Marketplace, Set<string>>>()
  for (const product of products) {
    const gtin = normalizeGtin(product.gtin)
    const clusterId = clusterOf.get(productKey(product))
    if (!gtin || !clusterId) continue
    const byMarket = byGtin.get(gtin) ?? new Map<Marketplace, Set<string>>()
    byMarket.set(
      product.marketplace,
      (byMarket.get(product.marketplace) ?? new Set()).add(clusterId),
    )
    byGtin.set(gtin, byMarket)
  }
  const links = new Set<string>()
  for (const byMarket of byGtin.values()) {
    const clusters = [...byMarket.values()].map((set) => [...set])
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        for (const a of clusters[i] as string[]) {
          for (const b of clusters[j] as string[]) links.add(a < b ? `${a}\n${b}` : `${b}\n${a}`)
        }
      }
    }
  }
  return [...links].sort().map((link) => {
    const [a, b] = link.split('\n') as [string, string]
    return [a, b] as const
  })
}
