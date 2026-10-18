import { eq, sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { setting } from './schema/platform.ts'

/**
 * 后台 Worker 心跳（specs/system-health「后台 Worker 心跳」）。
 * 存在 `setting` 表的保留键中（design.md 决策 8），不属于可在后台修改的运行时设置，
 * 因此不在 `SettingValues` 中，也不经过 `getSetting` 的 KV 缓存：健康检查必须读到实时值。
 */
export const JOBS_LAST_CRON_AT_KEY = 'jobs.lastCronAt'

/** 一次最小的数据库往返（健康检查用） */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`)
}

/** 记录 Cron 最近一次成功运行的时间（ISO 8601 UTC 字符串）。 */
export async function recordLastCronAt(db: Database, at: Date): Promise<void> {
  const value = at.toISOString()
  await db
    .insert(setting)
    .values({ key: JOBS_LAST_CRON_AT_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    })
}

/** 读取 Cron 最近一次成功运行的时间；从未运行过时返回 `null`。 */
export async function readLastCronAt(db: Database): Promise<string | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, JOBS_LAST_CRON_AT_KEY))
    .limit(1)
  const value = rows[0]?.value
  return typeof value === 'string' ? value : null
}
