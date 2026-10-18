import type { Database } from '@product-res/db'
import { dataQualityIssue, dataSource, observation, syncRun } from '@product-res/db/schema'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'

/** 质量检查阈值（specs/data-quality），可配置 */
export interface QualityThresholds {
  /** 关键字段缺失率上限，默认 0.2 */
  readonly missingRate: number
  /** 日环比跳变倍数，默认 3 */
  readonly spikeRatio: number
  /** 来源间差异 (max − min) ÷ min 上限，默认 0.5 */
  readonly divergence: number
  /** 最近一次成功同步距今小时数上限，默认 36 */
  readonly staleHours: number
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  missingRate: 0.2,
  spikeRatio: 3,
  divergence: 0.5,
  staleHours: 36,
}

/** 做跳变与来源差异检查的指标 */
const CHECKED_METRICS = [
  'price',
  'sales_estimate_monthly',
  'sold_quantity_daily',
  'bsr',
  'seller_count',
]

type IssueType = (typeof dataQualityIssue.$inferInsert)['type']

interface IssueInput {
  readonly type: IssueType
  readonly fingerprint: string
  readonly sourceId?: string | null
  readonly entityType?: string | null
  readonly entityId?: string | null
  readonly metric?: string | null
  readonly detail: Record<string, unknown>
}

