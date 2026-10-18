/** 金额与比例的显示 / 输入换算；金额按两位小数的币种处理（USD / CNY / EUR 等） */

export function formatMoney(minor: number | null | undefined, currency?: string | null): string {
  if (minor == null || !Number.isFinite(minor)) return '—'
  const major = (minor / 100).toFixed(2)
  return currency ? `${currency} ${major}` : major
}

export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(digits)}%`
}

/** 输入框的主单位金额 → 最小单位整数；空串为 null，非法值为 NaN */
export function parseMoney(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  return Math.round(Number(t) * 100)
}

/** 百分比输入（如 15 表示 15%）→ 小数比例 */
export function parsePercent(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 100) return Number.NaN
  return Math.round(n * 100) / 10_000
}

export function parseNumber(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : Number.NaN
}

export const moneyInput = (minor: number | null | undefined) =>
  minor == null ? '' : (minor / 100).toFixed(2)
export const percentInput = (rate: number | null | undefined) =>
  rate == null ? '' : String(Math.round(rate * 10_000) / 100)
export const numberInput = (n: number | null | undefined) => (n == null ? '' : String(n))
