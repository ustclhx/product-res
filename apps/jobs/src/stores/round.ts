import { type Marketplace, zonedMidnight } from '@product-res/datasources'
import { type Database, jobMessage } from '@product-res/db'
import {
  evaluateStoreTracking,
  loadStoreCollectionTargets,
  localDay,
  markSnapshotted,
  offerCandidates,
  planStoreTasks,
  recordStoreListings,
  SELECTION_TIME_ZONE,
  type SourceAllowance,
  STORE_SNAPSHOT_KINDS,
  STORE_SOURCES,
  STORE_TRACKING_DEFAULTS,
  type StoreTrackingSettings,
} from '@product-res/follow'
import {
  credentialStatus,
  effectiveBudget,
  getSource,
  isPaused,
  type SourceConfig,
  type SyncBatchHook,
  scheduledHeadroom,
} from '@product-res/marketdata'
import { log } from '@product-res/shared/log'
import { and, eq, inArray, like } from 'drizzle-orm'
import type { DailyMessage } from '../datasources/plan.ts'
import { DATASYNC_QUEUE, type DataSyncContext, type DataSyncMessage } from '../datasources/sync.ts'

/**
 * 店铺追踪的调度（add-accuracy-store-tracking tasks 3.2、3.3）：
 * 每日 03:00 SGT（数据层 02:00 投递之后、选品流水线 04:00 之前）先评估已采集的数据
 * （出单信号与线索、升降档、店铺指标），再按周期投递采集任务到同步队列；
 * Amazon 店铺搜索结果由批次回调继续投递报价归属（每日上限，超出顺延到之后几天）。
 * 采集都经同步队列的预扣与结算，额度不足时按现有规则记为 deferred。
 */

export const STORE_TRACKING_SCHEDULE = {
  id: 'store-tracking-daily-v1',
  cron: '0 3 * * *',
  timeZone: SELECTION_TIME_ZONE,
  // 补跑一次：评估按日幂等（线索去重、档位不变不写），投递按幂等键跳过
  missedRun: 'once',
} as const

/** 投递幂等键前缀 */
export const STORE_KEY_PREFIX = 'store-tracking'
export const OFFER_KEY_PREFIX = 'store-offers'
/** 报价顺延最多排到之后几天；更远的丢弃，等下次搜索再发现 */
export const OFFER_HORIZON_DAYS = 7
/** 顺延的报价任务在当天 03:30（SGT）之后可执行 */
const OFFER_START_MINUTES = 3 * 60 + 30

const ACTIVE_STATES = ['pending', 'claimed', 'running']

export interface StoreRoundOptions {
  readonly scheduledAt: Date
  /** 手动触发：只限该空间，忽略周期，按人工额度（硬上限）预扣 */
  readonly workspaceId?: string | undefined
  readonly manual?: boolean | undefined
  /** 手动触发的请求标识，作为投递幂等键的一部分 */
  readonly requestId?: string | undefined
  readonly settings?: Partial<StoreTrackingSettings> | undefined
}

/**
 * 店铺追踪用到的数据源与额度。未注册、停用、缺凭据（如 eBay 未配置）或暂停的来源不进入计划，
 * 其他来源照常。手动触发时 DataForSEO / eBay 不按定时安全线截断（预扣时仍受硬上限约束），
 * SerpApi 始终按日均分配。
 */
export async function storeAllowances(
  db: Database,
  context: Pick<DataSyncContext, 'registry' | 'secret'>,
  now: Date,
  manual: boolean,
) {
  const allowances = new Map<string, SourceAllowance>()
  const skipped: Record<string, string> = {}
  for (const sourceId of Object.values(STORE_SOURCES)) {
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
    const headroom =
      manual && sourceId !== STORE_SOURCES.cross
        ? Number.POSITIVE_INFINITY
        : await scheduledHeadroom(db, sourceId, spec, now)
    allowances.set(sourceId, { connector, headroom })
  }
  return { allowances, skipped }
}

