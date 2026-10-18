import type { ConnectorContext, Marketplace, SourceConnector } from '@product-res/datasources'
import {
  cluster,
  clusterMember,
  type Database,
  type Direction,
  direction,
  type Recommendation,
  recommendation,
  scoped,
  syncRun,
} from '@product-res/db'
import {
  effectiveBudget,
  finishRun,
  getSource,
  type MarketProduct,
  productsByIds,
  type RawArchive,
  runSyncTask,
  type SourceConfig,
  startRun,
} from '@product-res/marketdata'
import { addDays, dueWindows, type HitCriteria, platformOf } from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import {
  clusterInputs,
  computeCluster,
  freezeValues,
  loadWorkspaceContext,
  localDay,
  SELECTION_TIME_ZONE,
} from './pipeline.ts'
import { labelAndStore } from './validation.ts'

/**
 * Keepa 历史回放（design D4，tasks 3.1）：团队对 Amazon 方向选择历史节点，
 * 任务按商品预估 Keepa token → 经额度账本预扣（不足则顺延，不超额）→ 取历史并写入观测 →
 * 截取到“节点 − T 日”计算分数并冻结为 replay 推荐 → 用冻结日之后的序列打标签。
 *
 * 回放任务的状态记在 sync_run（trigger = replay）：一条 scope.role = 'replay' 的父记录表示整个回放，
 * 每个 Keepa 批次由 runSyncTask 各记一条（scope.replayId 指向父记录），重试时据此跳过已取过的商品。
 */

export const SELECTION_REPLAY_QUEUE = 'product-res-selection-replay'
export const KEEPA_SOURCE_ID = 'keepa'
/** Keepa product 接口 history=1、不带 offers 时每个 ASIN 1 token（与连接器 plan 一致） */
export const KEEPA_TOKENS_PER_PRODUCT = 1
/** Keepa 单次请求最多 100 个 ASIN */
const KEEPA_BATCH_LIMIT = 100
/** 可重试错误（如 Keepa 429 令牌不足）后的顺延秒数 */
const RETRY_DELAY_SECONDS = 60
/** 回放日之后至少要能打 T+14 标签 */
const MIN_LABEL_DAYS = 14
const MAX_BEFORE_DAYS = 365

export interface ReplayMessage {
  readonly v: 1
  readonly replayId: string
  readonly workspaceId: string
}

/** 发送回放消息的最小队列接口（与 @product-res/platform 的 QueueProducer.send 兼容） */
export interface ReplayQueue {
  send(body: ReplayMessage, options?: { delaySeconds?: number }): Promise<void>
}

export interface StartReplayInput {
  readonly workspaceId: string
  readonly directionId: string
  /** 历史节点日 YYYY-MM-DD */
  readonly nodeDate: string
  /** 截取到节点前 T 日 */
  readonly beforeDays: number
  readonly now?: Date | undefined
}

export interface StartReplayResult {
  readonly replayId: string
  /** 回放推荐的冻结日 = 节点日 − T */
  readonly frozenOn: string
  readonly products: number
  readonly estimatedTokens: number
}

interface ReplayScope {
  readonly role: 'replay'
  readonly workspaceId: string
  readonly directionId: string
  readonly nodeDate: string
  readonly beforeDays: number
  readonly frozenOn: string
  /** 站点 → ASIN */
  readonly asins: Record<string, string[]>
  readonly estimatedTokens: number
}

const invalid = (code: string, message: string) => new AppError(code, message, { status: 400 })
const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

async function directionProducts(db: Database, workspaceId: string, row: Direction) {
  const markets = row.marketplaces.filter((m) => platformOf(m as Marketplace) === 'amazon')
  const s = scoped(db, workspaceId)
  const clusters =
    markets.length === 0
      ? []
      : await s.select(cluster, {
          where: and(
            eq(cluster.directionId, row.id),
            eq(cluster.status, 'active'),
            inArray(cluster.marketplace, markets),
          ) as SQL,
        })
  const members =
    clusters.length === 0
      ? []
      : await s.select(clusterMember, {
          where: inArray(
            clusterMember.clusterId,
            clusters.map((c) => c.id),
          ),
        })
  const products = new Map<string, MarketProduct>(
    (
      await productsByIds(
        db,
        members.map((m) => m.productId),
      )
    ).map((p) => [p.id, p]),
  )
  return { markets, clusters, members, products }
}

