import type { Database } from '@product-res/db'
import { scoped } from '@product-res/db'
import {
  type AccuracyAudit,
  accuracyAudit,
  accuracyAuditItem,
  marketplaceProduct,
  observation,
  organization,
  sourceQualification,
  trackedProduct,
} from '@product-res/db/schema'
import { AppError } from '@product-res/shared'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm'
import { setSourceQualification } from './observations.ts'

/**
 * 人工抽检（openspec/changes/add-accuracy-store-tracking design D7、specs/data-accuracy「人工抽检与准确率」）。
 *
 * - 每周一从本空间的被追踪商品中随机抽 20 个，种子与抽样记录保存，可复现；
 * - 每项快照各来源的采集值与采集时间，人工打开商品页填写实际值后逐项计算是否一致；
 * - 提交后按「来源 × 字段」统计各空间近 4 次抽检，样本 ≥ 20 且一致率 < 95% 的来源失去该字段的
 *   主值资格（写 source_qualification，读取侧自动跳过），之后回到 ≥ 95% 即恢复。
 *
 * 字段名即观测指标名，资格表按指标生效；可售状态用 available_quantity（> 0 为可售）。
 */
export const AUDIT_FIELDS = [
  'price',
  'bought_month',
  'review_count',
  'rating',
  'bsr',
  'available_quantity',
] as const
export type AuditField = (typeof AUDIT_FIELDS)[number]

export const AUDIT_SAMPLE_SIZE = 20
/** 一致率低于该值（且样本足够）失去主值资格 */
export const QUALIFICATION_THRESHOLD = 0.95
export const QUALIFICATION_MIN_SAMPLES = 20
/** 统计窗口：每个空间最近几次已提交的抽检 */
export const QUALIFICATION_WINDOW = 4
/** 快照只取最近 14 天内的采集值；更早的视为未采集（缺失不补） */
export const SNAPSHOT_LOOKBACK_DAYS = 14

const DAY_MS = 86_400_000
const SGT_OFFSET_MS = 8 * 3_600_000

/** 某来源某字段的采集快照 */
export interface CollectedValue {
  readonly value: number
  /** 区间下界（bought）；点值为 null */
  readonly low: number | null
  /** 区间上界；点值或上界开放为 null */
  readonly high: number | null
  readonly currency: string | null
  readonly tier: number
  readonly channel: string | null
  readonly observedOn: string
  readonly fetchedAt: string
}

/** 来源 → 字段 → 采集值 */
export type CollectedSnapshot = Record<string, Partial<Record<AuditField, CollectedValue>>>

/**
 * 人工填写的页面实际值；未填写的字段不参与统计。
 * bought_month 填页面徽标的下界（"100+ bought" 填 100），页面没有徽标填 0；
 * available_quantity 填是否可售。
 */
export interface AuditActual {
  readonly price?: number | null
  readonly bought_month?: number | null
  readonly review_count?: number | null
  readonly rating?: number | null
  readonly bsr?: number | null
  readonly available_quantity?: boolean | null
}

/** 来源 → 字段 → 是否一致 */
export type AuditAgreement = Record<string, Partial<Record<AuditField, boolean>>>

/** 抽检周：新加坡时间所在周的周一（YYYY-MM-DD） */
export function auditWeekOf(now: Date): string {
  const local = new Date(now.getTime() + SGT_OFFSET_MS)
  const back = (local.getUTCDay() + 6) % 7
  return new Date(local.getTime() - back * DAY_MS).toISOString().slice(0, 10)
}

/** 种子字符串 → 32 位整数（FNV-1a） */
function hashSeed(seed: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32：同一种子得到同一序列，抽样可复现 */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** 按种子从候选中无放回抽取 size 个（候选先去重排序，结果与候选的读取顺序无关） */
export function sampleIds(ids: readonly string[], size: number, seed: string): string[] {
  const pool = [...new Set(ids)].sort()
  const n = Math.min(size, pool.length)
  const rand = mulberry32(hashSeed(seed))
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i))
    const picked = pool[j] as string
    pool[j] = pool[i] as string
    pool[i] = picked
  }
  return pool.slice(0, n)
}

function randomSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const EPSILON = 1e-9

