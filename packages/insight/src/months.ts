import type { MonthlyValue } from './types.ts'

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s)
}

/** 月份加减，delta 可为负。 */
export function addMonths(month: string, delta: number): string {
  const m = MONTH_RE.exec(month)
  if (!m) throw new RangeError(`非法月份: ${month}`)
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta
  const y = Math.floor(idx / 12)
  return `${String(y).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`
}

/** 以 end 结尾的连续 n 个月（升序）。 */
export function lastMonths(end: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(end, i - n + 1))
}

/**
 * 按月汇总。同一月份出现多条（例如研究含多个关键词）时求和；
 * 非有限数值和非法月份被忽略，保证“缺失”不会被当成 0。
 */
export function toMonthMap(series: readonly MonthlyValue[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const p of series) {
    if (!isMonth(p.month) || !Number.isFinite(p.value)) continue
    map.set(p.month, (map.get(p.month) ?? 0) + p.value)
  }
  return map
}

export function latestMonth(map: ReadonlyMap<string, number>): string | null {
  let best: string | null = null
  for (const k of map.keys()) if (best === null || k > best) best = k
  return best
}
