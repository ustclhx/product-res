import { recordLastCronAt } from '@product-res/db'
import type { DatabaseAccess } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/** 默认每 5 分钟；Cloudflare staging reduced profile 每半小时执行此任务组。 */
export const HEARTBEAT_CRON = '*/5 * * * *'

/**
 * 记录最近一次成功运行的时间，供 `/api/health` 的 `jobs.lastCronAt` 判断定时任务是否停摆
 * （specs/system-health「后台 Worker 心跳」）。
 */
export async function runHeartbeat(
  context: { db: DatabaseAccess },
  now: Date = new Date(),
): Promise<void> {
  await recordLastCronAt(context.db.business(), now)
  log.info('cron.heartbeat', { at: now.toISOString() })
}