/** 一轮店铺追踪：评估 → 投递采集任务 */
export async function runStoreTrackingRound(context: DataSyncContext, options: StoreRoundOptions) {
  const now = context.now?.() ?? new Date()
  const day = localDay(options.scheduledAt, SELECTION_TIME_ZONE)
  const manual = options.manual === true
  const evaluation = await evaluateStoreTracking(context.db, {
    day,
    now,
    workspaceId: options.workspaceId,
    settings: options.settings,
  })
  const targets = await loadStoreCollectionTargets(context.db, {
    day,
    now,
    workspaceId: options.workspaceId,
    force: manual,
    settings: options.settings,
  })
  const { allowances, skipped } = await storeAllowances(context.db, context, now, manual)
  const plan = planStoreTasks(targets, allowances)
  const prefix = manual
    ? `${STORE_KEY_PREFIX}:manual:${options.requestId ?? now.toISOString()}`
    : `${STORE_KEY_PREFIX}:${day}`
  const messages: DailyMessage[] = plan.tasks.map((t) => ({
    body: {
      sourceId: t.sourceId,
      task: t.task,
      mode: manual ? 'manual' : 'scheduled',
      trigger: manual ? 'manual' : 'scheduled',
      origin: 'store-tracking',
      idempotencyKey: `${prefix}:${t.key}`,
    },
    delaySeconds: 0,
  }))
  const dispatched =
    context.dispatcher && messages.length > 0
      ? await context.dispatcher.dispatch(messages)
      : { enqueued: 0, duplicates: 0 }
  if (context.dispatcher) {
    const snapshotted = plan.tasks.filter((t) => t.productIds.length > 0)
    const byId = new Map(targets.snapshots.map((s) => [s.productId, s]))
    await markSnapshotted(
      context.db,
      snapshotted.flatMap((t) =>
        t.productIds.map((id) => byId.get(id)).filter((s) => s !== undefined),
      ),
      day,
    )
  }
  const summary = {
    day,
    manual,
    workspaceId: options.workspaceId ?? null,
    evaluation: {
      workspaces: evaluation.workspaces.length,
      enrolled: evaluation.workspaces.reduce((n, w) => n + w.enrolled, 0),
      overCap: evaluation.workspaces.reduce((n, w) => n + w.overCap, 0),
      tierChanges: evaluation.workspaces.reduce((n, w) => n + w.tierChanges, 0),
      leads: evaluation.workspaces.reduce((n, w) => n + w.leads, 0),
      leadsWithoutDirection: evaluation.workspaces.reduce((n, w) => n + w.leadsWithoutDirection, 0),
      metricsWritten: evaluation.metricsWritten,
      failures: evaluation.failures.length,
    },
    planned: messages.length,
    ...dispatched,
    searches: targets.searches.length,
    snapshots: targets.snapshots.length,
    truncated: plan.truncated,
    unavailable: plan.unavailable,
    skipped,
    dispatcher: context.dispatcher ? 'queue' : 'none',
  }
  log.info('stores.round_done', summary)
  return summary
}

/** 某日（SGT）报价任务可执行的时刻 */
function offerStart(day: string) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(
    zonedMidnight(y, m, d, SELECTION_TIME_ZONE).getTime() + OFFER_START_MINUTES * 60_000,
  )
}

