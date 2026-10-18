import { addDays, diffDays, formatDay, parseDay } from './dates.ts'
import type { Platform } from './types.ts'

/**
 * 最晚决定日（docs/plan/selection-workbench.md 第 5.1 节）：
 * 节点销售开始日 − 物流时长（Amazon 再加 FBA 入库）− 采购时长（微改良再加打样）− 上架准备。
 */
export interface LeadTimes {
  readonly logisticsDays: number
  /** 仅 Amazon 计入 */
  readonly fbaInboundDays?: number | undefined
  readonly procurementDays: number
  /** 仅微改良计入 */
  readonly samplingDays?: number | undefined
  readonly listingPrepDays: number
}

export interface DeadlineInput extends LeadTimes {
  /** 节点销售开始日 YYYY-MM-DD */
  readonly salesStart: string
  readonly platform: Platform
  /** 是否微改良（需要打样） */
  readonly improved?: boolean | undefined
}

export interface DeadlineResult {
  /** 最晚决定日 YYYY-MM-DD */
  readonly deadline: string
  readonly totalLeadDays: number
  readonly parts: {
    readonly logisticsDays: number
    readonly fbaInboundDays: number
    readonly procurementDays: number
    readonly samplingDays: number
    readonly listingPrepDays: number
  }
}

/** 无核算时使用的默认提前期（M3 后由核算的物流方案替代） */
export const DEFAULT_LEAD_TIMES: Readonly<Record<Platform, LeadTimes>> = {
  ebay: { logisticsDays: 35, procurementDays: 10, listingPrepDays: 3 },
  amazon: { logisticsDays: 35, fbaInboundDays: 10, procurementDays: 10, listingPrepDays: 3 },
}

function days(value: number | undefined, name: string): number {
  const v = value ?? 0
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a non-negative number`)
  return v
}

export function latestDecisionDate(input: DeadlineInput): DeadlineResult {
  const parts = {
    logisticsDays: days(input.logisticsDays, 'logisticsDays'),
    fbaInboundDays: input.platform === 'amazon' ? days(input.fbaInboundDays, 'fbaInboundDays') : 0,
    procurementDays: days(input.procurementDays, 'procurementDays'),
    samplingDays: input.improved ? days(input.samplingDays, 'samplingDays') : 0,
    listingPrepDays: days(input.listingPrepDays, 'listingPrepDays'),
  }
  const totalLeadDays =
    parts.logisticsDays +
    parts.fbaInboundDays +
    parts.procurementDays +
    parts.samplingDays +
    parts.listingPrepDays
  return { deadline: addDays(input.salesStart, -totalLeadDays), totalLeadDays, parts }
}

/** 节点（每年月日）在 asOf 当天或之后的下一次销售开始日 */
export function nextOccurrence(month: number, day: number, asOf: string): string {
  const year = new Date(parseDay(asOf)).getUTCFullYear()
  for (const y of [year, year + 1]) {
    const candidate = formatDay(Date.UTC(y, month - 1, day))
    if (diffDays(asOf, candidate) >= 0) return candidate
  }
  throw new RangeError('unreachable')
}

/** 距最晚决定日的剩余天数；负数表示已错过 */
export function slackDays(deadline: string, asOf: string): number {
  return diffDays(asOf, deadline)
}
