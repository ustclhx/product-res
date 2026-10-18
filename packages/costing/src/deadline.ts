import { AppError, addDays } from '@product-res/shared'
import type { FollowMode, LogisticsType, Missing, MissingInput } from './types.ts'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`)
  if (!DATE_ONLY.test(value) || Number.isNaN(date.getTime())) {
    throw new AppError('COSTING_INVALID_INPUT', `日期须为 YYYY-MM-DD：${value}`)
  }
  return date
}

export type DeadlineInput = {
  /** 节点销售开始日（UTC 日期 YYYY-MM-DD） */
  saleStartDate: string
  logisticsType: LogisticsType
  /** 物流时长 */
  transitDays: number
  /** Amazon FBA 入库上架时长，仅 amazon-fba 必需 */
  inboundDays?: number | null
  procurementDays?: number | null
  mode: FollowMode
  /** 微改良打样天数，仅 improved 必需 */
  sampleDays?: number | null
  listingPrepDays?: number | null
}

/**
 * 最晚决定日 = 节点销售开始日 − 物流时长（FBA 再加入库）− 采购时长（微改良再加打样）− 上架准备。
 * 与 packages/selection 的 deadline 同语义；这里自带一份以免纯函数包之间互相依赖。
 */
export function latestDecisionDate(input: DeadlineInput): { status: 'ok'; date: string } | Missing {
  const missing: MissingInput[] = []
  if (input.procurementDays == null) missing.push('procurementDays')
  if (input.listingPrepDays == null) missing.push('listingPrepDays')
  if (input.logisticsType === 'amazon-fba' && input.inboundDays == null) missing.push('inboundDays')
  if (input.mode === 'improved' && input.sampleDays == null) missing.push('sampleDays')
  if (missing.length > 0) return { status: 'missing', missing }

  const days =
    input.transitDays +
    (input.logisticsType === 'amazon-fba' ? (input.inboundDays ?? 0) : 0) +
    (input.procurementDays ?? 0) +
    (input.mode === 'improved' ? (input.sampleDays ?? 0) : 0) +
    (input.listingPrepDays ?? 0)
  const date = addDays(parseDate(input.saleStartDate), -days)
  return { status: 'ok', date: date.toISOString().slice(0, 10) }
}

/** 最晚决定日早于今天即“来不及”（当天仍来得及） */
export function isTooLate(deadline: string, today: string): boolean {
  return parseDate(deadline).getTime() < parseDate(today).getTime()
}
