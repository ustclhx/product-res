import type { Database } from '@product-res/db'
import { localDay, runSelectionDaily, SELECTION_TIME_ZONE } from '@product-res/follow'
import type { Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/** 跟卖选品每日流水线（add-follow-selection design D7）：在 datasources-daily-v1（02:00）之后运行 */
export const SELECTION_DAILY_SCHEDULE = {
  id: 'selection-daily-v1',
  cron: '0 4 * * *',
  timeZone: SELECTION_TIME_ZONE,
  // 停机错过时补跑一次：线索按 簇 × 日期 幂等，补跑不会重复
  missedRun: 'once',
} as const

/**
 * Node 装配选品流水线：在 engine.register 内调用（参照 registerNodeDataSources）。
 * 计算日取计划触发时刻的新加坡日期，补跑时仍归到原来那一天。
 */
export function registerNodeSelection(input: {
  readonly db: Database
  readonly scheduler: Scheduler
  readonly now?: () => Date
}) {
  input.scheduler.register(SELECTION_DAILY_SCHEDULE, async ({ scheduledAt }) => {
    const results = await runSelectionDaily(input.db, {
      now: input.now?.() ?? new Date(),
      asOf: localDay(scheduledAt, SELECTION_TIME_ZONE),
    })
    log.info('selection.daily_done', {
      workspaces: results.length,
      directions: results.reduce((n, r) => n + r.directions.length, 0),
      leads: results.reduce((n, r) => n + r.directions.reduce((m, d) => m + d.leads, 0), 0),
      failures: results.reduce((n, r) => n + r.failures.length, 0),
    })
  })
}
