import { AppError } from '@product-res/shared'
import type { Currency, FxRate, Money } from './types.ts'

// 最小单位位数：常见零位小数币种单列，其余按 2 位
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD'])

export function minorExponent(currency: Currency): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2
}

/** 查找 from → to 的汇率，支持反向报价；找不到返回 null */
export function findRate(from: Currency, to: Currency, rates: FxRate[]): number | null {
  const f = from.toUpperCase()
  const t = to.toUpperCase()
  if (f === t) return 1
  for (const r of rates) {
    if (!(r.rate > 0)) continue
    if (r.from.toUpperCase() === f && r.to.toUpperCase() === t) return r.rate
    if (r.from.toUpperCase() === t && r.to.toUpperCase() === f) return 1 / r.rate
  }
  return null
}

/**
 * 换算为目标币种的最小单位，保留小数，供成本项累加后再统一取整，避免逐步取整的误差。
 * 汇率由调用方传入（来自 fx_rate 主值），本包不访问数据库。
 */
export function convertMinorExact(
  amountMinor: number,
  from: Currency,
  to: Currency,
  rates: FxRate[],
): number | null {
  const rate = findRate(from, to, rates)
  if (rate === null) return null
  return amountMinor * rate * 10 ** (minorExponent(to) - minorExponent(from))
}

/** 换算金额并取整到目标币种最小单位；缺汇率返回 null */
export function convertMoney(money: Money, to: Currency, rates: FxRate[]): Money | null {
  const exact = convertMinorExact(money.amountMinor, money.currency, to, rates)
  return exact === null ? null : { amountMinor: Math.round(exact), currency: to }
}

/** 中位数（用于竞品中位价）；空列表返回 null */
export function medianMinor(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  return Math.round(value)
}

export function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError('COSTING_INVALID_INPUT', `${name} 必须为正整数`, {
      details: { name, value },
    })
  }
}
