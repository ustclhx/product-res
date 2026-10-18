/** 导入值解析：空值保持 null，绝不补零 */

const EMPTY = new Set(['', '-', '—', '–', 'n/a', 'na', 'null', 'none', '无', '--'])

export function isEmptyCell(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return true
  if (typeof raw === 'number') return Number.isNaN(raw)
  return EMPTY.has(raw.trim().toLowerCase())
}

/**
 * 解析数字：去掉千分位、货币符号与空白；`12%` → 0.12；`1.2万` → 12000；`1.5k` → 1500。
 * 无法解析返回 undefined（区别于空值 null）。
 */
export function parseNumber(raw: string | number | null | undefined): number | null | undefined {
  if (isEmptyCell(raw)) return null
  if (typeof raw === 'number') return raw
  let text = (raw as string)
    .trim()
    .replace(/[\s,，]/g, '')
    .replace(/^[$€£¥￥]|^(US\$|USD|CNY|RMB)/i, '')
  let scale = 1
  if (text.endsWith('%')) {
    scale = 0.01
    text = text.slice(0, -1)
  } else if (/万$/.test(text)) {
    scale = 10_000
    text = text.slice(0, -1)
  } else if (/[kK]$/.test(text)) {
    scale = 1_000
    text = text.slice(0, -1)
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined
  return Number(text) * scale
}

/**
 * 解析日期为 YYYY-MM-DD：支持 YYYY-MM-DD、YYYY/MM/DD、YYYY年M月D日、MM/DD/YYYY 与 Excel 序列号。
 * 无法解析返回 undefined。
 */
export function parseDate(raw: string | number | null | undefined): string | null | undefined {
  if (isEmptyCell(raw)) return null
  if (typeof raw === 'number' || /^\d{5}(\.\d+)?$/.test(String(raw).trim())) {
    // Excel 1900 日期系统：序列号 1 = 1900-01-01，含 1900-02-29 的历史偏差
    const serial = Math.floor(Number(raw))
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
    return date.toISOString().slice(0, 10)
  }
  const text = String(raw).trim()
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(text)
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (m) return valid(Number(m[3]), Number(m[1]), Number(m[2]))
  return undefined
}

function valid(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined
  return date.toISOString().slice(0, 10)
}
