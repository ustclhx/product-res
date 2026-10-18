import { REVIEW_DAYS } from './labels.ts'

/** 工作台的“今天”、本周与节点倒计时都按新加坡时间（团队所在时区）计算 */
const SGT_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

export function todaySgt(now: Date): string {
  return new Date(now.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10)
}

/** 本周一 00:00（新加坡时间）对应的 UTC 时刻 */
export function weekStartSgt(now: Date): Date {
  const local = new Date(now.getTime() + SGT_OFFSET_MS)
  const day = (local.getUTCDay() + 6) % 7
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day)
  return new Date(monday - SGT_OFFSET_MS)
}

const parse = (date: string) => Date.parse(`${date}T00:00:00Z`)

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS)
}

export function addDaysIso(date: string, days: number): string {
  return new Date(parse(date) + days * DAY_MS).toISOString().slice(0, 10)
}

export type DeadlineTone = 'overdue' | 'soon' | 'normal' | 'none'

/** 待决定队列标记（specs/decision-queue）：已过最晚决定日标红，7 天内（含当天）标橙 */
export function deadlineTone(deadline: string | null, today: string, soonDays = 7): DeadlineTone {
  if (!deadline) return 'none'
  const left = daysBetween(today, deadline)
  if (left < 0) return 'overdue'
  if (left <= soonDays) return 'soon'
  return 'normal'
}

/** 节点下一次起卖日；今天处于销售期内时返回本次起卖日（倒计时为负，界面显示“销售中”） */
export function nextNodeStart(
  node: { startMonth: number; startDay: number; salesDays: number },
  today: string,
): { start: string; daysLeft: number; selling: boolean } {
  const year = Number(today.slice(0, 4))
  const at = (y: number) => {
    // 2/29 在平年取 2/28
    const days = new Date(Date.UTC(y, node.startMonth, 0)).getUTCDate()
    const d = Math.min(node.startDay, days)
    return `${y}-${String(node.startMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  for (const y of [year - 1, year, year + 1]) {
    const start = at(y)
    const left = daysBetween(today, start)
    if (left >= 0 || left > -node.salesDays) return { start, daysLeft: left, selling: left < 0 }
  }
  const start = at(year + 1)
  return { start, daysLeft: daysBetween(today, start), selling: false }
}

/** 回看到期日 = 计划上架日 + 30 天 */
export function reviewDueOn(plannedListingOn: string): string {
  return addDaysIso(plannedListingOn, REVIEW_DAYS)
}
