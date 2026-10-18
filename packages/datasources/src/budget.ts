import type { BudgetSpec } from './types.ts'

/**
 * 额度规则的纯函数部分（specs/source-budgets）。数据库预扣在 @product-res/marketdata 中，
 * 这里只回答“周期键是什么”“这次能不能扣”。
 */

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** 当前时刻所在的预算周期键：day → YYYY-MM-DD，month → YYYY-MM，minute → YYYY-MM-DDTHH:mm（均按 spec 时区） */
export function periodKey(spec: Pick<BudgetSpec, 'period' | 'timeZone'>, now: Date): string {
  const p = localParts(now, spec.timeZone)
  const day = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  if (spec.period === 'month') return `${p.year}-${pad(p.month)}`
  if (spec.period === 'day') return day
  return `${day}T${pad(p.hour)}:${pad(p.minute)}`
}

/** 指定时区某日 00:00 对应的 UTC 时刻（处理夏令时：迭代修正偏移） */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day)
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const diff = asUtc - Date.UTC(year, month - 1, day)
    if (diff === 0) break
    guess -= diff
  }
  return new Date(guess)
}

/** 下一个周期开始时刻，用于提示“次日几点重置” */
export function nextReset(spec: Pick<BudgetSpec, 'period' | 'timeZone'>, now: Date): Date {
  const p = localParts(now, spec.timeZone)
  if (spec.period === 'minute')
    return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000)
  if (spec.period === 'month') {
    const year = p.month === 12 ? p.year + 1 : p.year
    const month = p.month === 12 ? 1 : p.month + 1
    return zonedMidnight(year, month, 1, spec.timeZone)
  }
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
  return zonedMidnight(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    spec.timeZone,
  )
}

/** 当月剩余天数（含今天），按 spec 时区 */
export function daysRemainingInMonth(timeZone: string, now: Date): number {
  const p = localParts(now, timeZone)
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate()
  return daysInMonth - p.day + 1
}

/** 月度预算按日均分配并滚动结余：今天可用 = (安全线 − 今天之前已用) ÷ 剩余天数 */
export function dailyAllowance(
  monthlySafetyLine: number,
  usedBeforeToday: number,
  daysRemaining: number,
) {
  if (daysRemaining <= 0) return 0
  return Math.max(0, Math.floor((monthlySafetyLine - usedBeforeToday) / daysRemaining))
}

export type ReservationMode = 'scheduled' | 'manual'

export interface BudgetUsage {
  /** 本周期已预扣 + 已结算 */
  readonly usedInPeriod: number
  /** 月度日分配时：今天已用（属于本月） */
  readonly usedToday?: number
}

export type ReservationDecision =
  | { readonly ok: true; readonly limit: number }
  | {
      readonly ok: false
      readonly limit: number
      readonly reason: 'safety-line' | 'hard-cap' | 'daily-allowance'
    }

/**
 * 判断一次预扣是否允许：
 * - 定时任务不超过安全线（月度日分配时还不超过今日额度）
 * - 人工刷新可用到硬上限
 * - 任何情况都不超过硬上限
 */
export function decideReservation(
  spec: BudgetSpec,
  usage: BudgetUsage,
  amount: number,
  mode: ReservationMode,
  now: Date,
): ReservationDecision {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Reservation amount must be >= 0')
  const after = usage.usedInPeriod + amount
  if (after > spec.hardCap) return { ok: false, limit: spec.hardCap, reason: 'hard-cap' }
  if (mode === 'manual') return { ok: true, limit: spec.hardCap }
  if (after > spec.safetyLine) return { ok: false, limit: spec.safetyLine, reason: 'safety-line' }
  if (
    spec.period === 'month' &&
    (spec.monthlyAllocation ?? 'daily-rollover') === 'daily-rollover'
  ) {
    const usedToday = usage.usedToday ?? 0
    const allowance = dailyAllowance(
      spec.safetyLine,
      usage.usedInPeriod - usedToday,
      daysRemainingInMonth(spec.timeZone, now),
    )
    if (usedToday + amount > allowance)
      return { ok: false, limit: allowance, reason: 'daily-allowance' }
    return { ok: true, limit: allowance }
  }
  return { ok: true, limit: spec.safetyLine }
}

/** 校验团队配置的安全线：不超过硬上限，且为非负整数 */
export function validateSafetyLine(spec: BudgetSpec, safetyLine: number): string | null {
  if (!Number.isInteger(safetyLine) || safetyLine < 0) return '安全线必须是非负整数'
  if (safetyLine > spec.hardCap) return `安全线不能超过硬上限 ${spec.hardCap}`
  return null
}
