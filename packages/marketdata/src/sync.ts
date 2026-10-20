import {
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  isConnectorError,
  type NormalizedBatch,
  nextReset,
  type ReservationMode,
  type SourceConnector,
} from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { rawPayload } from '@product-res/db/schema'
import { log } from '@product-res/shared/log'
import { eq } from 'drizzle-orm'
import type { RawArchive } from './archive.ts'
import { reconcileExternalRemaining, release, reserve, settle } from './budgets.ts'
import {
  upsertCategories,
  upsertEntities,
  upsertObservations,
  upsertReviews,
} from './observations.ts'
import { finishRun, type SyncTrigger, startRun } from './runs.ts'
import { effectiveBudget, getSource, pauseSource, type SourceConfig } from './sources.ts'

export interface SyncDeps {
  readonly db: Database
  readonly archive: RawArchive
  readonly ctx: ConnectorContext
}

/**
 * 每个原始响应写入观测之后的回调（店铺追踪据此记录店铺新品归属与报价）。
 * ids 为本批实体的 entityRef → 表 ID；回调失败只记日志，不影响同步结果与结算。
 */
export type SyncBatchHook = (input: {
  readonly task: FetchTask
  readonly batch: NormalizedBatch
  readonly ids: ReadonlyMap<string, string>
  readonly fetchedAt: Date
}) => Promise<void>

export type SyncOutcome =
  | {
      readonly status: 'succeeded'
      readonly runId: string
      readonly observations: number
      readonly cursor?: string
    }
  | {
      readonly status: 'deferred'
      readonly runId: string
      readonly reason: string
      readonly resetsAt: Date
    }
  | { readonly status: 'skipped'; readonly runId: string; readonly reason: string }
  | { readonly status: 'failed'; readonly runId: string; readonly error: ConnectorError }

/**
 * 执行一次同步任务（design D4）：预扣额度 → 调用外部接口 → 存档原始响应 → 归一化 → 写入观测 → 结算。
 * - 预扣失败不发出调用，任务记为 deferred
 * - 凭据失效 / 额度耗尽停止该数据源当日任务（暂停到下一个周期或人工处理）
 * - 调用失败按“已花费”结算（宁可少用，不可超额）；调用前失败释放预扣
 * 可重试错误由调用方（队列）决定是否重试：outcome.error.retryable。
 */
