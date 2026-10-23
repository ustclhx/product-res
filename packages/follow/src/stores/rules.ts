import type { TrackedProductTier } from '@product-res/db'
import { addDays, diffDays } from '@product-res/selection'

/**
 * 店铺追踪的纯规则（design D4–D6）：档位升降、出单信号与店铺指标。
 * 读取与写库在 tracking.ts，这里只做计算，便于覆盖边界。
 */

/** 测试规模的默认值（proposal「测试规模」）；调度入口可按部署覆盖 */
export const STORE_TRACKING_DEFAULTS = {
  /**
   * 被追踪商品上限（每个空间、按平台分开）：eBay Browse 免费且每日 5000 次，逐个 getItem 快照，
   * 500 个热点每日约 500 次；Amazon 走付费来源（AIsa / SerpApi），保持测试规模 100
   */
  productCapEbay: 500,
  productCapAmazon: 100,
  /** Amazon 报价调用每日上限，超出顺延 */
  offerCallsPerDay: 30,
  /** Amazon 店铺关键词搜索周期（天） */
  searchEveryDays: 3,
  /** 普通档快照周期（天）；热点每日，冷门停追 */
  normalEveryDays: 5,
  /** 店铺新品窗口：上架（首次发现）后多少天内出现出单信号才生成线索、计入命中 */
  newListingDays: 30,
  /** 多少天无变化降一档 */
  staleDays: 30,
  /** 升档看的“近期上升”窗口 */
  risingDays: 7,
  /** Amazon 出单门槛：bought 区间下界 */
  boughtSignalLow: 50,
  /** eBay 出单门槛：已售增量 */
  soldSignalDelta: 5,
  /** 店铺指标的最小样本 */
  minSample: 5,
} as const

export type StoreTrackingSettings = {
  -readonly [K in keyof typeof STORE_TRACKING_DEFAULTS]: number
}

export interface DayValue {
  readonly observedOn: string
  readonly value: number
}

/** 档位升级原因 → 优先级（同时满足时取第一个） */
export const TIER_UP_REASONS = ['sale-signal', 'new-lead', 'bought-up', 'sold-up'] as const
export type TierUpReason = (typeof TIER_UP_REASONS)[number]

export interface TierInput {
  readonly tier: TrackedProductTier
  /** 最近一次档位变更日 */
  readonly tierChangedOn: string
  /** 成立的升档信号 */
  readonly up: ReadonlySet<TierUpReason>
  /** 关键指标最近一次变化的日期；没有数据时为 null */
  readonly lastChangeOn: string | null
  readonly today: string
}

const DOWN: Readonly<Record<TrackedProductTier, TrackedProductTier>> = {
  hot: 'normal',
  normal: 'cold',
  cold: 'cold',
}

/**
 * 档位决策：任一升档信号 → 热点；否则自上次变化（与上次换档取较晚者）起 30 天无变化降一档。
 * 已是热点时信号只维持热点、不刷新原因。档位不变返回 null。
 */
export function decideTier(
  input: TierInput,
  settings: Pick<StoreTrackingSettings, 'staleDays'> = STORE_TRACKING_DEFAULTS,
): { tier: TrackedProductTier; reason: string } | null {
  const reason = TIER_UP_REASONS.find((r) => input.up.has(r))
  if (reason) return input.tier === 'hot' ? null : { tier: 'hot', reason }
  if (input.tier === 'cold') return null
  const since =
    input.lastChangeOn && input.lastChangeOn > input.tierChangedOn
      ? input.lastChangeOn
      : input.tierChangedOn
  if (diffDays(since, input.today) < settings.staleDays) return null
  return { tier: DOWN[input.tier], reason: `stale-${settings.staleDays}d` }
}

/** 截至 day 时某日（含）之前的最后一个值 */
function valueAt(points: readonly DayValue[], day: string) {
  let out: number | undefined
  for (const p of points) if (p.observedOn <= day) out = p.value
  return out
}

/**
 * 近 N 天内是否上升：窗口内的最大值 > 窗口开始前（含当天）的最后一个值。
 * 窗口开始前没有数据时不算上升（首次观测不是“上升”）。
 */
export function roseWithin(points: readonly DayValue[], today: string, days: number): boolean {
  const start = addDays(today, -days)
  const before = valueAt(points, start)
  if (before === undefined) return false
  const recent = points.filter((p) => p.observedOn > start && p.observedOn <= today)
  return recent.some((p) => p.value > before)
}

