import type { Database } from '@product-res/db'
import {
  localDay,
  runReadinessWeekly,
  runSelectionDaily,
  runSelectionLabels,
  SELECTION_REPLAY_QUEUE,
  SELECTION_TIME_ZONE,
} from '@product-res/follow'
import type { DeadLetterSink, QueueBatch, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import type { DataSyncContext } from '../datasources/sync.ts'
import { consumeReplay } from './replay.ts'

/** 跟卖选品每日流水线（add-follow-selection design D7）：在 datasources-daily-v1（02:00）之后运行 */
export const SELECTION_DAILY_SCHEDULE = {
  id: 'selection-daily-v1',
  cron: '0 4 * * *',
  timeZone: SELECTION_TIME_ZONE,
  // 停机错过时补跑一次：线索按 簇 × 日期 幂等，补跑不会重复
  missedRun: 'once',
} as const

/** 影子推荐到期打标签（add-shadow-validation tasks 2.2）：每日流水线之后 05:00 SGT；推荐 × 窗口幂等 */
export const SELECTION_LABEL_SCHEDULE = {
  id: 'selection-label-v1',
  cron: '0 5 * * *',
  timeZone: SELECTION_TIME_ZONE,
  missedRun: 'once',
} as const

/** 每周一 05:30 SGT 重算准备度（在当天打标签之后）；同一计算日覆盖写入 */
export const SELECTION_READINESS_SCHEDULE = {
  id: 'selection-readiness-v1',
  cron: '30 5 * * 1',
  timeZone: SELECTION_TIME_ZONE,
  missedRun: 'once',
} as const

interface QueueRegistrar {
  register<T>(
    name: string,
    handler: (batch: QueueBatch<T>, sink: DeadLetterSink<T>) => Promise<void>,
    overrides?: { concurrency?: number },
  ): void
}

/**
 * Node 装配选品流水线：在 engine.register 内调用（参照 registerNodeDataSources）。
 * 计算日取计划触发时刻的新加坡日期，补跑时仍归到原来那一天。
 * 传入 queues 与数据层上下文时注册 Keepa 历史回放队列（复用数据层的连接器注册表与凭据）。
 */
export function registerNodeSelection(input: {
  readonly db: Database
  readonly scheduler: Scheduler
  readonly now?: () => Date
  readonly queues?: QueueRegistrar | undefined
  readonly dataSync?: DataSyncContext | undefined
}) {
  const now = () => input.now?.() ?? new Date()
  input.scheduler.register(SELECTION_DAILY_SCHEDULE, async ({ scheduledAt }) => {
    const results = await runSelectionDaily(input.db, {
      now: now(),
      asOf: localDay(scheduledAt, SELECTION_TIME_ZONE),
    })
    log.info('selection.daily_done', {
      workspaces: results.length,
      directions: results.reduce((n, r) => n + r.directions.length, 0),
      leads: results.reduce((n, r) => n + r.directions.reduce((m, d) => m + d.leads, 0), 0),
      failures: results.reduce((n, r) => n + r.failures.length, 0),
    })
  })
  input.scheduler.register(SELECTION_LABEL_SCHEDULE, async ({ scheduledAt }) => {
    const results = await runSelectionLabels(input.db, {
      now: now(),
      today: localDay(scheduledAt, SELECTION_TIME_ZONE),
    })
    log.info('selection.label_done', {
      workspaces: results.length,
      labeled: results.reduce((n, r) => n + r.labeled, 0),
      failures: results.reduce((n, r) => n + r.failures, 0),
    })
  })
  input.scheduler.register(SELECTION_READINESS_SCHEDULE, async ({ scheduledAt }) => {
    const results = await runReadinessWeekly(input.db, {
      now: now(),
      today: localDay(scheduledAt, SELECTION_TIME_ZONE),
    })
    log.info('selection.readiness_done', {
      workspaces: results.length,
      groups: results.reduce((n, r) => n + r.groups, 0),
    })
  })
  const { queues, dataSync } = input
  if (queues && dataSync) {
    // 回放受 Keepa 每分钟令牌限制，串行消费
    queues.register(SELECTION_REPLAY_QUEUE, (batch, sink) => consumeReplay(batch, dataSync, sink), {
      concurrency: 1,
    })
  }
}
