import { addMonths, lastMonths, latestMonth, toMonthMap } from './months.ts'
import type { InsightProduct, MonthlyValue } from './types.ts'

// ---- 搜索量同比 ----

export interface YoyResult {
  yoy: number
  /** 双方都有数据的月份数（spec：去年缺 3 个月 → 9） */
  coveredMonths: number
  months: string[]
  currentSum: number
  previousSum: number
  /** 窗口末月 */
  endMonth: string
  sourceIds: string[]
}

/**
 * 最近 12 个月合计 ÷ 前 12 个月合计 − 1，只用双方都有数据的月份。
 * 没有重叠月份、或前期合计为 0（无法相除）时返回 null，绝不当 0。
 */
export function searchVolumeYoy(
  series: readonly MonthlyValue[],
  opts: { endMonth?: string } = {},
): YoyResult | null {
  const map = toMonthMap(series)
  const endMonth = opts.endMonth ?? latestMonth(map)
  if (!endMonth) return null
  const months = lastMonths(endMonth, 12).filter((m) => map.has(m) && map.has(addMonths(m, -12)))
  if (months.length === 0) return null
  let currentSum = 0
  let previousSum = 0
  for (const m of months) {
    currentSum += map.get(m) ?? 0
    previousSum += map.get(addMonths(m, -12)) ?? 0
  }
  if (previousSum <= 0) return null
  const used = new Set<string>(months.flatMap((m) => [m, addMonths(m, -12)]))
  const sourceIds = [
    ...new Set(series.filter((p) => used.has(p.month)).map((p) => p.sourceId)),
  ].sort()
  return {
    yoy: currentSum / previousSum - 1,
    coveredMonths: months.length,
    months,
    currentSum,
    previousSum,
    endMonth,
    sourceIds,
  }
}

// ---- 近 90 天新品数 ----

export interface NewProductsResult {
  /** 窗口内新品数；全部商品都没有日期时为 null（不是 0） */
  count: number | null
  windowDays: number
  byListedAt: number
  byFirstSeenAt: number
  /** 既无 listedAt 也无 firstSeenAt，无法判断的商品数 */
  excluded: number
  /** 口径说明，随结果展示 */
  basis: string
}

const DAY_MS = 86_400_000

export function countNewProducts(
  products: readonly InsightProduct[],
  opts: { now: Date | string; windowDays?: number },
): NewProductsResult {
  const windowDays = opts.windowDays ?? 90
  const now = new Date(opts.now).getTime()
  const from = now - windowDays * DAY_MS
  let byListedAt = 0
  let byFirstSeenAt = 0
  let excluded = 0
  let dated = 0
  for (const p of products) {
    const listed = p.listedAt ? Date.parse(p.listedAt) : Number.NaN
    const seen = p.firstSeenAt ? Date.parse(p.firstSeenAt) : Number.NaN
    const useListed = Number.isFinite(listed)
    const t = useListed ? listed : seen
    if (!Number.isFinite(t)) {
      excluded++
      continue
    }
    dated++
    if (t > from && t <= now) {
      if (useListed) byListedAt++
      else byFirstSeenAt++
    }
  }
  return {
    count: dated === 0 ? null : byListedAt + byFirstSeenAt,
    windowDays,
    byListedAt,
    byFirstSeenAt,
    excluded,
    basis: `按上架时间（缺失时用首次发现时间）统计最近 ${windowDays} 天；首次发现时间只是上架时间的近似，无任何日期的商品不计入`,
  }
}

// ---- 价格带 ----

export interface PriceBand {
  /** 含下界；null 表示无下界 */
  min: number | null
  /** 不含上界；null 表示无上界 */
  max: number | null
  productCount: number
  /** 销量估算合计（只含有销量估算的商品） */
  sales: number
  /** 销量估算占比；没有任何销量估算时为 null */
  salesShare: number | null
}

export interface PriceBandsResult {
  bands: PriceBand[]
  boundaries: number[]
  /** 缺价格而未计入的商品数 */
  excludedNoPrice: number
  /** 有价格但缺销量估算的商品数（计入商品数，不计入占比） */
  missingSales: number
  custom: boolean
}