/** 同一问题（fingerprint）重复出现合并为一条，只更新最近出现时间与详情；已解决的重新打开 */
async function upsertIssues(db: Database, issues: readonly IssueInput[], now: Date) {
  if (issues.length === 0) return
  await db
    .insert(dataQualityIssue)
    .values(issues.map((i) => ({ ...i, firstSeenAt: now, lastSeenAt: now })))
    .onConflictDoUpdate({
      target: dataQualityIssue.fingerprint,
      set: {
        lastSeenAt: now,
        detail: sql`excluded.detail`,
        status: sql`case when ${dataQualityIssue.status} = 'resolved' then 'open' else ${dataQualityIssue.status} end`,
      },
    })
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * 同步后的质量检查：缺失、跳变、来源差异、新鲜度、同步失败。
 * day 为检查的观测日期（默认今天 UTC）；返回发现的问题数。
 */
export async function runQualityChecks(
  db: Database,
  now: Date,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
  day = isoDay(now),
) {
  const issues: IssueInput[] = []
  const yesterday = isoDay(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000))

  // 来源差异：同一实体同日同指标至少两个来源，且 (max − min) ÷ min 超过阈值
  const divergent = await db
    .select({
      entityType: observation.entityType,
      entityId: observation.entityId,
      metric: observation.metric,
      min: sql<number>`min(${observation.value})::float8`,
      max: sql<number>`max(${observation.value})::float8`,
      sources: sql<string[]>`jsonb_agg(${observation.sourceId} order by ${observation.sourceId})`,
      values: sql<
        number[]
      >`jsonb_agg(${observation.value}::float8 order by ${observation.sourceId})`,
    })
    .from(observation)
    .where(and(eq(observation.observedOn, day), inArray(observation.metric, CHECKED_METRICS)))
    .groupBy(observation.entityType, observation.entityId, observation.metric)
    .having(
      sql`count(distinct ${observation.sourceId}) >= 2 and min(${observation.value}) > 0 and (max(${observation.value}) - min(${observation.value})) / min(${observation.value}) > ${thresholds.divergence}`,
    )
  for (const row of divergent)
    issues.push({
      type: 'source-divergence',
      fingerprint: `divergence:${row.entityId}:${row.metric}`,
      entityType: row.entityType,
      entityId: row.entityId,
      metric: row.metric,
      detail: { day, sources: row.sources, values: row.values, min: row.min, max: row.max },
    })

  // 跳变：同一来源相邻两日的值相差超过倍数
  const spikes = await db.execute<{
    entity_type: string
    entity_id: string
    metric: string
    source_id: string
    today: number
    before: number
  }>(sql`
    select t.entity_type, t.entity_id, t.metric, t.source_id, t.value::float8 as today, y.value::float8 as before
    from ${observation} t
    join ${observation} y
      on y.entity_type = t.entity_type and y.entity_id = t.entity_id and y.metric = t.metric
     and y.source_id = t.source_id and y.observed_on = ${yesterday}::date
    where t.observed_on = ${day}::date
      and t.metric in (${sql.join(
        CHECKED_METRICS.map((m) => sql`${m}`),
        sql`, `,
      )})
      and y.value > 0 and t.value > 0
      and (t.value / y.value > ${thresholds.spikeRatio} or y.value / t.value > ${thresholds.spikeRatio})
  `)
  for (const row of spikes)
    issues.push({
      type: 'spike',
      fingerprint: `spike:${row.source_id}:${row.entity_id}:${row.metric}`,
      sourceId: row.source_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metric: row.metric,
      detail: { day, today: row.today, yesterday: row.before },
    })

  // 缺失：当日由某来源观测到的商品中，缺少价格的比例
  const coverage = await db.execute<{ source_id: string; total: number; with_price: number }>(sql`
    select source_id,
      count(distinct entity_id)::int as total,
      count(distinct entity_id) filter (where metric = 'price')::int as with_price
    from ${observation}
    where observed_on = ${day}::date and entity_type = 'product' and method <> 'import'
      -- 只检查过去 7 天提供过价格的来源；只提供销量估算等的来源不算缺失
      and source_id in (
        select distinct source_id from ${observation}
        where metric = 'price' and observed_on between ${day}::date - 7 and ${day}::date
      )
    group by source_id
  `)
  for (const row of coverage) {
    const rate = row.total === 0 ? 0 : 1 - row.with_price / row.total
    if (rate > thresholds.missingRate)
      issues.push({
        type: 'missing',
        fingerprint: `missing:${row.source_id}:price`,
        sourceId: row.source_id,
        metric: 'price',
        detail: { day, missingRate: rate, total: row.total },
      })
  }

  // 新鲜度：已启用数据源最近一次成功同步超过阈值
  const enabled = await db
    .select({ id: dataSource.id })
    .from(dataSource)
    .where(eq(dataSource.enabled, true))
  for (const { id } of enabled) {
    const [last] = await db
      .select({ finishedAt: syncRun.finishedAt })
      .from(syncRun)
      .where(and(eq(syncRun.sourceId, id), eq(syncRun.status, 'succeeded')))
      .orderBy(desc(syncRun.finishedAt))
      .limit(1)
    const hours = last?.finishedAt ? (now.getTime() - last.finishedAt.getTime()) / 3_600_000 : null
    if (hours === null || hours > thresholds.staleHours)
      issues.push({
        type: 'stale',
        fingerprint: `stale:${id}`,
        sourceId: id,
        detail: { lastSuccessAt: last?.finishedAt?.toISOString() ?? null, hours },
      })
  }

  // 同步失败：最近 24 小时的失败运行按数据源与错误码合并
  const failures = await db
    .select({
      sourceId: syncRun.sourceId,
      errorCode: syncRun.errorCode,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string>`max(${syncRun.startedAt})`,
    })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.status, 'failed'),
        gte(syncRun.startedAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .groupBy(syncRun.sourceId, syncRun.errorCode)
  for (const row of failures)
    issues.push({
      type: 'sync-failure',
      fingerprint: `sync-failure:${row.sourceId}:${row.errorCode ?? 'UNKNOWN'}`,
      sourceId: row.sourceId,
      detail: { errorCode: row.errorCode, count: row.count, lastAt: row.lastAt },
    })

  await upsertIssues(db, issues, now)
  return issues.length
}

export async function listIssues(
  db: Database,
  filter: { status?: (typeof dataQualityIssue.$inferSelect)['status']; limit?: number } = {},
) {
  return db
    .select()
    .from(dataQualityIssue)
    .where(filter.status ? eq(dataQualityIssue.status, filter.status) : undefined)
    .orderBy(desc(dataQualityIssue.lastSeenAt))
    .limit(filter.limit ?? 100)
}

export async function setIssueStatus(
  db: Database,
  id: string,
  status: (typeof dataQualityIssue.$inferSelect)['status'],
) {
  await db.update(dataQualityIssue).set({ status }).where(eq(dataQualityIssue.id, id))
}