/** 多个序列中最近一次“与前一个值不同”的日期 */
export function lastChangeOn(series: readonly (readonly DayValue[])[]): string | null {
  let latest: string | null = null
  for (const points of series) {
    const sorted = [...points].sort((a, b) => a.observedOn.localeCompare(b.observedOn))
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i] as DayValue
      if (cur.value !== (sorted[i - 1] as DayValue).value && (!latest || cur.observedOn > latest))
        latest = cur.observedOn
    }
  }
  return latest
}

export interface SaleSignal {
  readonly on: string
  readonly kind: 'amazon-bought' | 'ebay-sold'
  /** Amazon：bought 区间下界 / 上界；eBay：自首次发现以来的已售增量 */
  readonly valueLow: number
  readonly valueHigh: number | null
}

/**
 * 出单信号（design D5）：
 * - Amazon：bought 区间下界 ≥ 50（首次达到的日期）
 * - eBay：自首次发现起已售增量 ≥ 5；有官方累计已售量时用累计差，否则用可售量的减少推算（补货日不计）
 */
export function saleSignal(
  input: {
    readonly platform: 'ebay' | 'amazon'
    readonly firstSeenOn: string
    /** bought_month 主值的区间（valueLow / valueHigh） */
    readonly bought?: readonly { observedOn: string; low: number; high: number | null }[]
    readonly sold?: readonly DayValue[]
    readonly available?: readonly DayValue[]
  },
  settings: Pick<
    StoreTrackingSettings,
    'boughtSignalLow' | 'soldSignalDelta'
  > = STORE_TRACKING_DEFAULTS,
): SaleSignal | null {
  if (input.platform === 'amazon') {
    const hit = [...(input.bought ?? [])]
      .sort((a, b) => a.observedOn.localeCompare(b.observedOn))
      .find((p) => p.low >= settings.boughtSignalLow)
    return hit
      ? { on: hit.observedOn, kind: 'amazon-bought', valueLow: hit.low, valueHigh: hit.high }
      : null
  }
  const sold = [...(input.sold ?? [])].sort((a, b) => a.observedOn.localeCompare(b.observedOn))
  if (sold.length > 0) {
    // 基线：首次发现当天（或之前）的累计值；没有时取最早一个
    const base = valueAt(sold, input.firstSeenOn) ?? (sold[0] as DayValue).value
    const hit = sold.find((p) => p.value - base >= settings.soldSignalDelta)
    if (hit)
      return { on: hit.observedOn, kind: 'ebay-sold', valueLow: hit.value - base, valueHigh: null }
    return null
  }
  const available = [...(input.available ?? [])].sort((a, b) =>
    a.observedOn.localeCompare(b.observedOn),
  )
  let total = 0
  for (let i = 1; i < available.length; i++) {
    const drop = (available[i - 1] as DayValue).value - (available[i] as DayValue).value
    if (drop > 0) total += drop
    if (total >= settings.soldSignalDelta)
      return {
        on: (available[i] as DayValue).observedOn,
        kind: 'ebay-sold',
        valueLow: total,
        valueHigh: null,
      }
  }
  return null
}

export interface StoreListingFacts {
  readonly productId: string
  readonly firstSeenOn: string
  readonly delistedOn: string | null
  readonly categoryId: string | null
  /** 出单信号日期；没有为 null */
  readonly signalOn: string | null
  /** 最新 bought 区间（Amazon）或已售增量（eBay，上界开放） */
  readonly sales: { readonly low: number; readonly high: number | null } | null
}