const BAND_COUNT = 6

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] ?? 0
  const b = sorted[hi] ?? a
  return a + (b - a) * (pos - lo)
}

/** 价格分 6 档：默认按分位自动取 5 个边界，也可传 5 个严格递增的自定义边界。无可用价格返回 null。 */
export function priceBands(
  products: readonly InsightProduct[],
  opts: { boundaries?: readonly number[] } = {},
): PriceBandsResult | null {
  const priced = products.filter((p) => p.price && Number.isFinite(p.price.value))
  const excludedNoPrice = products.length - priced.length
  if (priced.length === 0) return null

  let boundaries: number[]
  const custom = opts.boundaries !== undefined
  if (opts.boundaries) {
    boundaries = [...opts.boundaries]
    const ok =
      boundaries.length === BAND_COUNT - 1 &&
      boundaries.every((b, i) => Number.isFinite(b) && (i === 0 || b > (boundaries[i - 1] ?? 0)))
    if (!ok) throw new RangeError(`价格带需要 ${BAND_COUNT - 1} 个严格递增的边界`)
  } else {
    const sorted = priced.map((p) => p.price?.value ?? 0).sort((a, b) => a - b)
    boundaries = Array.from({ length: BAND_COUNT - 1 }, (_, i) =>
      quantile(sorted, (i + 1) / BAND_COUNT),
    )
  }

  const bands: PriceBand[] = Array.from({ length: BAND_COUNT }, (_, i) => ({
    min: i === 0 ? null : (boundaries[i - 1] ?? null),
    max: i === BAND_COUNT - 1 ? null : (boundaries[i] ?? null),
    productCount: 0,
    sales: 0,
    salesShare: null,
  }))
  let missingSales = 0
  let totalSales = 0
  for (const p of priced) {
    const price = p.price?.value ?? 0
    // 落入第一个“price < 边界”的档，否则最后一档
    let idx = boundaries.findIndex((b) => price < b)
    if (idx === -1) idx = BAND_COUNT - 1
    const band = bands[idx]
    if (!band) continue
    band.productCount++
    const s = p.salesMonthly?.value
    if (s === undefined || !Number.isFinite(s)) {
      missingSales++
    } else {
      band.sales += s
      totalSales += s
    }
  }
  if (totalSales > 0) {
    for (const b of bands) b.salesShare = b.sales / totalSales
  }
  return { bands, boundaries, excludedNoPrice, missingSales, custom }
}

// ---- 头部集中度 ----

export interface ConcentrationResult {
  cr3: number | null
  cr10: number | null
  /** 参与计算的商品数（有销量估算） */
  sampleSize: number
  /** 缺销量估算而未参与的商品数 */
  excluded: number
  totalSales: number
  sourceIds: string[]
  /** 销量估算只来自单一来源时为 false，界面标“未交叉验证” */
  crossValidated: boolean
}

/** CR3 / CR10：按月销量估算降序，前 N 名占样本销量合计的比例。没有销量估算返回 null。 */
export function concentration(products: readonly InsightProduct[]): ConcentrationResult | null {
  const sales = products
    .map((p) => p.salesMonthly)
    .filter((s): s is NonNullable<typeof s> => !!s && Number.isFinite(s.value) && s.value >= 0)
  if (sales.length === 0) return null
  const sorted = sales.map((s) => s.value).sort((a, b) => b - a)
  const total = sorted.reduce((a, b) => a + b, 0)
  const cr = (n: number) =>
    total > 0 ? sorted.slice(0, n).reduce((a, b) => a + b, 0) / total : null
  const sourceIds = [...new Set(sales.map((s) => s.sourceId))].sort()
  return {
    cr3: cr(3),
    cr10: cr(10),
    sampleSize: sales.length,
    excluded: products.length - sales.length,
    totalSales: total,
    sourceIds,
    crossValidated: sourceIds.length > 1,
  }
}
