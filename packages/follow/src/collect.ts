import type { FetchTask, Marketplace, SourceConnector } from '@product-res/datasources'
import {
  clusterMember,
  cluster as clusterTable,
  type Database,
  direction,
  directionSeller,
  lead,
  marketplaceProduct,
  scoped,
  seasonalNode,
} from '@product-res/db'
import { normalizePhrase } from '@product-res/marketdata'
import { addDays } from '@product-res/selection'
import { and, eq, gte, inArray, ne, type SQL } from 'drizzle-orm'

/** and() 的参数都存在时结果一定存在 */
const all = (...conditions: SQL[]) => and(...conditions) as SQL

/**
 * 每日采集计划（add-data-source-hub tasks 3.2）：按所有空间的启用方向生成去重后的同步任务，
 * 按数据源的定时安全线排序截断。读取部分（loadCollectionTargets）只读空间数据，
 * 计划部分（planCollections）是纯函数，由 apps/jobs 的每日流水线投递到同步队列。
 */

/** 采集用的数据源：eBay 走 Browse，Amazon 走 Keepa，关键词走 DataForSEO */
export const COLLECT_SOURCES = {
  ebay: 'ebay-browse',
  amazon: 'keepa',
  keywords: 'dataforseo',
} as const

/** 优先级（数字越小越先）：卖家新品 > 有线索的簇成员快照 > 其他成员快照 > 关键词 */
export const COLLECT_PRIORITY = {
  sellerNew: 0,
  leadSnapshot: 1,
  memberSnapshot: 2,
  keyword: 3,
} as const

/** 流水线阶段，对应方案 §14.4 的时间表（相对 02:00 的分钟偏移由投递方决定） */
export type CollectStage = 'seller-scan' | 'snapshot' | 'keyword'

/** 线索回看天数：近 30 天内出现过（未放弃的）线索的簇视为“已有线索” */
const LEAD_LOOKBACK_DAYS = 30
const EBAY_BATCH = 20
const KEEPA_MAX_BATCH = 100
/** DataForSEO 搜索量每个任务最多 1000 个关键词；Trends 每个关键词单独请求，避免多词对比互相归一 */
const VOLUME_BATCH = 1000

export interface SellerTarget {
  readonly marketplace: string
  readonly sellerId: string
  readonly categoryIds: readonly string[]
  readonly keywords: readonly string[]
}

export interface ProductTarget {
  readonly marketplace: string
  readonly platformId: string
  readonly hasLead: boolean
}

export interface CollectionTargets {
  readonly sellers: readonly SellerTarget[]
  readonly products: readonly ProductTarget[]
  /** 方向与关联节点的关键词（未去重） */
  readonly keywords: readonly string[]
}

/**
 * 读取所有空间启用方向的采集对象。系统任务需要跨空间列出“有启用方向的空间”，
 * 之后的读取都经 scoped() 限定在单个空间；停用方向的卖家、簇与关键词不进入计划。
 */
export async function loadCollectionTargets(
  db: Database,
  options: { readonly asOf: string; readonly keywords: boolean },
): Promise<CollectionTargets> {
  const workspaces = await db
    .selectDistinct({ workspaceId: direction.workspaceId })
    .from(direction)
    .where(eq(direction.enabled, true))
  const sellers: SellerTarget[] = []
  const members: { productId: string; hasLead: boolean }[] = []
  const keywords: string[] = []
  for (const { workspaceId } of workspaces) {
    const s = scoped(db, workspaceId)
    const directions = await s.select(direction, { where: eq(direction.enabled, true) })
    if (directions.length === 0) continue
    const byId = new Map(directions.map((d) => [d.id, d]))
    const ids = [...byId.keys()]
    const pool = await s.select(directionSeller, {
      where: all(
        inArray(directionSeller.directionId, ids),
        inArray(directionSeller.status, ['seed', 'accepted']),
      ),
    })
    for (const row of pool) {
      const d = byId.get(row.directionId)
      if (!d) continue
      sellers.push({
        marketplace: row.marketplace,
        sellerId: row.sellerPlatformId,
        categoryIds: d.categoryIds,
        keywords: d.keywords,
      })
    }
    const clusters = await s.select(clusterTable, {
      fields: { id: clusterTable.id },
      where: all(inArray(clusterTable.directionId, ids), eq(clusterTable.status, 'active')),
    })
    if (clusters.length > 0) {
      const clusterIds = clusters.map((c) => c.id)
      const [rows, leads] = await Promise.all([
        s.select(clusterMember, {
          fields: { clusterId: clusterMember.clusterId, productId: clusterMember.productId },
          where: inArray(clusterMember.clusterId, clusterIds),
        }),
        s.select(lead, {
          fields: { clusterId: lead.clusterId },
          where: all(
            inArray(lead.clusterId, clusterIds),
            ne(lead.status, 'dropped'),
            gte(lead.leadOn, addDays(options.asOf, -LEAD_LOOKBACK_DAYS)),
          ),
        }),
      ])
      const withLead = new Set(leads.map((l) => l.clusterId))
      for (const m of rows)
        members.push({ productId: m.productId, hasLead: withLead.has(m.clusterId) })
    }
    if (options.keywords) {
      const nodeIds = [...new Set(directions.flatMap((d) => d.nodeIds))]
      const nodes = nodeIds.length
        ? await s.select(seasonalNode, {
            fields: { keywords: seasonalNode.keywords },
            where: inArray(seasonalNode.id, nodeIds),
          })
        : []
      keywords.push(...directions.flatMap((d) => d.keywords), ...nodes.flatMap((n) => n.keywords))
    }
  }
  const productIds = [...new Set(members.map((m) => m.productId))]
  const products: ProductTarget[] = []
  if (productIds.length > 0) {
    const leadOf = new Map<string, boolean>()
    for (const m of members)
      leadOf.set(m.productId, (leadOf.get(m.productId) ?? false) || m.hasLead)
    // 市场商品是部署级共享表（无 workspace_id）
    for (let i = 0; i < productIds.length; i += 1000) {
      const rows = await db
        .select({
          id: marketplaceProduct.id,
          marketplace: marketplaceProduct.marketplace,
          platformId: marketplaceProduct.platformId,
        })
        .from(marketplaceProduct)
        .where(inArray(marketplaceProduct.id, productIds.slice(i, i + 1000)))
      for (const row of rows)
        products.push({
          marketplace: row.marketplace,
          platformId: row.platformId,
          hasLead: leadOf.get(row.id) ?? false,
        })
    }
  }
  return { sellers, products, keywords }
}