/** 发起回放：校验并预估 token，写入回放父记录后投递队列消息 */
export async function startReplay(
  db: Database,
  queue: ReplayQueue,
  input: StartReplayInput,
): Promise<StartReplayResult> {
  const now = input.now ?? new Date()
  if (!isDay(input.nodeDate)) throw invalid('REPLAY_INVALID_DATE', '节点日期格式应为 YYYY-MM-DD')
  if (
    !Number.isInteger(input.beforeDays) ||
    input.beforeDays < 1 ||
    input.beforeDays > MAX_BEFORE_DAYS
  )
    throw invalid('REPLAY_INVALID_OFFSET', `节点前天数需为 1–${MAX_BEFORE_DAYS} 的整数`)
  const frozenOn = addDays(input.nodeDate, -input.beforeDays)
  const today = localDay(now, SELECTION_TIME_ZONE)
  if (addDays(frozenOn, MIN_LABEL_DAYS) > today)
    throw invalid('REPLAY_TOO_RECENT', `回放日之后需要至少 ${MIN_LABEL_DAYS} 天的数据才能打标签`)
  const row = await scoped(db, input.workspaceId).findById(direction, input.directionId)
  const { markets, members, products, clusters } = await directionProducts(
    db,
    input.workspaceId,
    row,
  )
  if (markets.length === 0) throw invalid('REPLAY_NOT_AMAZON', '只能对包含 Amazon 站点的方向回放')
  const marketOf = new Map(clusters.map((c) => [c.id, c.marketplace]))
  const asins: Record<string, string[]> = {}
  for (const member of members) {
    const product = products.get(member.productId)
    const market = marketOf.get(member.clusterId)
    if (!product || !market) continue
    asins[market] = [...new Set([...(asins[market] ?? []), product.platformId])].sort()
  }
  const count = Object.values(asins).reduce((n, list) => n + list.length, 0)
  if (count === 0) throw invalid('REPLAY_NO_PRODUCTS', '方向下还没有 Amazon 簇成员可回放')
  const estimatedTokens = count * KEEPA_TOKENS_PER_PRODUCT
  const scope: ReplayScope = {
    role: 'replay',
    workspaceId: input.workspaceId,
    directionId: row.id,
    nodeDate: input.nodeDate,
    beforeDays: input.beforeDays,
    frozenOn,
    asins,
    estimatedTokens,
  }
  const replayId = await startRun(db, {
    sourceId: KEEPA_SOURCE_ID,
    dataKind: 'rank-history',
    marketplace: (Object.keys(asins)[0] ?? markets[0]) as Marketplace,
    scope: { ...scope },
    trigger: 'replay',
    planned: estimatedTokens,
    startedAt: now,
  })
  await queue.send({ v: 1, replayId, workspaceId: input.workspaceId })
  return { replayId, frozenOn, products: count, estimatedTokens }
}

export interface ReplayDeps {
  readonly db: Database
  readonly connector: SourceConnector
  readonly ctx: ConnectorContext
  readonly archive: RawArchive
  readonly criteria?: HitCriteria | undefined
}

export type ReplayStepResult =
  | {
      readonly status: 'done'
      readonly recommendations: number
      readonly labels: number
    }
  | { readonly status: 'deferred'; readonly retryAt: Date; readonly reason: string }
  | { readonly status: 'failed'; readonly code: string }

export function isReplayMessage(body: unknown): body is ReplayMessage {
  const value = body as Partial<ReplayMessage> | null
  return (
    value?.v === 1 && typeof value.replayId === 'string' && typeof value.workspaceId === 'string'
  )
}

async function setParent(
  db: Database,
  id: string,
  set: { status: 'running' | 'deferred'; errorCode: string | null },
) {
  await db.update(syncRun).set(set).where(eq(syncRun.id, id))
}

/** 本回放已成功取过历史的 ASIN（按站点） */
async function fetchedAsins(db: Database, replayId: string): Promise<Set<string>> {
  const runs = await db
    .select({ marketplace: syncRun.marketplace, scope: syncRun.scope })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.trigger, 'replay'),
        eq(syncRun.status, 'succeeded'),
        sql`${syncRun.scope}->>'replayId' = ${replayId}`,
      ),
    )
  const out = new Set<string>()
  for (const run of runs) {
    const ids = Array.isArray(run.scope.ids) ? run.scope.ids : []
    for (const id of ids) out.add(`${run.marketplace}|${String(id)}`)
  }
  return out
}

