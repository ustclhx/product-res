import {
  CONFIDENCE_ITEMS,
  type ConfidenceItemId,
  type ConfidenceLevel,
  confidenceLevel,
  DEFAULT_SCORING_SETTINGS,
  DIMENSION_LABELS,
  DIMENSIONS,
  type DimensionId,
  INTERNAL_SOURCES,
  needsAttention,
  type Readiness,
} from '@product-res/selection'
import type { AcquisitionMethod, Grade as UiGrade, Readiness as UiReadiness } from '@product-res/ui'

/**
 * 跟卖候选列表与商品簇详情的纯函数（specs/follow-candidates）：平台列、等级显示、命中信号、
 * 以及流水线写入的 JSON 字段（cluster_signal.inputs、lead.confidence_detail / gates、
 * risk_finding.evidence）的解析。JSON 结构与 packages/selection 的 DimensionResult /
 * ConfidenceResult / GateResult 一致，解析时容忍缺字段，缺失按“无数据”处理。
 */

export const PLATFORMS = ['amazon', 'ebay'] as const
export type Platform = (typeof PLATFORMS)[number]
export const PLATFORM_LABELS: Record<Platform, string> = { amazon: 'Amazon', ebay: 'eBay' }

export const CANDIDATE_PAGE_SIZE = 20

export interface CandidateSearch {
  platform: Platform
  direction?: string
  offset: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 路由 search：平台默认 Amazon；方向只接受 UUID；offset 取整到非负 */
export function candidateSearch(search: Record<string, unknown>): CandidateSearch {
  const platform = search.platform === 'ebay' ? 'ebay' : 'amazon'
  const direction =
    typeof search.direction === 'string' && UUID_RE.test(search.direction)
      ? search.direction
      : undefined
  const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(search.offset) || 0)))
  return { platform, ...(direction ? { direction } : {}), offset }
}

/** 站点所属平台（ebay-us → ebay） */
export function platformOfMarketplace(marketplace: string): Platform | null {
  if (marketplace.startsWith('ebay-')) return 'ebay'
  if (marketplace.startsWith('amazon-')) return 'amazon'
  return null
}

/** 候选列表的列；eBay 没有 BSR（spec「切换到 eBay」） */
export const CANDIDATE_COLUMNS = [
  'cluster',
  'grade',
  'score',
  'confidence',
  'signals',
  'risks',
  'price',
  'bsr',
  'deadline',
  'sources',
] as const
export type CandidateColumnId = (typeof CANDIDATE_COLUMNS)[number]

export function candidateColumnIds(platform: Platform): CandidateColumnId[] {
  return CANDIDATE_COLUMNS.filter((id) => id !== 'bsr' || platform === 'amazon')
}

/** 选择包的准备度 → 界面组件的准备度（命名不同：observation / observing） */
export function uiReadiness(readiness: Readiness): UiReadiness {
  return readiness === 'observation' ? 'observing' : readiness
}

/**
 * 界面显示的等级：硬门槛不通过（含一票否决）始终“不推荐”；其余在冷启动或没有综合分时“未验证”。
 * 与 packages/selection 的 evaluateLead().displayGrade 规则一致（docs/plan/blockers.md D1）。
 */
export function displayGrade(input: {
  score: number | null
  gatesPassed: boolean
  vetoed: boolean
  readiness: Readiness
}): UiGrade {
  if (input.vetoed || !input.gatesPassed) return 'reject'
  if (input.score === null || input.readiness === 'cold-start') return 'unverified'
  if (input.score >= 75) return 'recommend'
  if (input.score >= 50) return 'caution'
  return 'reject'
}

export interface DimensionScore {
  dimension: DimensionId
  score: number | null
}

export interface HitSignal {
  dimension: DimensionId
  label: string
  /** 对综合分的贡献方向上的分数（反向维度已取 100 − 分数） */
  effective: number
}

/** 命中信号的最低有效分 */
export const HIT_SIGNAL_MIN = 60

/** 得分高的维度标签：按有效分降序取前 limit 个；反向维度按 100 − 分数比较，缺失维度不参与 */
export function hitSignals(
  scores: readonly DimensionScore[],
  reversed: readonly string[] = DEFAULT_SCORING_SETTINGS.reversed,
  limit = 3,
): HitSignal[] {
  const reverse = new Set(reversed)
  return scores
    .filter((s): s is { dimension: DimensionId; score: number } => s.score !== null)
    .map((s) => ({
      dimension: s.dimension,
      label: DIMENSION_LABELS[s.dimension],
      effective: Math.round(reverse.has(s.dimension) ? 100 - s.score : s.score),
    }))
    .filter((s) => s.effective >= HIT_SIGNAL_MIN)
    .sort((a, b) => b.effective - a.effective || a.label.localeCompare(b.label))
    .slice(0, limit)
}

/** 高分低置信：“值得关注但证据不足” */
export function attention(score: number | null, confidence: number | null): boolean {
  return confidence !== null && needsAttention(score, confidenceLevel(confidence))
}