/** 一个可用数据源的定时额度 */
export interface SourceAllowance {
  readonly connector: SourceConnector
  /**
   * 日 / 月周期：本次计划可用的额度（到安全线为止）；
   * 分钟周期：每分钟的容量（安全线），配合 minuteSlots 计算整个窗口。
   */
  readonly headroom: number
  /** 分钟周期数据源可用的分钟数（窗口长度）；其他周期不填 */
  readonly minuteSlots?: number
}

export interface PlannedTask {
  readonly sourceId: string
  readonly task: FetchTask
  readonly priority: number
  readonly stage: CollectStage
  /** 连接器 plan() 估算的花费（预算单位） */
  readonly cost: number
  /** 分钟周期数据源的执行分钟序号（从 0 起），投递方据此错开 */
  readonly slot: number
  /** 当天内稳定的任务键（不含日期），用于幂等投递 */
  readonly key: string
}

export interface CollectionPlan {
  readonly tasks: readonly PlannedTask[]
  /** 因安全线截断、顺延到之后运行的任务数（按数据源） */
  readonly truncated: Readonly<Record<string, number>>
  /** 有采集对象但数据源不可用（停用、无凭据、暂停）而未生成的任务数 */
  readonly unavailable: Readonly<Record<string, number>>
}

interface Candidate {
  readonly sourceId: string
  readonly task: FetchTask
  readonly priority: number
  readonly stage: CollectStage
}