export async function runSyncTask(
  deps: SyncDeps,
  connector: SourceConnector,
  task: FetchTask,
  options: {
    readonly mode: ReservationMode
    readonly trigger: SyncTrigger
    readonly onBatch?: SyncBatchHook | undefined
  },
): Promise<SyncOutcome> {
  const { db, archive, ctx } = deps
  const now = ctx.now()
  const source = await getSource(db, connector.id)
  const spec = effectiveBudget(connector, source?.config as SourceConfig | undefined)
  const planned = connector.plan(task)
  const runId = await startRun(db, {
    sourceId: connector.id,
    dataKind: task.kind,
    marketplace: task.marketplace,
    scope: { ...task.scope, ...(task.cursor ? { cursor: task.cursor } : {}) },
    trigger: options.trigger,
    planned,
    startedAt: now,
  })
  if (!source?.enabled) {
    await finishRun(db, runId, {
      status: 'skipped',
      errorCode: 'SOURCE_DISABLED',
      finishedAt: ctx.now(),
    })
    return { status: 'skipped', runId, reason: 'SOURCE_DISABLED' }
  }
  const reservation = await reserve(db, {
    sourceId: connector.id,
    spec,
    amount: planned,
    mode: options.mode,
    now,
    runId,
  })
  if (!reservation.ok) {
    await finishRun(db, runId, {
      status: 'deferred',
      errorCode: `BUDGET_${reservation.reason.toUpperCase().replace('-', '_')}`,
      finishedAt: ctx.now(),
    })
    return { status: 'deferred', runId, reason: reservation.reason, resetsAt: reservation.resetsAt }
  }
  let called = false
  try {
    called = true
    const result = await connector.fetch(task, ctx)
    let written = 0
    let cursor: string | undefined
    for (const payload of result.payloads) {
      const fetchedAt = new Date(payload.fetchedAt)
      const archived = await archive.put({
        sourceId: connector.id,
        runId,
        task: {
          kind: task.kind,
          marketplace: task.marketplace,
          scope: task.scope,
          cursor: task.cursor ?? null,
        },
        request: payload.request,
        status: payload.status,
        body: payload.body,
        fetchedAt,
      })
      const batch = connector.normalize(payload)
      const ids = await upsertEntities(db, batch.entities)
      written += await upsertObservations(db, batch.observations, ids, {
        sourceId: connector.id,
        fetchedAt,
        rawPayloadId: archived.id,
      })
      if (batch.categories?.length) written += await upsertCategories(db, batch.categories)
      if (batch.reviews?.length)
        await upsertReviews(db, batch.reviews, ids, { sourceId: connector.id, fetchedAt })
      if (options.onBatch)
        await options.onBatch({ task, batch, ids, fetchedAt }).catch((error: unknown) =>
          log.error('datasource.batch_hook_failed', {
            sourceId: connector.id,
            kind: task.kind,
            runId,
            error,
          }),
        )
      cursor = batch.nextCursor ?? cursor
      if (payload.remainingQuota !== undefined)
        await reconcileExternalRemaining(db, connector.id, spec, payload.remainingQuota, now)
    }
    await settle(db, reservation.reservationId, result.cost ?? planned)
    await finishRun(db, runId, {
      status: 'succeeded',
      calls: result.payloads.length,
      cost: result.cost ?? planned,
      okCount: written,
      finishedAt: ctx.now(),
    })
    return { status: 'succeeded', runId, observations: written, ...(cursor ? { cursor } : {}) }
  } catch (error) {
    const connectorError = isConnectorError(error)
      ? error
      : new ConnectorError('invalid-response', 'NORMALIZE_FAILED', { cause: error })
    if (called) await settle(db, reservation.reservationId, planned)
    else await release(db, reservation.reservationId)
    if (connectorError.kind === 'auth') await pauseSource(db, connector.id, 'auth', null)
    // 额度耗尽只停当日（specs/connector-dataforseo-amazon「AIsa 余额不足」）：月度预算的来源
    // 也在次日恢复尝试，避免外部充值后整月停摆；分钟级令牌桶按下一分钟恢复
    if (connectorError.kind === 'quota')
      await pauseSource(
        db,
        connector.id,
        'quota',
        nextReset({ ...spec, period: spec.period === 'month' ? 'day' : spec.period }, now),
      )
    await finishRun(db, runId, {
      status: 'failed',
      calls: called ? 1 : 0,
      cost: called ? planned : 0,
      failCount: 1,
      errorCode: connectorError.code,
      finishedAt: ctx.now(),
    })
    log.warn('datasource.sync_failed', {
      sourceId: connector.id,
      kind: task.kind,
      runId,
      errorKind: connectorError.kind,
      code: connectorError.code,
    })
    return { status: 'failed', runId, error: connectorError }
  }
}

/**
 * 回放：用存档的原始响应重新生成观测值，不调用外部接口、不消耗额度。
 * 已过保留期的存档跳过。
 */
export async function replayPayloads(
  deps: Pick<SyncDeps, 'db' | 'archive'>,
  connector: SourceConnector,
  payloadIds: readonly string[],
) {
  let replayed = 0
  let expired = 0
  for (const id of payloadIds) {
    const [meta] = await deps.db.select().from(rawPayload).where(eq(rawPayload.id, id))
    const stored = await deps.archive.get(id)
    if (!meta || !stored) {
      expired++
      continue
    }
    const task = meta.task as unknown as FetchTask
    const batch = connector.normalize({
      sourceId: connector.id,
      task,
      request: meta.request,
      status: meta.status,
      body: new TextDecoder().decode(stored.body),
      fetchedAt: meta.fetchedAt.toISOString(),
    })
    const ids = await upsertEntities(deps.db, batch.entities)
    replayed += await upsertObservations(deps.db, batch.observations, ids, {
      sourceId: connector.id,
      fetchedAt: meta.fetchedAt,
      rawPayloadId: id,
    })
  }
  return { replayed, expired }
}
