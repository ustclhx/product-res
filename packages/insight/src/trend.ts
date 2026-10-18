import { lastMonths, latestMonth, toMonthMap } from './months.ts'
import type { MonthlyValue } from './types.ts'

export interface TrendNode {
  /** YYYY-MM-DD 或 YYYY-MM */
  date: string
  label: string
}

export interface TrendPoint {
  month: string
  /** 缺月为 null，不补 0 */
  searchVolume: number | null
  salesEstimate: number | null
  nodes: TrendNode[]
}

/** 12 个月趋势：搜索量与销量估算按月对齐，可附节点标注（节点落在窗口外则忽略）。 */
export function monthlyTrend(
  searchVolume: readonly MonthlyValue[],
  salesEstimate: readonly MonthlyValue[],
  opts: { endMonth?: string; nodes?: readonly TrendNode[] } = {},
): TrendPoint[] {
  const sv = toMonthMap(searchVolume)
  const se = toMonthMap(salesEstimate)
  const ends = [latestMonth(sv), latestMonth(se)].filter((m): m is string => m !== null).sort()
  const end = opts.endMonth ?? ends.pop()
  if (!end) return []
  return lastMonths(end, 12).map((month) => ({
    month,
    searchVolume: sv.get(month) ?? null,
    salesEstimate: se.get(month) ?? null,
    nodes: (opts.nodes ?? []).filter((n) => n.date.slice(0, 7) === month),
  }))
}
