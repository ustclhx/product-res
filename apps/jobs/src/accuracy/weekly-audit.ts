import type { Database } from '@product-res/db'
import { generateWeeklyAudits } from '@product-res/marketdata'
import type { ScheduleDefinition, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/**
 * 每周人工抽检（openspec/changes/add-accuracy-store-tracking design D7）：周一 06:00 SGT
 * 为每个有被追踪商品的空间生成本周抽检清单。同一空间同一周只生成一次，补跑不会重复。
 * 属于数据流水线，`DATA_PIPELINE_SCHEDULES=paused` 时暂停（见 pipeline-pause.ts）；
 * 暂停期间可在数据中心「人工抽检」中手动生成。
 */
export const ACCURACY_AUDIT_SCHEDULE: ScheduleDefinition = {
  id: 'accuracy-audit-weekly-v1',
  cron: '0 6 * * 1',
  timeZone: 'Asia/Singapore',
  missedRun: 'once',
}

export async function runWeeklyAudits(db: Database, now: Date) {
  const results = await generateWeeklyAudits(db, now)
  for (const r of results)
    if (r.error)
      log.error('accuracy_audit.generate_failed', { error: r.error, workspaceId: r.workspaceId })
  log.info('accuracy_audit.done', {
    workspaces: results.length,
    created: results.filter((r) => r.created).length,
    failed: results.filter((r) => r.error).length,
  })
  return results
}

/** Node 调度注册：在 engine.register 内调用 */
export function registerAccuracyAudit(scheduler: Scheduler, db: Database) {
  scheduler.register(ACCURACY_AUDIT_SCHEDULE, async ({ scheduledAt }) => {
    await runWeeklyAudits(db, scheduledAt)
  })
}