function nextDay(day: string, n: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 投递报价归属任务：每个 ASIN 一条消息，每天不超过上限，超出的排到之后几天（最多 7 天）。
 * 已在排队的 ASIN 跳过；已查过报价的由 offerCandidates 排除。
 */
export async function dispatchStoreOffers(
  context: DataSyncContext,
  input: {
    readonly marketplace: string
    readonly asins: readonly string[]
    readonly now: Date
    readonly perDay?: number
  },
) {
  const perDay = input.perDay ?? STORE_TRACKING_DEFAULTS.offerCallsPerDay
  if (!context.dispatcher || input.asins.length === 0 || perDay <= 0)
    return { enqueued: 0, deferredDays: 0, dropped: 0 }
  const db = context.db
  const today = localDay(input.now, SELECTION_TIME_ZONE)
  const queued = await db
    .select({ key: jobMessage.idempotencyKey })
    .from(jobMessage)
    .where(
      and(
        eq(jobMessage.queue, DATASYNC_QUEUE),
        like(jobMessage.idempotencyKey, `${OFFER_KEY_PREFIX}:%:${input.marketplace}:%`),
        inArray(jobMessage.state, ACTIVE_STATES),
      ),
    )
  const pending = new Set(queued.map((r) => r.key?.split(':').at(-1)))
  const fresh = [...new Set(input.asins)].filter((asin) => !pending.has(asin))
  const days = Array.from({ length: OFFER_HORIZON_DAYS }, (_, i) => nextDay(today, i))
  const used = new Map<string, number>()
  for (const day of days) {
    const rows = await db
      .select({ key: jobMessage.idempotencyKey })
      .from(jobMessage)
      .where(
        and(
          eq(jobMessage.queue, DATASYNC_QUEUE),
          like(jobMessage.idempotencyKey, `${OFFER_KEY_PREFIX}:${day}:%`),
        ),
      )
    used.set(day, rows.length)
  }
  const messages: DailyMessage[] = []
  let dropped = 0
  for (const asin of fresh) {
    const day = days.find((d) => (used.get(d) ?? 0) < perDay)
    if (!day) {
      dropped++
      continue
    }
    used.set(day, (used.get(day) ?? 0) + 1)
    const body: DataSyncMessage & { idempotencyKey: string } = {
      sourceId: STORE_SOURCES.amazon,
      task: {
        kind: 'amazon-offers',
        marketplace: input.marketplace as Marketplace,
        scope: { ids: [asin] },
      },
      mode: 'scheduled',
      trigger: 'scheduled',
      origin: 'store-tracking',
      idempotencyKey: `${OFFER_KEY_PREFIX}:${day}:${input.marketplace}:${asin}`,
    }
    const at = day === today ? input.now : offerStart(day)
    messages.push({
      body,
      delaySeconds: Math.max(0, Math.ceil((at.getTime() - input.now.getTime()) / 1000)),
    })
  }
  const result = messages.length > 0 ? await context.dispatcher.dispatch(messages) : { enqueued: 0 }
  const deferredDays = new Set(
    messages.filter((m) => m.delaySeconds > 0).map((m) => m.body.idempotencyKey.split(':')[1]),
  ).size
  if (dropped > 0)
    log.info('stores.offers_backlog_full', { marketplace: input.marketplace, dropped, perDay })
  return { enqueued: result.enqueued, deferredDays, dropped }
}

/**
 * 同步批次回调：店铺新品归属与仍在售状态写入 store_listing；店铺搜索的新 ASIN 投递报价归属。
 * 失败由 runSyncTask 记录日志，不影响同步本身。
 */
export function createStoreBatchHook(
  context: DataSyncContext,
): NonNullable<DataSyncContext['onBatch']> {
  return async (message: DataSyncMessage, input: Parameters<SyncBatchHook>[0]) => {
    const { task, batch, ids, fetchedAt } = input
    const observedOn = localDay(fetchedAt, SELECTION_TIME_ZONE)
    if (
      task.kind === 'seller-new-listings' ||
      task.kind === 'amazon-offers' ||
      STORE_SNAPSHOT_KINDS.has(task.kind)
    ) {
      const result = await recordStoreListings(context.db, { task, batch, ids, observedOn })
      if (result.created.length > 0)
        log.info('stores.listings_found', {
          kind: task.kind,
          marketplace: task.marketplace,
          created: result.created.length,
        })
    }
    if (task.kind === 'amazon-search' && message.origin === 'store-tracking') {
      const asins = await offerCandidates(context.db, {
        marketplace: task.marketplace,
        batch,
        ids,
      })
      const now = context.now?.() ?? new Date()
      const result = await dispatchStoreOffers(context, {
        marketplace: task.marketplace,
        asins,
        now,
      })
      log.info('stores.offers_dispatched', {
        marketplace: task.marketplace,
        candidates: asins.length,
        ...result,
      })
    }
  }
}
