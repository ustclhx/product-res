/**
 * 区间值（add-accuracy-store-tracking design D1、specs/data-accuracy「区间值」）。
 *
 * Amazon 商品页的 "N+ bought in past month" 只表示 [N, 下一档)，不是 N。观测写入下界、上界
 * （徽标的下一档），value 存对数中点供算法使用；不得把下界当点值，否则会系统性低估。
 */

export interface IntervalValue {
  /** 区间的对数中点（上界开放时为下界，调用方应按区间展示） */
  readonly value: number
  readonly valueLow: number
  /** 上界（不含）；开放时为 null */
  readonly valueHigh: number | null
}

/**
 * Amazon bought 徽标的档位：50、100、200 … 900、1K、2K … 9K、10K、20K … 90K、100K、200K …
 * 即 100 以下只有 50 一档，之后每个数量级按 1–9 倍递增。下一档为严格大于当前值的最小档位。
 */
export const AMAZON_BOUGHT_FIRST_TIER = 50

/** 严格大于 low 的下一个 Amazon bought 档位 */
export function nextAmazonBoughtTier(low: number): number {
  if (!Number.isFinite(low) || low < 0) throw new RangeError('bought lower bound must be >= 0')
  if (low < AMAZON_BOUGHT_FIRST_TIER) return AMAZON_BOUGHT_FIRST_TIER
  if (low < 100) return 100
  const magnitude = 10 ** Math.floor(Math.log10(low))
  return (Math.floor(low / magnitude) + 1) * magnitude
}

/**
 * 区间的对数中点（几何平均）。下界为 0 时对数无定义，退回算术中点；上界开放时返回下界，
 * 此时观测必须带 value_low / value_high，展示为 "N+"。
 */
export function logMidpoint(low: number, high: number | null): number {
  if (high === null) return low
  if (high < low) throw new RangeError('interval upper bound must be >= lower bound')
  if (low <= 0) return (low + high) / 2
  return Math.sqrt(low * high)
}

/** "N+ bought" 的下界 → 区间观测值：[N, 下一档)，value 为对数中点 */
export function amazonBoughtInterval(low: number): IntervalValue {
  const high = nextAmazonBoughtTier(low)
  return { value: logMidpoint(low, high), valueLow: low, valueHigh: high }
}

const SUFFIX: Readonly<Record<string, number>> = { '': 1, k: 1_000, m: 1_000_000 }

/**
 * 解析徽标文本中的下界："7K+ bought in past month" → 7000，"100+ bought" → 100，
 * "1.5K+" → 1500。无法识别时返回 null（缺失就是缺失，不补零）。
 */
export function parseBoughtText(text: string | null | undefined): number | null {
  if (!text) return null
  const match = /(\d+(?:[.,]\d+)?)\s*([kKmM]?)\s*\+/.exec(text)
  if (!match) return null
  const base = Number((match[1] as string).replace(',', '.'))
  const multiplier = SUFFIX[(match[2] as string).toLowerCase()] as number
  const value = Math.round(base * multiplier)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 区间展示："100–200"；上界开放时 "10K+"；点值（无下界）返回数值本身 */
export function formatInterval(low: number | null, high: number | null, value?: number): string {
  if (low === null) return value === undefined ? '—' : compact(value)
  if (high === null) return `${compact(low)}+`
  return `${compact(low)}–${compact(high)}`
}

function compact(n: number) {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}K`
  return String(n)
}
