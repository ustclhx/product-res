import type { Database } from '@product-res/db'
import { jobMessage } from '@product-res/db'
import {
  COLLECT_SOURCES,
  type CollectionPlan,
  type CollectStage,
  loadCollectionTargets,
  localDay,
  planCollections,
  SELECTION_TIME_ZONE,
  type SourceAllowance,
} from '@product-res/follow'
import {
  credentialStatus,
  effectiveBudget,
  getSource,
  isPaused,
  type SourceConfig,
  scheduledHeadroom,
} from '@product-res/marketdata'
import type { QueueProducer } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { and, eq, inArray } from 'drizzle-orm'
import type { DataSyncContext, DataSyncMessage } from './sync.ts'

/**
 * 每日流水线的采集投递（add-data-source-hub tasks 3.2，方案 §14.4）：
 * 02:00 生成计划，卖家新品扫描延到 02:10，商品快照与关键词延到 02:30；
 * Keepa 按每分钟令牌错开到 02:30–03:30 窗口。任务进入同步队列后由 consumeDataSync 预扣、重试与死信。
 */
export const STAGE_OFFSET_MINUTES: Readonly<Record<CollectStage, number>> = {
  'seller-scan': 10,
  snapshot: 30,
  keyword: 30,
}
/** 分钟周期数据源（Keepa）可用的分钟数：02:30 到 03:30 详情补全之前 */
export const MINUTE_WINDOW = 60
/** 投递幂等键前缀；同一天的同一任务只投递一次 */
export const DAILY_KEY_PREFIX = 'datasources-daily'

export interface DailyMessage {
  readonly body: DataSyncMessage & { readonly idempotencyKey: string }
  readonly delaySeconds: number
}

/** 幂等投递：跳过当天已投递过的任务键，其余在一个事务内整批写入队列 */
export interface DataSyncDispatcher {
  dispatch(messages: readonly DailyMessage[]): Promise<{ enqueued: number; duplicates: number }>
}

/**
 * Node 队列上的幂等投递：任务键写在消息体的 idempotencyKey（job_message.idempotency_key）。
 * 先查已有键再整批写入（sendBatch 同一事务）：中途重启时要么整批已写入、要么都未写入。
 * 同一 schedule 由调度器的行锁串行触发，不会并发投递同一天。
 */
export function createQueueDispatcher(
  db: Database,
  queue: string,
  producer: QueueProducer<DailyMessage['body']>,
): DataSyncDispatcher {
  return {
    async dispatch(messages) {
      const keys = messages.map((m) => m.body.idempotencyKey)
      const existing = new Set<string>()
      for (let i = 0; i < keys.length; i += 1000) {
        const rows = await db
          .select({ key: jobMessage.idempotencyKey })
          .from(jobMessage)
          .where(
            and(
              eq(jobMessage.queue, queue),
              inArray(jobMessage.idempotencyKey, keys.slice(i, i + 1000)),
            ),
          )
        for (const row of rows) if (row.key) existing.add(row.key)
      }
      const fresh = messages.filter((m) => !existing.has(m.body.idempotencyKey))
      if (fresh.length > 0)
        await producer.sendBatch(fresh.map((m) => ({ body: m.body, delaySeconds: m.delaySeconds })))
      return { enqueued: fresh.length, duplicates: messages.length - fresh.length }
    },
  }
}

/** 计划触发时刻（新加坡时间）是否为周一：每周的 DataForSEO 季节曲线与关键词只在周一生成 */
export function isWeeklyRun(scheduledAt: Date) {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: SELECTION_TIME_ZONE, weekday: 'short' }).format(
      scheduledAt,
    ) === 'Mon'
  )
}

/**
 * 可用于定时采集的数据源与额度。未注册、停用、缺凭据或暂停的数据源不进入计划并记录原因，
 * 有该数据源的采集对象时由计划记为 unavailable。
 */
export async function scheduledAllowances(
  db: Database,
  context: Pick<DataSyncContext, 'registry' | 'secret'>,
  now: Date,
) {
  const allowances = new Map<string, SourceAllowance>()
  const skipped: Record<string, string> = {}
  for (const sourceId of Object.values(COLLECT_SOURCES)) {
    const connector = context.registry.get(sourceId)
    if (!connector) {
      skipped[sourceId] = 'not-registered'
      continue
    }
    const row = await getSource(db, sourceId)
    if (!row?.enabled) skipped[sourceId] = 'disabled'
    else if (credentialStatus(connector, context.secret, row) === 'missing')
      skipped[sourceId] = 'credentials-missing'
    else if (isPaused(row, now)) skipped[sourceId] = `paused:${row.pausedReason}`
    if (skipped[sourceId]) continue
    const spec = effectiveBudget(connector, row?.config as SourceConfig | undefined)
    allowances.set(sourceId, {
      connector,
      headroom: await scheduledHeadroom(db, sourceId, spec, now),
      ...(spec.period === 'minute' ? { minuteSlots: MINUTE_WINDOW } : {}),
    })
  }
  return { allowances, skipped }
}

/** 计划 → 队列消息：幂等键带计划日期（新加坡），延迟按阶段时间表与 Keepa 时间槽计算 */
export function toDailyMessages(
  plan: CollectionPlan,
  day: string,
  scheduledAt: Date,
  now: Date,
): DailyMessage[] {
  return plan.tasks.map((t) => {
    const at = scheduledAt.getTime() + (STAGE_OFFSET_MINUTES[t.stage] + t.slot) * 60_000
    return {
      body: {
        sourceId: t.sourceId,
        task: t.task,
        mode: 'scheduled',
        trigger: 'scheduled',
        idempotencyKey: `${DAILY_KEY_PREFIX}:${day}:${t.key}`,
      },
      delaySeconds: Math.max(0, Math.ceil((at - now.getTime()) / 1000)),
    }
  })
}

/**
 * 每日采集投递：读取启用方向 → 计划 → 幂等投递。补跑（missedRun once）沿用原计划日，
 * 同一天重复触发只投递尚未投递的任务；超过安全线的任务顺延到之后的运行。
 */
export async function dispatchDailyCollections(context: DataSyncContext, scheduledAt: Date) {
  const now = context.now?.() ?? new Date()
  const day = localDay(scheduledAt, SELECTION_TIME_ZONE)
  const weekly = isWeeklyRun(scheduledAt)
  const { allowances, skipped } = await scheduledAllowances(context.db, context, now)
  for (const [sourceId, reason] of Object.entries(skipped))
    log.info('datasync.daily_source_skipped', { sourceId, reason })
  const targets = await loadCollectionTargets(context.db, { asOf: day, keywords: weekly })
  const plan = planCollections(targets, allowances, { keywords: weekly })
  const messages = toDailyMessages(plan, day, scheduledAt, now)
  const result =
    context.dispatcher && messages.length > 0
      ? await context.dispatcher.dispatch(messages)
      : { enqueued: 0, duplicates: 0 }
  log.info('datasync.daily_dispatch', {
    day,
    weekly,
    planned: messages.length,
    ...result,
    truncated: plan.truncated,
    unavailable: plan.unavailable,
    dispatcher: context.dispatcher ? 'queue' : 'none',
  })
  return { day, weekly, plan, skipped, ...result }
}