/**
 * 执行回放的一步（队列消费者调用）：取完全部历史后计算、冻结并打标签。
 * 额度不足返回 deferred（调用方按 retryAt 顺延重投）；没有凭据或永久错误返回 failed 并记入父记录。
 * 重复投递幂等：已完成的回放直接返回，已取过的批次不再请求。
 */
export async function runReplayStep(
  deps: ReplayDeps,
  message: ReplayMessage,
): Promise<ReplayStepResult> {
  const { db, connector, ctx } = deps
  const now = ctx.now()
  const [parent] = await db.select().from(syncRun).where(eq(syncRun.id, message.replayId))
  const scope = parent?.scope as ReplayScope | undefined
  if (!parent || scope?.role !== 'replay' || scope.workspaceId !== message.workspaceId)
    return { status: 'failed', code: 'REPLAY_NOT_FOUND' }
  if (parent.status === 'succeeded')
    return { status: 'done', recommendations: parent.okCount, labels: 0 }
  if (parent.status === 'failed') return { status: 'failed', code: parent.errorCode ?? 'FAILED' }

  const fail = async (code: string): Promise<ReplayStepResult> => {
    await finishRun(db, parent.id, { status: 'failed', errorCode: code, finishedAt: ctx.now() })
    log.warn('selection.replay_failed', { replayId: parent.id, code })
    return { status: 'failed', code }
  }
  // 没有凭据时不预扣额度、不发请求，直接失败并记录原因
  const missing = connector.secrets.find((name) => !ctx.secret(name))
  if (missing) return fail(`${missing}_MISSING`)

  const source = await getSource(db, connector.id)
  const spec = effectiveBudget(connector, source?.config as SourceConfig | undefined)
  const batchSize = Math.min(KEEPA_BATCH_LIMIT, Math.floor(spec.hardCap / KEEPA_TOKENS_PER_PRODUCT))
  if (batchSize < 1) return fail('REPLAY_BUDGET_TOO_SMALL')
  await setParent(db, parent.id, { status: 'running', errorCode: null })

  const fetched = await fetchedAsins(db, parent.id)
  for (const [marketplace, list] of Object.entries(scope.asins)) {
    const pending = list.filter((asin) => !fetched.has(`${marketplace}|${asin}`))
    for (let i = 0; i < pending.length; i += batchSize) {
      const outcome = await runSyncTask(
        { db, archive: deps.archive, ctx },
        connector,
        {
          kind: 'rank-history',
          marketplace: marketplace as Marketplace,
          scope: {
            ids: pending.slice(i, i + batchSize),
            replayId: parent.id,
            workspaceId: scope.workspaceId,
          },
        },
        { mode: 'manual', trigger: 'replay' },
      )
      if (outcome.status === 'succeeded') continue
      if (outcome.status === 'deferred') {
        const reason = `BUDGET_${outcome.reason.toUpperCase().replace('-', '_')}`
        await setParent(db, parent.id, { status: 'deferred', errorCode: reason })
        return { status: 'deferred', retryAt: outcome.resetsAt, reason }
      }
      if (outcome.status === 'skipped') return fail(outcome.reason)
      if (outcome.error.retryable) {
        await setParent(db, parent.id, { status: 'deferred', errorCode: outcome.error.code })
        return {
          status: 'deferred',
          retryAt: new Date(now.getTime() + RETRY_DELAY_SECONDS * 1000),
          reason: outcome.error.code,
        }
      }
      return fail(outcome.error.code)
    }
  }

  const { recommendations, labels } = await freezeAndLabelReplay(deps, parent.id, scope, now)
  await finishRun(db, parent.id, {
    status: 'succeeded',
    okCount: recommendations,
    finishedAt: ctx.now(),
  })
  log.info('selection.replay_done', { replayId: parent.id, recommendations, labels })
  return { status: 'done', recommendations, labels }
}