/** 单个字段的一致判定：价格 ≤ 1%、评论数 ≤ 2%、bought 下界与页面徽标一致，其余完全一致 */
export function fieldAgrees(
  field: AuditField,
  collected: CollectedValue,
  actual: number | boolean,
): boolean {
  switch (field) {
    case 'price': {
      const a = Number(actual)
      return a === 0 ? collected.value === 0 : Math.abs(collected.value - a) / a <= 0.01 + EPSILON
    }
    case 'review_count': {
      const a = Number(actual)
      return a === 0 ? collected.value === 0 : Math.abs(collected.value - a) / a <= 0.02 + EPSILON
    }
    case 'bought_month':
      // 区间按下界比较：采集 [100, 200) 与页面 "100+ bought" 一致；页面无徽标（0）时采集到任何档位都不一致
      return (collected.low ?? collected.value) === Number(actual)
    case 'rating':
      // 页面星级只显示一位小数
      return Math.round(collected.value * 10) === Math.round(Number(actual) * 10)
    case 'bsr':
      return collected.value === Number(actual)
    case 'available_quantity':
      return collected.value > 0 === Boolean(actual)
  }
}

/** 清理人工填写值：只保留已知字段的有限数值 / 布尔值 */
export function cleanActual(input: Record<string, unknown>): AuditActual {
  const out: Record<string, number | boolean> = {}
  for (const field of AUDIT_FIELDS) {
    const v = input[field]
    if (field === 'available_quantity') {
      if (typeof v === 'boolean') out[field] = v
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[field] = v
  }
  return out as AuditActual
}

/** 逐来源逐字段计算一致性；只比较两边都有值的字段（缺失不算不一致） */
export function computeAgreement(
  collected: CollectedSnapshot,
  actual: AuditActual,
): AuditAgreement {
  const result: AuditAgreement = {}
  for (const [sourceId, fields] of Object.entries(collected)) {
    const row: Partial<Record<AuditField, boolean>> = {}
    for (const field of AUDIT_FIELDS) {
      const c = fields[field]
      const a = actual[field]
      if (!c || a === undefined || a === null) continue
      row[field] = fieldAgrees(field, c, a)
    }
    if (Object.keys(row).length > 0) result[sourceId] = row
  }
  return result
}

export interface AgreementStat {
  readonly sourceId: string
  readonly metric: AuditField
  readonly agree: number
  readonly samples: number
  /** 一致率 0–1；样本为 0 时为 null */
  readonly rate: number | null
}

/** 汇总多项的一致性为 来源 × 字段 的一致率 */
export function aggregateAgreement(
  agreements: readonly (AuditAgreement | null | undefined)[],
): AgreementStat[] {
  const stats = new Map<
    string,
    { sourceId: string; metric: AuditField; agree: number; samples: number }
  >()
  for (const agreement of agreements) {
    if (!agreement) continue
    for (const [sourceId, fields] of Object.entries(agreement))
      for (const [metric, ok] of Object.entries(fields)) {
        const key = `${sourceId}|${metric}`
        const stat = stats.get(key) ?? {
          sourceId,
          metric: metric as AuditField,
          agree: 0,
          samples: 0,
        }
        stat.samples += 1
        if (ok) stat.agree += 1
        stats.set(key, stat)
      }
  }
  return [...stats.values()]
    .map((s) => ({ ...s, rate: s.samples === 0 ? null : s.agree / s.samples }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.metric.localeCompare(b.metric))
}

/**
 * 主值资格判定：样本 ≥ 20 时按一致率（< 95% 失去、≥ 95% 恢复）；
 * 样本不足时不改变原状态（未评估过即有资格）。
 */
export function qualificationDecision(
  stat: AgreementStat,
  previouslyDisqualified: boolean,
): boolean {
  if (stat.samples < QUALIFICATION_MIN_SAMPLES || stat.rate === null) return previouslyDisqualified
  return stat.rate < QUALIFICATION_THRESHOLD
}

/** 读取一批商品最近的采集值：每个 商品 × 来源 × 字段 取最近一天、最近一次 */
export async function collectSnapshots(
  db: Database,
  productIds: readonly string[],
  now: Date,
): Promise<Map<string, CollectedSnapshot>> {
  const result = new Map<string, CollectedSnapshot>()
  if (productIds.length === 0) return result
  const since = new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await db
    .select()
    .from(observation)
    .where(
      and(
        eq(observation.entityType, 'product'),
        inArray(observation.entityId, [...productIds]),
        inArray(observation.metric, [...AUDIT_FIELDS]),
        gte(observation.observedOn, since),
        lte(observation.fetchedAt, now),
      ),
    )
    .orderBy(desc(observation.observedOn), desc(observation.fetchedAt))
  for (const row of rows) {
    const snapshot = result.get(row.entityId) ?? {}
    const fields = snapshot[row.sourceId] ?? {}
    const field = row.metric as AuditField
    if (fields[field]) continue
    fields[field] = {
      value: row.value,
      low: row.valueLow,
      high: row.valueHigh,
      currency: row.currency,
      tier: row.tier,
      channel: row.channel,
      observedOn: row.observedOn,
      fetchedAt: row.fetchedAt.toISOString(),
    }
    snapshot[row.sourceId] = fields
    result.set(row.entityId, snapshot)
  }
  return result
}

/** 抽样记录（accuracy_audit.sampling） */
export interface AuditSampling {
  /** 参与抽样的被追踪商品数（不含冷门档：冷门已停追，没有新采集值） */
  readonly candidates: number
  readonly excludedCold: number
  readonly picked: readonly string[]
  readonly algorithm: 'mulberry32-fisher-yates'
  readonly lookbackDays: number
  /** 不足 20 个时的原因；足够时为 null */
  readonly shortfall: {
    readonly reason: 'insufficient-candidates'
    readonly available: number
  } | null
}

/**
 * 生成本周抽检；同一空间同一周只生成一次（已存在时返回原抽检，created = false）。
 * 被追踪商品不足 20 个时按实际数生成，并在抽样记录中写明原因。
 */
export async function generateAudit(
  db: Database,
  workspaceId: string,
  input: { readonly now: Date; readonly seed?: string; readonly sampleSize?: number },
): Promise<{ audit: AccuracyAudit; created: boolean }> {
  const s = scoped(db, workspaceId)
  const weekOf = auditWeekOf(input.now)
  const existing = async () => {
    const [row] = await s.select(accuracyAudit, { where: eq(accuracyAudit.weekOf, weekOf) })
    return row
  }
  const found = await existing()
  if (found) return { audit: found, created: false }
  const size = input.sampleSize ?? AUDIT_SAMPLE_SIZE
  const tracked = await s.select(trackedProduct, {
    fields: { productId: trackedProduct.productId, tier: trackedProduct.tier },
  })
  const candidates = tracked.filter((t) => t.tier !== 'cold').map((t) => t.productId)
  const seed = input.seed ?? randomSeed()
  const picked = sampleIds(candidates, size, seed)
  const sampling: AuditSampling = {
    candidates: candidates.length,
    excludedCold: tracked.length - candidates.length,
    picked,
    algorithm: 'mulberry32-fisher-yates',
    lookbackDays: SNAPSHOT_LOOKBACK_DAYS,
    shortfall:
      picked.length < size
        ? { reason: 'insufficient-candidates', available: candidates.length }
        : null,
  }
  const snapshots = await collectSnapshots(db, picked, input.now)
  const created = await s.transaction(async (tx) => {
    const [audit] = await tx
      .insert(accuracyAudit, {
        weekOf,
        seed,
        sampleSize: picked.length,
        sampling: sampling as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning()
    if (!audit) return undefined
    if (picked.length > 0)
      await tx.insert(
        accuracyAuditItem,
        picked.map((productId) => ({
          auditId: audit.id,
          productId,
          collected: (snapshots.get(productId) ?? {}) as Record<string, unknown>,
        })),
      )
    return audit
  })
  if (created) return { audit: created, created: true }
  // 并发生成时另一方先写入
  return { audit: (await existing()) as AccuracyAudit, created: false }
}

/**
 * 系统定时任务：为每个有被追踪商品的空间生成本周抽检（已有则跳过）。
 * 单个空间失败不影响其他空间，返回各空间结果。
 */
export async function generateWeeklyAudits(db: Database, now: Date) {
  // 跨空间找出有被追踪商品的空间；生成时再经 scoped 限定到该空间
  const workspaces = await db
    .selectDistinct({ id: trackedProduct.workspaceId })
    .from(trackedProduct)
    .innerJoin(
      organization,
      and(eq(organization.id, trackedProduct.workspaceId), isNull(organization.deletedAt)),
    )
    .where(ne(trackedProduct.tier, 'cold'))
  const results: { workspaceId: string; created: boolean; error?: unknown }[] = []
  for (const { id } of workspaces) {
    try {
      const { created } = await generateAudit(db, id, { now })
      results.push({ workspaceId: id, created })
    } catch (error) {
      results.push({ workspaceId: id, created: false, error })
    }
  }
  return results
}

/** 填写一项的实际值并立即计算该项的一致性；抽检提交后不可再改 */
export async function saveAuditItem(
  db: Database,
  workspaceId: string,
  input: {
    readonly itemId: string
    readonly actual: Record<string, unknown>
    readonly userId: string
    readonly now: Date
  },
) {
  const s = scoped(db, workspaceId)
  const item = await s.findById(accuracyAuditItem, input.itemId)
  const audit = await s.findById(accuracyAudit, item.auditId)
  if (audit.status === 'submitted')
    throw new AppError('AUDIT_SUBMITTED', 'Audit already submitted', { status: 409 })
  const actual = cleanActual(input.actual)
  const filled = Object.keys(actual).length > 0
  return s.updateById(accuracyAuditItem, item.id, {
    actual: filled ? (actual as Record<string, unknown>) : null,
    agreement: filled ? computeAgreement(item.collected as CollectedSnapshot, actual) : null,
    checkedAt: filled ? input.now : null,
    checkedBy: filled ? input.userId : null,
  })
}

/** 提交抽检并重新评估主值资格；至少要填写一项 */
export async function submitAudit(
  db: Database,
  workspaceId: string,
  input: { readonly auditId: string; readonly userId: string; readonly now: Date },
) {
  const s = scoped(db, workspaceId)
  const audit = await s.findById(accuracyAudit, input.auditId)
  if (audit.status === 'submitted')
    throw new AppError('AUDIT_SUBMITTED', 'Audit already submitted', { status: 409 })
  const checked = await s.count(
    accuracyAuditItem,
    and(eq(accuracyAuditItem.auditId, audit.id), isNotNull(accuracyAuditItem.checkedAt)),
  )
  if (checked === 0) throw new AppError('AUDIT_EMPTY', 'No item has been checked', { status: 400 })
  await s.updateById(accuracyAudit, audit.id, {
    status: 'submitted',
    submittedAt: input.now,
    submittedBy: input.userId,
  })
  return evaluateQualification(db, input.now)
}

/**
 * 部署级一致率：每个空间最近 4 次已提交抽检的全部已填写项，按 来源 × 字段 汇总。
 * 抽检属于空间，但来源与主值资格是部署级的（design D7「结果按部署级来源统计」）。
 */
export async function accuracyStats(db: Database): Promise<AgreementStat[]> {
  const ranked = db
    .select({
      id: accuracyAudit.id,
      rn: sql<number>`row_number() over (partition by ${accuracyAudit.workspaceId} order by ${accuracyAudit.weekOf} desc)`.as(
        'rn',
      ),
    })
    .from(accuracyAudit)
    .where(eq(accuracyAudit.status, 'submitted'))
    .as('ranked')
  const items = await db
    .select({ agreement: accuracyAuditItem.agreement })
    .from(accuracyAuditItem)
    .innerJoin(ranked, eq(ranked.id, accuracyAuditItem.auditId))
    .where(and(lte(ranked.rn, QUALIFICATION_WINDOW), isNotNull(accuracyAuditItem.agreement)))
  return aggregateAgreement(items.map((i) => i.agreement as AuditAgreement | null))
}

/** 按最新统计写入主值资格；返回每个 来源 × 字段 的统计与判定 */
export async function evaluateQualification(db: Database, now: Date) {
  const stats = await accuracyStats(db)
  const previous = await db
    .select({ sourceId: sourceQualification.sourceId, metric: sourceQualification.metric })
    .from(sourceQualification)
    .where(eq(sourceQualification.disqualified, true))
  const was = new Set(previous.map((p) => `${p.sourceId}|${p.metric}`))
  const decisions = []
  for (const stat of stats) {
    const disqualified = qualificationDecision(stat, was.has(`${stat.sourceId}|${stat.metric}`))
    await setSourceQualification(db, {
      sourceId: stat.sourceId,
      metric: stat.metric,
      disqualified,
      agreementRate: stat.rate,
      samples: stat.samples,
      evaluatedAt: now,
    })
    decisions.push({ ...stat, disqualified })
  }
  return decisions
}

/** 数据中心准确率 KPI：部署级 来源 × 字段 一致率，附当前主值资格 */
export async function accuracyKpis(db: Database) {
  const stats = await accuracyStats(db)
  const rows = await db.select().from(sourceQualification)
  const disqualified = new Set(
    rows.filter((r) => r.disqualified).map((r) => `${r.sourceId}|${r.metric}`),
  )
  const agree = stats.reduce((n, s) => n + s.agree, 0)
  const samples = stats.reduce((n, s) => n + s.samples, 0)
  return {
    overall: samples === 0 ? null : agree / samples,
    samples,
    stats: stats.map((s) => ({
      ...s,
      disqualified: disqualified.has(`${s.sourceId}|${s.metric}`),
      belowTarget: s.rate !== null && s.rate < QUALIFICATION_THRESHOLD,
    })),
  }
}

const PRODUCT_PAGE: Readonly<Record<string, (id: string) => string>> = {
  'amazon-us': (id) => `https://www.amazon.com/dp/${id}`,
  'amazon-uk': (id) => `https://www.amazon.co.uk/dp/${id}`,
  'amazon-de': (id) => `https://www.amazon.de/dp/${id}`,
  'amazon-jp': (id) => `https://www.amazon.co.jp/dp/${id}`,
  'amazon-ca': (id) => `https://www.amazon.ca/dp/${id}`,
  'ebay-us': (id) => `https://www.ebay.com/itm/${id}`,
}

/** 商品页链接：优先用采集到的 URL，否则按站点拼接 */
export function productPageUrl(marketplace: string, platformId: string, url: string | null) {
  if (url) return url
  return PRODUCT_PAGE[marketplace]?.(encodeURIComponent(platformId)) ?? null
}

/** 本空间的抽检列表（新的在前），附每次的填写进度与一致率 */
export async function listAudits(db: Database, workspaceId: string, limit = 12) {
  const s = scoped(db, workspaceId)
  const audits = await s.select(accuracyAudit).orderBy(desc(accuracyAudit.weekOf)).limit(limit)
  if (audits.length === 0) return []
  const items = await s.select(accuracyAuditItem, {
    fields: {
      auditId: accuracyAuditItem.auditId,
      agreement: accuracyAuditItem.agreement,
      checkedAt: accuracyAuditItem.checkedAt,
    },
    where: inArray(
      accuracyAuditItem.auditId,
      audits.map((a) => a.id),
    ),
  })
  return audits.map((audit) => {
    const mine = items.filter((i) => i.auditId === audit.id)
    const stats = aggregateAgreement(mine.map((i) => i.agreement as AuditAgreement | null))
    const agree = stats.reduce((n, x) => n + x.agree, 0)
    const samples = stats.reduce((n, x) => n + x.samples, 0)
    return {
      ...audit,
      sampling: audit.sampling as unknown as AuditSampling,
      items: mine.length,
      checked: mine.filter((i) => i.checkedAt !== null).length,
      samples,
      rate: samples === 0 ? null : agree / samples,
    }
  })
}

/** 一次抽检的清单：每项附商品信息与链接 */
export async function getAuditItems(db: Database, workspaceId: string, auditId: string) {
  const s = scoped(db, workspaceId)
  await s.findById(accuracyAudit, auditId)
  const rows = await s
    .select(accuracyAuditItem, {
      fields: {
        id: accuracyAuditItem.id,
        productId: accuracyAuditItem.productId,
        collected: accuracyAuditItem.collected,
        actual: accuracyAuditItem.actual,
        agreement: accuracyAuditItem.agreement,
        checkedAt: accuracyAuditItem.checkedAt,
        marketplace: marketplaceProduct.marketplace,
        platformId: marketplaceProduct.platformId,
        title: marketplaceProduct.title,
        url: marketplaceProduct.url,
      },
      where: eq(accuracyAuditItem.auditId, auditId),
    })
    .innerJoin(marketplaceProduct, eq(marketplaceProduct.id, accuracyAuditItem.productId))
    .orderBy(marketplaceProduct.platformId)
  return rows.map((r) => ({
    ...r,
    collected: r.collected as CollectedSnapshot,
    actual: (r.actual ?? null) as AuditActual | null,
    agreement: (r.agreement ?? null) as AuditAgreement | null,
    link: productPageUrl(r.marketplace, r.platformId, r.url),
  }))
}