// ---------- 流水线 JSON 字段解析 ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const METHODS = new Set<AcquisitionMethod>(['official', 'estimate', 'derived', 'import'])

export interface SignalSource {
  metric: string
  value: number
  observedOn: string
  sourceId: string
  method: AcquisitionMethod
  fetchedAt: string
  entityId: string | null
}

export interface ParsedSignal {
  reason: string | null
  sources: SignalSource[]
  detail: Record<string, number | boolean | string>
}

/** cluster_signal.inputs：{ inputs: SourceRef[], reason, detail } */
export function parseSignalInputs(json: unknown): ParsedSignal {
  if (!isRecord(json)) return { reason: null, sources: [], detail: {} }
  const list = Array.isArray(json.inputs) ? json.inputs : []
  const sources: SignalSource[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const metric = str(item.metric)
    const value = num(item.value)
    const sourceId = str(item.sourceId)
    const method = str(item.method) as AcquisitionMethod | null
    if (!metric || value === null || !sourceId || !method || !METHODS.has(method)) continue
    sources.push({
      metric,
      value,
      observedOn: str(item.observedOn) ?? '',
      sourceId,
      method,
      fetchedAt: str(item.fetchedAt) ?? '',
      entityId: str(item.entityId),
    })
  }
  const detail: Record<string, number | boolean | string> = {}
  if (isRecord(json.detail)) {
    for (const [k, v] of Object.entries(json.detail)) {
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') detail[k] = v
    }
  }
  return { reason: str(json.reason), sources, detail }
}

/** 维度来源中的外部数据源（去掉选品配置、风险规则等内部来源），按来源去重 */
export function externalSources(
  sources: readonly SignalSource[],
): { sourceId: string; method: AcquisitionMethod }[] {
  const internal = new Set<string>(Object.values(INTERNAL_SOURCES))
  const seen = new Map<string, AcquisitionMethod>()
  for (const s of sources) {
    if (!internal.has(s.sourceId) && !seen.has(s.sourceId)) seen.set(s.sourceId, s.method)
  }
  return [...seen].map(([sourceId, method]) => ({ sourceId, method }))
}

export interface ConfidenceItemView {
  id: ConfidenceItemId
  value: number | null
  note: string
}

export interface ParsedConfidence {
  items: ConfidenceItemView[]
  unverifiedMetrics: string[]
  readiness: Readiness
}

const READINESS = new Set<Readiness>(['cold-start', 'observation', 'usable', 'trusted'])

/** lead.confidence_detail：{ items, unverifiedMetrics, readiness }；M5 前准备度一律按冷启动 */
export function parseConfidence(json: unknown): ParsedConfidence {
  const items: ConfidenceItemView[] = []
  let unverifiedMetrics: string[] = []
  let readiness: Readiness = 'cold-start'
  if (isRecord(json)) {
    const known = new Set<string>(CONFIDENCE_ITEMS)
    for (const item of Array.isArray(json.items) ? json.items : []) {
      if (!isRecord(item) || !known.has(String(item.id))) continue
      items.push({
        id: item.id as ConfidenceItemId,
        value: num(item.value),
        note: str(item.note) ?? '',
      })
    }
    if (Array.isArray(json.unverifiedMetrics))
      unverifiedMetrics = json.unverifiedMetrics.filter((m): m is string => typeof m === 'string')
    if (READINESS.has(json.readiness as Readiness)) readiness = json.readiness as Readiness
  }
  return { items, unverifiedMetrics, readiness }
}

/** lead.gates：{ passed, failures: [{ gate, reason }] }；没有记录时视为通过 */
export function parseGates(json: unknown): { passed: boolean; reasons: string[] } {
  if (!isRecord(json)) return { passed: true, reasons: [] }
  const reasons = (Array.isArray(json.failures) ? json.failures : [])
    .map((f) => (isRecord(f) ? str(f.reason) : null))
    .filter((r): r is string => Boolean(r))
  return { passed: json.passed === false ? false : reasons.length === 0, reasons }
}

/** risk_finding.evidence：{ basis, link } */
export function parseEvidence(json: unknown): { basis: string | null; link: string | null } {
  if (!isRecord(json)) return { basis: null, link: null }
  const link = str(json.link)
  // 只接受 http(s) 链接，避免把任意协议渲染成可点击链接
  return { basis: str(json.basis), link: link && /^https?:\/\//.test(link) ? link : null }
}

/** 7 个维度按固定顺序展开，缺失维度为 null */
export function allDimensions<T extends { dimension: string }>(
  rows: readonly T[],
): Array<{ dimension: DimensionId; label: string; row: T | null }> {
  const byId = new Map(rows.map((r) => [r.dimension, r]))
  return DIMENSIONS.map((dimension) => ({
    dimension,
    label: DIMENSION_LABELS[dimension],
    row: byId.get(dimension) ?? null,
  }))
}

export type { ConfidenceLevel }
