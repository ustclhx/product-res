/**
 * 维度映射函数与常数（design D4）。所有阈值集中在这里，调参只改这一处；
 * 回测（M5）后可能整体替换为拟合值。
 */

export const SCALES = {
  /** eBay 簇 7 天销量增量：1 件 → 0，500 件 → 100（对数） */
  ebayWeeklyUnits: { floor: 1, ceiling: 500 },
  /** Amazon 簇月销量估算：30 件 → 0，30000 件 → 100（对数） */
  amazonMonthlyUnits: { floor: 30, ceiling: 30_000 },
  /** BSR：排名 100 → 100，500000 → 0（对数反向） */
  bsr: { best: 100, worst: 500_000 },
  /** Amazon 市场需求中销量与 BSR 的混合比例 */
  amazonBlend: { sales: 0.7, bsr: 0.3 },
  /** 加速度（7 天日均 ÷ 30 天日均）加成：(比值 − 1) × gain，截断到 ±maxBonus */
  acceleration: { gain: 25, maxBonus: 20 },
  /** 季节指数（目标窗口均值 ÷ 全年均值）：0.5 → 0，1 → 50，2 → 100（分段线性） */
  seasonIndex: { low: 0.5, neutral: 1, high: 2 },
  /** 季节部分至少需要的日历月数 */
  seasonMinMonths: 6,
  /** 只有一年数据时的年际稳定性（无法验证，取中性） */
  seasonSingleYearStability: 0.5,
  /** 90 天增长加成：增长率 × gain，截断到 ±maxBonus */
  growth90: { gain: 30, maxBonus: 15 },
  /** 同行扩散：14 天窗口；5 家对标店铺上新视为满分主体（85），集中度最多加 15 */
  peerSpread: { windowDays: 14, fullShops: 5, shopsWeight: 85, concentrationBonus: 15 },
  /** 毛利率：0 → 0，50% → 100（线性） */
  margin: { low: 0, high: 0.5 },
  /** 无核算时的平台费用默认值（M3 后由核算结果替代） */
  defaultFees: {
    ebay: { commissionRate: 0.136, fixedFee: 0.4, returnRate: 0.05 },
    amazon: { commissionRate: 0.15, fixedFee: 0, returnRate: 0.05 },
  },
  /** 竞争强度各分项（越高越激烈） */
  competition: {
    /** 卖家数 30 天增长率：−20% → 0，+50% → 100 */
    sellerGrowth: { low: -0.2, high: 0.5 },
    /** 最低价 30 天跌幅：0 → 0，30% → 100 */
    priceDrop: { low: 0, high: 0.3 },
    /** 头部份额：20% → 0，80% → 100 */
    topShare: { low: 0.2, high: 0.8 },
    /** 评论数中位数：10 → 0，5000 → 100（对数） */
    reviewMedian: { floor: 10, ceiling: 5000 },
  },
  /** 供应与时效（反向）：余量 ÷ 所需提前期，≥ 1 → 0，0 → 90，已错过 → 100 */
  supplyTiming: { onTimeMax: 90, late: 100 },
  /** 合规扣分 */
  compliancePenalty: { high: 100, medium: 25, low: 10 },
} as const

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 截断到 0–100 并保留一位小数 */
export function clampScore(value: number): number {
  return Math.round(clamp(value, 0, 100) * 10) / 10
}

/** 线性映射：low → 0，high → 100（high < low 时为反向） */
export function linearScale(value: number, low: number, high: number): number {
  if (high === low) return value >= high ? 100 : 0
  return clampScore(((value - low) / (high - low)) * 100)
}

/** 对数映射：≤ floor → 0，≥ ceiling → 100 */
export function logScale(value: number, floor: number, ceiling: number): number {
  if (!(value > floor)) return 0
  if (value >= ceiling) return 100
  return clampScore((Math.log(value / floor) / Math.log(ceiling / floor)) * 100)
}

/** 对数反向映射（排名类，越小越好）：≤ best → 100，≥ worst → 0 */
export function inverseLogScale(value: number, best: number, worst: number): number {
  if (value <= best) return 100
  if (value >= worst) return 0
  return clampScore(100 - (Math.log(value / best) / Math.log(worst / best)) * 100)
}

/** 季节指数分段映射：无季节性（指数 1）落在中性 50 */
export function seasonIndexScale(index: number): number {
  const { low, neutral, high } = SCALES.seasonIndex
  if (index <= neutral) return clampScore(linearScale(index, low, neutral) / 2)
  return clampScore(50 + linearScale(index, neutral, high) / 2)
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 分位数（线性插值），p ∈ [0, 1] */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = clamp(p, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const lo = sorted[lower] as number
  const hi = sorted[upper] as number
  return lo + (hi - lo) * (index - lower)
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5)
}

/** value 在参考分布中的分位（0–1，含相等值的一半） */
export function percentileRank(value: number, reference: readonly number[]): number | null {
  if (reference.length === 0) return null
  let below = 0
  let equal = 0
  for (const item of reference) {
    if (item < value) below += 1
    else if (item === value) equal += 1
  }
  return (below + equal / 2) / reference.length
}

/** 变异系数（总体标准差 ÷ 均值）；均值为 0 或少于 2 个值时为 null */
export function coefficientOfVariation(values: readonly number[]): number | null {
  const avg = mean(values)
  if (values.length < 2 || avg === null || avg === 0) return null
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance) / Math.abs(avg)
}

/** Pearson 相关系数；样本少于 3 或方差为 0 时为 null */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  const mx = mean(xs.slice(0, n)) as number
  const my = mean(ys.slice(0, n)) as number
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx
    const dy = (ys[i] as number) - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (vx === 0 || vy === 0) return null
  return cov / Math.sqrt(vx * vy)
}
