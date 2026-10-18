import {
  type ConnectorContext,
  createRegistry,
  type FetchTask,
  type ReservationMode,
  type SourceConnector,
  type SourceRegistry,
} from '@product-res/datasources'
import type { Database } from '@product-res/db'
import {
  createDbArchive,
  ensureSources,
  expireStaleReservations,
  runQualityChecks,
  runSyncTask,
  type SyncTrigger,
} from '@product-res/marketdata'
import type { DeadLetterSink, QueueBatch, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/** 数据同步队列（每条消息一个同步任务）；队列级流控按最严格的数据源配置 */
export const DATASYNC_QUEUE = 'product-res-datasync'
export const DATASYNC_MAX_RETRIES = 5

export interface DataSyncMessage {
  readonly sourceId: string
  readonly task: FetchTask
  readonly mode: ReservationMode
  readonly trigger: SyncTrigger
}

export interface DataSyncContext {
  readonly db: Database
  readonly registry: SourceRegistry
  /** 读取数据源凭据（部署层 secret）；业务代码不直接读 process.env */
  readonly secret: (name: string) => string | undefined
  readonly now?: () => Date
  readonly fetch?: typeof fetch
  readonly archiveRetentionDays?: number
}

function connectorContext(context: DataSyncContext): ConnectorContext {
  return {
    fetch: context.fetch ?? fetch,
    secret: context.secret,
    now: context.now ?? (() => new Date()),
  }
}

function isMessage(body: unknown): body is DataSyncMessage {
  const value = body as Partial<DataSyncMessage> | null
  return (
    typeof value?.sourceId === 'string' &&
    typeof value.task?.kind === 'string' &&
    typeof value.task?.marketplace === 'string' &&
    (value.mode === 'scheduled' || value.mode === 'manual') &&
    (value.trigger === 'scheduled' || value.trigger === 'manual' || value.trigger === 'replay')
  )
}

/**
 * 消费数据同步任务：可重试错误按队列策略重试，耗尽后进入死信；
 * 额度不足（deferred）、停用（skipped）与永久错误直接确认，结果在 sync_run 中可查。
 */
export async function consumeDataSync(
  batch: QueueBatch<unknown>,
  context: DataSyncContext,
  sink: DeadLetterSink<unknown>,
) {
  const archive = createDbArchive(context.db, context.archiveRetentionDays)
  const ctx = connectorContext(context)
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      if (!isMessage(message.body)) {
        log.warn('datasync.invalid_message', { messageId: message.id })
        message.ack()
        return
      }
      const connector = context.registry.get(message.body.sourceId)
      if (!connector) {
        await sink.failed(message, { code: 'UNKNOWN_SOURCE', retryable: false })
        message.ack()
        return
      }
      try {
        const outcome = await runSyncTask(
          { db: context.db, archive, ctx },
          connector,
          message.body.task,
          {
            mode: message.body.mode,
            trigger: message.body.trigger,
          },
        )
        if (outcome.status === 'failed' && outcome.error.retryable) {
          if (message.attempts > DATASYNC_MAX_RETRIES) {
            await sink.failed(message, { code: outcome.error.code, retryable: true })
            message.ack()
          } else message.retry()
          return
        }
        message.ack()
      } catch (error) {
        // 数据库等基础设施错误：重试，耗尽后进入死信
        log.error('datasync.consume_failed', {
          messageId: message.id,
          sourceId: message.body.sourceId,
          error,
        })
        if (message.attempts > DATASYNC_MAX_RETRIES) {
          await sink.failed(message, { code: 'DATASYNC_INTERNAL', retryable: true })
          message.ack()
        } else message.retry()
      }
    }),
  )
}

/** 每日维护：对账悬挂预扣、清理过期原始响应、运行数据质量检查 */
export async function runDataMaintenance(context: DataSyncContext, scheduledAt: Date) {
  const archive = createDbArchive(context.db, context.archiveRetentionDays)
  const expired = await expireStaleReservations(context.db, scheduledAt)
  const purged = await archive.purgeExpired(scheduledAt)
  const issues = await runQualityChecks(context.db, scheduledAt)
  log.info('datasync.daily_maintenance', { expired, purged, issues })
}

/** 注册数据层定时任务；每日流水线 02:00 新加坡时间（docs/plan §14.4） */
export function registerDataSchedules(scheduler: Scheduler, context: DataSyncContext) {
  scheduler.register(
    {
      id: 'datasources-daily-v1',
      cron: '0 2 * * *',
      timeZone: 'Asia/Singapore',
      missedRun: 'once',
    },
    ({ scheduledAt }) => runDataMaintenance(context, scheduledAt),
  )
  scheduler.register(
    { id: 'datasources-reconcile-v1', cron: '*/10 * * * *', timeZone: 'UTC', missedRun: 'skip' },
    async ({ scheduledAt }) => {
      await expireStaleReservations(context.db, scheduledAt)
    },
  )
}

/** 部署中可用的连接器；add-source-connectors 逐个加入。模拟数据源只在显式开启时注册 */
export function createConnectorRegistry(options: { readonly mock?: SourceConnector } = {}) {
  return createRegistry(options.mock ? [options.mock] : [])
}

export async function prepareDataSources(db: Database, registry: SourceRegistry) {
  await ensureSources(db, registry.all())
}