export interface StoreMetrics {
  /** 上新速度：近 28 天每周新品数 */
  readonly newPerWeek: number | null
  /** 新品存活率：首次发现满 30 天的新品中，30 天时仍在售的比例 */
  readonly survivalRate: number | null
  /** 新品命中率：首次发现 30 天内出现出单信号的比例 */
  readonly hitRate: number | null
  /** 出单区间合计；任一上界开放时上界为 null */
  readonly salesSum: { readonly low: number; readonly high: number | null } | null
  /** 方向迁移：近 30 天新品类目分布与过去 90 天的差异（总变差距离 0–1） */
  readonly directionShift: number | null
  /** 样本数：发现的新品总数 */
  readonly sample: number
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

function distribution(rows: readonly StoreListingFacts[]) {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const key = r.categoryId ?? 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * 店铺指标（design D6）：各指标的样本少于 minSample 时为 null（页面显示为空，不显示 0%）。
 */
export function computeStoreMetrics(
  listings: readonly StoreListingFacts[],
  today: string,
  settings: Pick<StoreTrackingSettings, 'minSample' | 'newListingDays'> = STORE_TRACKING_DEFAULTS,
): StoreMetrics {
  const min = settings.minSample
  const window = settings.newListingDays
  const sample = listings.length
  if (sample < min)
    return {
      newPerWeek: null,
      survivalRate: null,
      hitRate: null,
      salesSum: null,
      directionShift: null,
      sample,
    }
  const recent28 = listings.filter((l) => diffDays(l.firstSeenOn, today) < 28).length
  const matured = listings.filter((l) => diffDays(l.firstSeenOn, today) >= window)
  const alive = matured.filter(
    (l) => l.delistedOn === null || diffDays(l.firstSeenOn, l.delistedOn) >= window,
  )
  const hits = listings.filter(
    (l) => l.signalOn !== null && diffDays(l.firstSeenOn, l.signalOn) <= window,
  )
  // 命中率的分母：已满窗口的新品 + 窗口内已命中的新品（未满窗口且未命中的尚无结论）
  const decided = new Set([...matured.map((l) => l.productId), ...hits.map((l) => l.productId)])
  const withSales = listings.filter((l) => l.sales !== null)
  const salesSum =
    withSales.length >= min
      ? {
          low: withSales.reduce((n, l) => n + (l.sales?.low ?? 0), 0),
          high: withSales.some((l) => l.sales?.high === null)
            ? null
            : withSales.reduce((n, l) => n + (l.sales?.high ?? 0), 0),
        }
      : null
  const last30 = listings.filter((l) => diffDays(l.firstSeenOn, today) < 30)
  const prior90 = listings.filter((l) => {
    const age = diffDays(l.firstSeenOn, today)
    return age >= 30 && age < 120
  })
  let directionShift: number | null = null
  if (last30.length >= min && prior90.length >= min) {
    const a = distribution(last30)
    const b = distribution(prior90)
    let distance = 0
    for (const key of new Set([...a.keys(), ...b.keys()]))
      distance += Math.abs((a.get(key) ?? 0) / last30.length - (b.get(key) ?? 0) / prior90.length)
    directionShift = round4(distance / 2)
  }
  return {
    newPerWeek: round4(recent28 / 4),
    survivalRate: matured.length >= min ? round4(alive.length / matured.length) : null,
    hitRate: decided.size >= min ? round4(hits.length / decided.size) : null,
    salesSum,
    directionShift,
    sample,
  }
}

export interface EnrollStoreItem {
  readonly productId: string
  /** 首次发现日 */
  readonly firstSeenOn: string
  /** 上架日；未知为 null */
  readonly listedOn: string | null
}

export interface EnrollCandidate {
  readonly productId: string
  readonly origin: 'store' | 'lead'
  /** 店铺新品为店铺 id，线索商品为 null */
  readonly originRef: string | null
}

const newestFirst = (a: EnrollStoreItem, b: EnrollStoreItem) =>
  b.firstSeenOn.localeCompare(a.firstSeenOn) ||
  (b.listedOn ?? '').localeCompare(a.listedOn ?? '') ||
  a.productId.localeCompare(b.productId)

/**
 * 加入追踪的公平顺序（design「实测修正 2026-10-23」）。按店铺原顺序拼接时，
 * 一轮发现上千新品的头部店铺会占满名额，因此：
 * 1. 每个店铺内部按首次发现日、上架日新到旧排序；
 * 2. 店铺之间轮询，先让每个有候选的店铺拿到保底 floor(room / 店铺数)；
 * 3. 线索商品排在保底之后；
 * 4. 剩余名额继续店铺轮询。
 * 已追踪或重复的商品跳过；调用方按返回顺序加入，直到名额用完。
 */
export function orderEnrollment(input: {
  readonly stores: readonly {
    readonly storeId: string
    readonly items: readonly EnrollStoreItem[]
  }[]
  readonly leads: readonly string[]
  readonly tracked: ReadonlySet<string>
  readonly room: number
}): EnrollCandidate[] {
  const seen = new Set(input.tracked)
  const queues = input.stores
    .map(({ storeId, items }) => {
      const ids: string[] = []
      for (const item of [...items].sort(newestFirst)) {
        if (seen.has(item.productId)) continue
        seen.add(item.productId)
        ids.push(item.productId)
      }
      return { storeId, ids, next: 0 }
    })
    .filter((q) => q.ids.length > 0)
  const out: EnrollCandidate[] = []
  const roundRobin = (limit: number) => {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const q of queues) {
        if (q.next >= q.ids.length || q.next >= limit) continue
        out.push({ productId: q.ids[q.next++] as string, origin: 'store', originRef: q.storeId })
        progressed = true
      }
    }
  }
  const quota = queues.length === 0 ? 0 : Math.floor(Math.max(0, input.room) / queues.length)
  roundRobin(quota)
  for (const productId of input.leads) {
    if (seen.has(productId)) continue
    seen.add(productId)
    out.push({ productId, origin: 'lead', originRef: null })
  }
  roundRobin(Number.POSITIVE_INFINITY)
  return out
}
