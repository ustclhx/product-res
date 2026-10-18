/** 报告页的数值格式：缺失统一显示“—”，比例按百分比，金额带币种符号 */

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export const fmtNumber = (n: number | null | undefined) => (n == null ? '—' : nf.format(n))
export const fmtCompact = (n: number | null | undefined) =>
  n == null ? '—' : n >= 10_000 ? compact.format(n) : nf.format(Math.round(n))

export const fmtPercent = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : `${(n * 100).toFixed(digits)}%`

export const fmtSignedPercent = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`

const SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CAD: 'C$' }
export function fmtMoney(n: number | null | undefined, currency: string | null | undefined) {
  if (n == null) return '—'
  const symbol = currency ? (SYMBOLS[currency] ?? `${currency} `) : ''
  return `${symbol}${n >= 100 ? Math.round(n) : n.toFixed(2)}`
}

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso))
    : '—'