/** 截取到冻结日计算分数并冻结为 replay 推荐，再对已到期窗口打标签 */
async function freezeAndLabelReplay(
  deps: ReplayDeps,
  replayId: string,
  scope: ReplayScope,
  now: Date,
): Promise<{ recommendations: number; labels: number }> {
  const { db } = deps
  const { workspaceId, frozenOn } = scope
  const s = scoped(db, workspaceId)
  const [row] = await s.select(direction, { where: eq(direction.id, scope.directionId) })
  if (!row) return { recommendations: 0, labels: 0 }
  const ctx = await loadWorkspaceContext(db, workspaceId, { now, asOf: frozenOn })
  const { clusters, members, products } = await directionProducts(db, workspaceId, row)
  const inputs = await clusterInputs(ctx, row, clusters, members, products)
  for (const input of inputs) {
    const values = freezeValues(input, computeCluster(ctx, input), 'replay', {
      replayId,
      nodeDate: scope.nodeDate,
      beforeDays: scope.beforeDays,
    })
    if (!values) continue
    await s.insert(recommendation, { ...values, leadId: null, frozenOn }).onConflictDoNothing()
  }
  const clusterIds = inputs.map((i) => i.clusterId)
  const recs: Recommendation[] =
    clusterIds.length === 0
      ? []
      : await s.select(recommendation, {
          where: and(
            inArray(recommendation.clusterId, clusterIds),
            eq(recommendation.frozenOn, frozenOn),
            eq(recommendation.sampleKind, 'replay'),
          ) as SQL,
        })
  const today = localDay(now, SELECTION_TIME_ZONE)
  let labels = 0
  for (const rec of recs) {
    for (const window of dueWindows(rec.frozenOn, today)) {
      if (await labelAndStore(db, rec, window, deps.criteria, now)) labels += 1
    }
  }
  return { recommendations: recs.length, labels }
}

export type ReplayStatus = 'queued' | 'running' | 'deferred' | 'succeeded' | 'failed'

export interface ReplayJobView {
  readonly replayId: string
  readonly directionId: string
  readonly nodeDate: string
  readonly beforeDays: number
  readonly frozenOn: string
  /** queued：已投递、尚未开始取数；deferred：额度不足顺延中 */
  readonly status: ReplayStatus
  /** 失败或顺延原因（机器码，如 KEEPA_API_KEY_MISSING、BUDGET_HARD_CAP） */
  readonly errorCode: string | null
  readonly products: number
  readonly estimatedTokens: number
  /** 已成功取到历史的商品数 */
  readonly fetchedProducts: number
  /** 生成的回放推荐数（成功后） */
  readonly recommendations: number
  readonly startedAt: Date
  readonly finishedAt: Date | null
}

/** 本空间最近的回放任务 */
export async function listReplays(
  db: Database,
  workspaceId: string,
  limit = 10,
): Promise<ReplayJobView[]> {
  const parents = await db
    .select()
    .from(syncRun)
    .where(
      and(
        eq(syncRun.trigger, 'replay'),
        sql`${syncRun.scope}->>'role' = 'replay'`,
        sql`${syncRun.scope}->>'workspaceId' = ${workspaceId}`,
      ),
    )
    .orderBy(desc(syncRun.startedAt))
    .limit(limit)
  const out: ReplayJobView[] = []
  for (const run of parents) {
    const scope = run.scope as unknown as ReplayScope
    const fetched = await fetchedAsins(db, run.id)
    const attempted = await db
      .select({ id: syncRun.id })
      .from(syncRun)
      .where(and(eq(syncRun.trigger, 'replay'), sql`${syncRun.scope}->>'replayId' = ${run.id}`))
      .limit(1)
    const status: ReplayStatus =
      run.status === 'running' && attempted.length === 0
        ? 'queued'
        : run.status === 'skipped'
          ? 'failed'
          : run.status
    out.push({
      replayId: run.id,
      directionId: scope.directionId,
      nodeDate: scope.nodeDate,
      beforeDays: scope.beforeDays,
      frozenOn: scope.frozenOn,
      status,
      errorCode: run.errorCode,
      products: Object.values(scope.asins ?? {}).reduce((n, l) => n + l.length, 0),
      estimatedTokens: scope.estimatedTokens,
      fetchedProducts: fetched.size,
      recommendations: run.okCount,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })
  }
  return out
}
