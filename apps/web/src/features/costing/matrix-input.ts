import type {
  FxRate,
  Improvement,
  LogisticsProfile,
  MatrixCell,
  ShippingFormula,
  SupplierQuote,
} from '@product-res/costing'
import { medianMinor } from '@product-res/costing'
import type { LeadImprovement, LogisticsProfileRow, SupplierQuoteRow } from '@product-res/db'
import { nextOccurrence } from '@product-res/selection'
import { MISSING_INPUT_LABELS, UNAVAILABLE_LABELS } from './labels.ts'

/**
 * 核算矩阵输入的纯函数部分（tasks 3.1）：库表行 → packages/costing 类型、汇率交叉、竞品中位价、
 * 最近节点与格子说明。数据库读取在 matrix.server.ts。
 */

export function toCostingQuote(row: SupplierQuoteRow): SupplierQuote {
  return {
    id: row.id,
    currency: row.currency,
    tiers: row.tiers,
    moq: row.moq,
    weightG: row.weightG,
    dimensions: row.dimensions ?? null,
    confidence: row.confidence,
    procurementDays: row.procurementDays,
  }
}

export function toCostingProfile(row: LogisticsProfileRow): LogisticsProfile {
  return {
    id: row.id,
    platform: row.platform,
    type: row.type,
    transitDays: row.transitDays,
    headFreight: (row.headFreight as ShippingFormula | null) ?? null,
    lastMile: (row.lastMile as ShippingFormula | null) ?? null,
    bannedAttributes: row.bannedAttributes,
  }
}

/** 单价加成与改款费都录入后才是可计算的微改良；只有改良点说明时视为缺少参数 */
export function toImprovement(value: LeadImprovement | null | undefined): Improvement | null {
  if (!value || value.unitSurchargeRate == null || !value.toolingCost) return null
  return {
    unitSurchargeRate: value.unitSurchargeRate,
    toolingCost: value.toolingCost,
    sampleDays: value.sampleDays ?? null,
  }
}

/**
 * fx_rate 主值以 {币种}/CNY 观测（1 单位币种 = rate CNY）。核算需要报价币种 → 售价币种等任意两币种，
 * 这里经 CNY 交叉成全部有序对；没有观测的币种不出现，核算时报告缺少汇率。
 */
export function crossRates(cnyPer: ReadonlyMap<string, number>): FxRate[] {
  const all = new Map<string, number>([['CNY', 1], ...cnyPer])
  const rates: FxRate[] = []
  for (const [from, a] of all)
    for (const [to, b] of all)
      if (from !== to && a > 0 && b > 0) rates.push({ from, to, rate: a / b })
  return rates
}

/**
 * 竞品中位价：簇内各成员最近一次价格主值的中位数。成员币种不一致时取出现最多的币种，
 * 其余不参与（不在这里换算，避免把汇率误差带进默认售价）。价格观测为主单位。
 */
export function competitorMedian(
  prices: readonly { value: number; currency: string | null }[],
  fallbackCurrency: string,
): { amountMinor: number; currency: string; sampleSize: number } | null {
  const valid = prices.filter((p) => Number.isFinite(p.value) && p.value > 0)
  if (valid.length === 0) return null
  const counts = new Map<string, number>()
  for (const p of valid) {
    const c = (p.currency ?? fallbackCurrency).toUpperCase()
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallbackCurrency
  const values = valid
    .filter((p) => (p.currency ?? fallbackCurrency).toUpperCase() === currency)
    .map((p) => Math.round(p.value * 100))
  const median = medianMinor(values)
  return median === null ? null : { amountMinor: median, currency, sampleSize: values.length }
}

/** 方向关联节点中下一次销售开始日最近的一个；没有节点返回 null（不算最晚决定日） */
export function nearestNode<
  T extends { id: string; name: string; startMonth: number; startDay: number },
>(nodes: readonly T[], today: string): { id: string; name: string; saleStartDate: string } | null {
  let best: { id: string; name: string; saleStartDate: string } | null = null
  for (const n of nodes) {
    const start = nextOccurrence(n.startMonth, n.startDay, today)
    if (!best || start < best.saleStartDate) best = { id: n.id, name: n.name, saleStartDate: start }
  }
  return best
}

/** 格子不可用的说明：低于 MOQ、禁运（带冲突属性）、来不及、缺少：… */
export function cellIssues(
  cell: Pick<MatrixCell, 'reasons' | 'missing' | 'bannedAttributes'>,
): string[] {
  return cell.reasons.map((r) => {
    if (r === 'missing-input')
      return `缺少：${cell.missing.map((m) => MISSING_INPUT_LABELS[m] ?? m).join('、')}`
    if (r === 'shipping-ban' && cell.bannedAttributes.length > 0)
      return `禁运（${cell.bannedAttributes.join('、')}）`
    return UNAVAILABLE_LABELS[r]
  })
}

export const cellKey = (c: { quoteId: string; profileId: string; mode: string }) =>
  `${c.quoteId}:${c.profileId}:${c.mode}`