const platformOf = (marketplace: string) => marketplace.split('-')[0]

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 稳定的 scope 序列化（键排序），用于任务键 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** FNV-1a 64 位，任务键只需当天内区分不同 scope */
function hash(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

export function taskKey(sourceId: string, task: FetchTask): string {
  return `${sourceId}:${task.kind}:${task.marketplace}:${hash(stableJson(task.scope))}`
}

function sellerCandidates(targets: CollectionTargets): Candidate[] {
  // 同一卖家在多个方向 / 空间出现时只扫描一次；Browse 搜索每次只接受一个类目，按类目拆分，
  // 没有类目的方向用关键词作为 q；两者都没有时无法发起搜索，不生成任务
  const scopes = new Map<string, Candidate>()
  for (const s of targets.sellers) {
    if (platformOf(s.marketplace) !== 'ebay') continue
    const filters: Record<string, string>[] =
      s.categoryIds.length > 0
        ? s.categoryIds.map((c) => ({ categoryIds: c }))
        : [...new Set(s.keywords.map(normalizePhrase).filter(Boolean))].map((q) => ({ q }))
    for (const filter of filters) {
      const task: FetchTask = {
        kind: 'seller-new-listings',
        marketplace: s.marketplace as Marketplace,
        scope: { sellerId: s.sellerId, ...filter },
      }
      const key = taskKey(COLLECT_SOURCES.ebay, task)
      if (!scopes.has(key))
        scopes.set(key, {
          sourceId: COLLECT_SOURCES.ebay,
          task,
          priority: COLLECT_PRIORITY.sellerNew,
          stage: 'seller-scan',
        })
    }
  }
  return [...scopes.values()]
}

function snapshotCandidates(
  targets: CollectionTargets,
  sources: ReadonlyMap<string, SourceAllowance>,
): Candidate[] {
  // 同一商品在多个簇 / 空间出现时只快照一次，任一处有线索即按线索优先级
  const products = new Map<string, ProductTarget>()
  for (const p of targets.products) {
    const key = `${p.marketplace}:${p.platformId}`
    const seen = products.get(key)
    products.set(key, seen ? { ...seen, hasLead: seen.hasLead || p.hasLead } : p)
  }
  const groups = new Map<string, { sourceId: string; marketplace: string; ids: string[] }>()
  for (const p of products.values()) {
    const platform = platformOf(p.marketplace)
    const sourceId =
      platform === 'ebay'
        ? COLLECT_SOURCES.ebay
        : platform === 'amazon'
          ? COLLECT_SOURCES.amazon
          : undefined
    if (!sourceId) continue
    const tier = p.hasLead ? COLLECT_PRIORITY.leadSnapshot : COLLECT_PRIORITY.memberSnapshot
    const key = `${sourceId}|${p.marketplace}|${tier}`
    const group = groups.get(key) ?? { sourceId, marketplace: p.marketplace, ids: [] }
    group.ids.push(p.platformId)
    groups.set(key, group)
  }
  const out: Candidate[] = []
  for (const [key, group] of groups) {
    const priority = Number(key.split('|')[2])
    const allowance = sources.get(group.sourceId)
    // Keepa 每分钟令牌有限：单批不超过每分钟容量，否则永远预扣不到
    const size =
      group.sourceId === COLLECT_SOURCES.amazon
        ? Math.max(1, Math.min(KEEPA_MAX_BATCH, allowance?.headroom ?? KEEPA_MAX_BATCH))
        : EBAY_BATCH
    for (const ids of chunk(group.ids.sort(), size))
      out.push({
        sourceId: group.sourceId,
        task: {
          kind: 'product-snapshot',
          marketplace: group.marketplace as Marketplace,
          scope: { ids },
        },
        priority,
        stage: 'snapshot',
      })
  }
  return out
}

function keywordCandidates(targets: CollectionTargets): Candidate[] {
  // Google 数据不分站点：关键词记在 global，选品流水线找不到同站点关键词时回退到 global
  const phrases = [...new Set(targets.keywords.map(normalizePhrase).filter(Boolean))].sort()
  const base = {
    sourceId: COLLECT_SOURCES.keywords,
    priority: COLLECT_PRIORITY.keyword,
    stage: 'keyword' as const,
  }
  return [
    ...phrases.map((keyword) => ({
      ...base,
      task: {
        kind: 'search-trend' as const,
        marketplace: 'global' as const,
        scope: { keywords: [keyword] },
      },
    })),
    ...chunk(phrases, VOLUME_BATCH).map((keywords) => ({
      ...base,
      task: {
        kind: 'keyword-volume' as const,
        marketplace: 'global' as const,
        scope: { keywords },
      },
    })),
  ]
}

/**
 * 生成采集计划：去重 → 按优先级排序 → 按各数据源的定时额度截断。
 * 截断是严格的：某个任务放不下时，同一数据源后面的任务全部顺延（不让低优先级的小任务插队）。
 * 分钟周期数据源（Keepa）把任务装进每分钟不超过容量的时间槽，窗口用完即截断。
 */
export function planCollections(
  targets: CollectionTargets,
  sources: ReadonlyMap<string, SourceAllowance>,
  options: { readonly keywords: boolean },
): CollectionPlan {
  const candidates = [
    ...sellerCandidates(targets),
    ...snapshotCandidates(targets, sources),
    ...(options.keywords ? keywordCandidates(targets) : []),
  ]
  const bySource = new Map<string, Candidate[]>()
  for (const c of candidates) bySource.set(c.sourceId, [...(bySource.get(c.sourceId) ?? []), c])
  const tasks: PlannedTask[] = []
  const truncated: Record<string, number> = {}
  const unavailable: Record<string, number> = {}
  for (const [sourceId, list] of bySource) {
    const allowance = sources.get(sourceId)
    if (!allowance) {
      unavailable[sourceId] = list.length
      continue
    }
    // 稳定排序：同一优先级保持生成顺序
    const ordered = list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
      .map(({ c }) => c)
    const minute = allowance.connector.budget.period === 'minute'
    const slots = minute ? (allowance.minuteSlots ?? 0) : 1
    let slot = 0
    let used = 0
    let cut = 0
    for (const [index, c] of ordered.entries()) {
      const cost = allowance.connector.plan(c.task)
      if (minute && used + cost > allowance.headroom) {
        slot++
        used = 0
      }
      if (cost > allowance.headroom || slot >= slots || used + cost > allowance.headroom) {
        cut = ordered.length - index
        break
      }
      used += cost
      tasks.push({ ...c, cost, slot: minute ? slot : 0, key: taskKey(sourceId, c.task) })
    }
    if (cut > 0) truncated[sourceId] = cut
  }
  tasks.sort((a, b) => a.priority - b.priority || a.slot - b.slot)
  return { tasks, truncated, unavailable }
}
