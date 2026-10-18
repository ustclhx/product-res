import { cluster, clusterMember, direction, scoped } from '@product-res/db'
import {
  acceptSuggestion,
  dismissSuggestion,
  getValidationOverview,
  KEEPA_TOKENS_PER_PRODUCT,
  proposeWeights,
  type ReplayMessage,
  type ReplayQueue,
  type SuggestionView,
  startReplay,
} from '@product-res/follow'
import type { Capability, QueueProducer } from '@product-res/platform'
import {
  DEFAULT_FIT_OPTIONS,
  DEFAULT_READINESS_THRESHOLDS,
  DIMENSION_LABELS,
  DIMENSIONS,
} from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import { assertWorkbenchWriter, canWriteWorkbench } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'

/**
 * 算法验证页（openspec/changes/add-shadow-validation tasks 4.1，design D6）：
 * 只读部分全部来自 packages/follow 的 getValidationOverview，不生成示例数据；
 * 写操作（生成 / 采用 / 忽略权重建议、发起 Keepa 回放）先经 assertWorkbenchWriter。
 */

const isAmazon = (marketplace: string) => marketplace.startsWith('amazon-')

const suggestionRow = (s: SuggestionView) => ({
  ...s,
  fittedAt: s.fittedAt.toISOString(),
  resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
})

export async function validationPage(
  actor: WorkbenchActor,
  options: { now?: Date; replayQueueAvailable?: boolean } = {},
) {
  const { now, replayQueueAvailable = false } = options
  const { db, workspaceId } = actor
  const [overview, directions] = await Promise.all([
    getValidationOverview(db, workspaceId, { now }),
    scoped(db, workspaceId)
      .select(direction, {
        fields: { id: direction.id, name: direction.name, marketplaces: direction.marketplaces },
      })
      .orderBy(asc(direction.createdAt)),
  ])
  const names = new Map(directions.map((d) => [d.id, d.name]))
  return {
    ...overview,
    latestSuggestion: overview.latestSuggestion ? suggestionRow(overview.latestSuggestion) : null,
    replays: overview.replays.map((r) => ({
      ...r,
      directionName: names.get(r.directionId) ?? '已删除的方向',
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    })),
    amazonDirections: directions
      .filter((d) => d.marketplaces.some(isAmazon))
      .map((d) => ({ id: d.id, name: d.name, marketplaces: d.marketplaces.filter(isAmazon) })),
    dimensions: DIMENSIONS.map((id) => ({ id, label: DIMENSION_LABELS[id] })),
    thresholds: {
      observation: DEFAULT_READINESS_THRESHOLDS.observation,
      usable: DEFAULT_READINESS_THRESHOLDS.usable,
      trusted: DEFAULT_READINESS_THRESHOLDS.trusted,
      fitMinSamples: DEFAULT_FIT_OPTIONS.minEffectiveSamples,
    },
    /** 回放队列目前只由 Node 入口装配；为 false 时页面停用“发起回放” */
    replayQueueAvailable,
    canWrite: canWriteWorkbench(actor),
  }
}

/** 拟合权重建议；样本不足等情况返回原因（不写库），由页面展示 */
export async function proposeSuggestion(actor: WorkbenchActor) {
  assertWorkbenchWriter(actor)
  const result = await proposeWeights(actor.db, actor.workspaceId)
  if (!result.ok)
    return { ok: false as const, effectiveSamples: result.effectiveSamples, reason: result.reason }
  return { ok: true as const, suggestionId: result.suggestion.id }
}

export async function resolveSuggestion(
  actor: WorkbenchActor,
  id: string,
  decision: 'accept' | 'dismiss',
  userId: string | null = null,
) {
  assertWorkbenchWriter(actor)
  if (decision === 'dismiss') {
    const row = await dismissSuggestion(actor.db, actor.workspaceId, id, userId)
    return { status: row.status, version: null }
  }
  const { suggestion, version } = await acceptSuggestion(actor.db, actor.workspaceId, id, userId)
  return { status: suggestion.status, version }
}

/**
 * 回放预估：方向下 Amazon 站点活跃簇的成员商品数与 Keepa token（与 startReplay 的预估口径一致：
 * 每个站点 × 商品 1 个 ASIN、每个 ASIN 1 token）。只读，不创建任务。
 */
export async function previewReplay(actor: WorkbenchActor, directionId: string) {
  const s = scoped(actor.db, actor.workspaceId)
  const row = await s.findById(direction, directionId)
  const markets = row.marketplaces.filter(isAmazon)
  if (markets.length === 0)
    throw new AppError('REPLAY_NOT_AMAZON', '只能对包含 Amazon 站点的方向回放', { status: 400 })
  const clusters = await s.select(cluster, {
    where: and(
      eq(cluster.directionId, row.id),
      eq(cluster.status, 'active'),
      inArray(cluster.marketplace, markets),
    ) as SQL,
    fields: { id: cluster.id, marketplace: cluster.marketplace },
  })
  const members =
    clusters.length === 0
      ? []
      : await s.select(clusterMember, {
          where: inArray(
            clusterMember.clusterId,
            clusters.map((c) => c.id),
          ),
          fields: { clusterId: clusterMember.clusterId, productId: clusterMember.productId },
        })
  const marketOf = new Map(clusters.map((c) => [c.id, c.marketplace]))
  const keys = new Set(members.map((m) => `${marketOf.get(m.clusterId)}|${m.productId}`))
  return {
    marketplaces: markets,
    clusters: clusters.length,
    products: keys.size,
    estimatedTokens: keys.size * KEEPA_TOKENS_PER_PRODUCT,
  }
}

export interface ReplayRequest {
  directionId: string
  nodeDate: string
  beforeDays: number
}

/** 发起回放：参数校验与预估由 startReplay 完成；队列由目标入口注入，未装配时明确拒绝 */
export async function startKeepaReplay(
  actor: WorkbenchActor,
  input: ReplayRequest,
  queue: Capability<QueueProducer<ReplayMessage>> | ReplayQueue | undefined,
  now?: Date,
) {
  assertWorkbenchWriter(actor)
  const producer = queue && 'available' in queue ? (queue.available ? queue.value : null) : queue
  if (!producer)
    throw new AppError('REPLAY_QUEUE_UNAVAILABLE', '当前部署没有启用回放队列', { status: 503 })
  return startReplay(actor.db, producer, { workspaceId: actor.workspaceId, ...input, now })
}
