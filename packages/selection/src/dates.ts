/**
 * 日期工具：只处理 YYYY-MM-DD 的 UTC 日历日，避免服务器时区影响天数差。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function parseDay(day: string): number {
  if (!DAY.test(day)) throw new RangeError(`Expected YYYY-MM-DD, got "${day}"`)
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date "${day}"`)
  return ms
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(day: string, days: number): string {
  return formatDay(parseDay(day) + days * MS_PER_DAY)
}

/** to − from 的天数 */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / MS_PER_DAY)
}

/** fetchedAt（ISO 时间戳）距 now 的小时数 */
export function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / (60 * 60 * 1000)
}
