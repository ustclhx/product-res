/**
 * 时间工具：服务端只处理 UTC，展示层再按用户时区格式化。
 */

const MS_PER_SECOND = 1000
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND

export function utcNow(): Date {
  return new Date()
}

/** ISO 8601，固定以 `Z` 结尾。 */
export function toUtcIso(date: Date): string {
  return date.toISOString()
}

// 必须带时区（Z 或 ±hh:mm），避免把不带时区的字符串按服务器本地时间解析
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** 解析带时区的 ISO 8601 字符串；不带时区或非法时抛错。 */
export function parseUtcIso(value: string): Date {
  if (!ISO_WITH_ZONE.test(value)) {
    throw new RangeError(`Expected an ISO 8601 timestamp with a timezone, got "${value}"`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp "${value}"`)
  }
  return date
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * MS_PER_SECOND)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}
