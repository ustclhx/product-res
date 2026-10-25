import {
  type DecisionRow,
  decision,
  direction,
  type FollowOutcomeRow,
  followOutcome,
  lead,
  leadEvent,
  scoped,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import { addDaysIso, reviewDueOn, todaySgt } from './dates.ts'
import type { DecisionActor, DecisionSnapshot } from './decisions.server.ts'
import { type OutcomeInput, outcomeInput } from './inputs.ts'
import { REVIEW_DAYS } from './labels.ts'
import { type ScenarioSummary, summarizeScenario } from './scenario.ts'

/**
 * 选品档案库（specs/selection-archive）：只展示决定快照里的值，不随线索重算变化；
 * 跟卖决定在计划上架日 + 30 天后待回看，录入实际销量与售价后与当初预测对比。
 */

/** 回看提醒在 lead_event 上的幂等标记（apps/jobs/src/review 写入） */
export const REVIEW_REMINDER_EVENT = 'review-reminder'

export interface ArchiveFilters {
  platform?: 'amazon' | 'ebay' | undefined
  directionId?: string | undefined
  kind?: DecisionRow['kind'] | undefined
  /** 决定日期范围（新加坡时间，含首尾） */
  from?: string | undefined
  to?: string | undefined
}

const all = (...conditions: (SQL | undefined)[]) => and(...conditions) as SQL

const ARCHIVE_LIMIT = 200
const SGT = '+08:00'

export interface OutcomeComparison {
  firstBatchQty: number | null
  actualUnits: number
  /** 实际销量 ÷ 首批数量 */
  sellThrough: number | null
  targetPriceMinor: number | null
  actualPriceMinor: number | null
  priceDeltaRate: number | null
  predictedMargin: number | null
  /** 按决定时组合的落地成本与费率比例，换成实际售价估算的毛利率 */
  estimatedMargin: number | null
}

/** 与决定时的预测对比；费率项按所选组合的“费用 ÷ 售价”比例近似 */
export function compareOutcome(
  d: Pick<DecisionRow, 'firstBatchQty' | 'targetPriceMinor'>,
  scenario: ScenarioSummary | null,
  actual: { actualUnits: number; actualPriceMinor?: number | null | undefined },
): OutcomeComparison {
  const price = actual.actualPriceMinor ?? null
  const target = d.targetPriceMinor
  let estimatedMargin: number | null = null
  const sale = scenario?.salePriceMinor
  const landed = scenario?.landedCostMinor
  const net = scenario?.netProfitMinor
  if (price && sale && landed != null && net != null) {
    const feeRatio = (sale - landed - net) / sale
    estimatedMargin = (price - landed - price * feeRatio) / price
  }
  return {
    firstBatchQty: d.firstBatchQty,
    actualUnits: actual.actualUnits,
    sellThrough: d.firstBatchQty ? actual.actualUnits / d.firstBatchQty : null,
    targetPriceMinor: target,
    actualPriceMinor: price,
    priceDeltaRate: price && target ? (price - target) / target : null,
    predictedMargin: scenario?.grossMargin ?? null,
    estimatedMargin,
  }
}

type ReviewState =
  | { status: 'n/a' }
  | { status: 'waiting' | 'due'; dueOn: string; notified: boolean }
  | { status: 'reviewed'; dueOn: string; outcome: ReturnType<typeof outcomeView> }

const outcomeView = (o: FollowOutcomeRow) => ({
  actualUnits: o.actualUnits,
  actualPriceMinor: o.actualPriceMinor,
  currency: o.currency,
  note: o.note,
  comparison: o.comparison as unknown as OutcomeComparison,
  recordedAt: o.recordedAt.toISOString(),
})

function reviewState(
  d: DecisionRow,
  outcome: FollowOutcomeRow | undefined,
  notified: boolean,
  today: string,
): ReviewState {
  if (d.kind !== 'follow' || !d.plannedListingOn) return { status: 'n/a' }
  const dueOn = reviewDueOn(d.plannedListingOn)
  if (outcome) return { status: 'reviewed', dueOn, outcome: outcomeView(outcome) }
  return { status: dueOn <= today ? 'due' : 'waiting', dueOn, notified }
}

const snapshotOf = (d: DecisionRow) => d.snapshot as unknown as DecisionSnapshot

function archiveRow(
  d: DecisionRow,
  outcome: FollowOutcomeRow | undefined,
  notified: boolean,
  today: string,
) {
  const snap = snapshotOf(d)
  return {
    id: d.id,
    leadId: d.leadId,
    kind: d.kind,
    decidedAt: d.decidedAt.toISOString(),
    clusterName: snap.cluster?.name ?? '—',
    marketplace: snap.cluster?.marketplace ?? null,
    directionName: snap.direction?.name ?? '—',
    score: snap.lead?.score ?? null,
    grade: snap.lead?.grade ?? null,
    confidence: snap.lead?.confidence ?? null,
    settingVersion: snap.lead?.settingVersion ?? null,
    scenario: snap.scenario ? summarizeScenario(snap.scenario.result) : null,
    firstBatchQty: d.firstBatchQty,
    targetPriceMinor: d.targetPriceMinor,
    currency: d.currency,
    plannedListingOn: d.plannedListingOn,
    dropReason: d.dropReason,
    dropNote: d.dropNote,
    review: reviewState(d, outcome, notified, today),
  }
}
export type ArchiveRow = ReturnType<typeof archiveRow>

async function reviewContext(actor: WorkbenchActor, rows: DecisionRow[]) {
  const s = scoped(actor.db, actor.workspaceId)
  const follows = rows.filter((d) => d.kind === 'follow')
  if (follows.length === 0) return { outcomes: new Map(), notified: new Set<string>() }
  const ids = follows.map((d) => d.id)
  const [outcomes, events] = await Promise.all([
    s.select(followOutcome, {
      where: all(inArray(followOutcome.decisionId, ids), eq(followOutcome.reviewDays, REVIEW_DAYS)),
    }),
    s.select(leadEvent, {
      where: all(
        inArray(
          leadEvent.leadId,
          follows.map((d) => d.leadId),
        ),
        eq(leadEvent.kind, 'note'),
        sql`${leadEvent.payload}->>'type' = ${REVIEW_REMINDER_EVENT}`,
      ),
      fields: { decisionId: sql<string>`${leadEvent.payload}->>'decisionId'` },
    }),
  ])
  return {
    outcomes: new Map<string, FollowOutcomeRow>(outcomes.map((o) => [o.decisionId, o])),
    notified: new Set(events.map((e) => e.decisionId)),
  }
}

export async function archivePage(
  actor: WorkbenchActor,
  filters: ArchiveFilters = {},
  now = new Date(),
) {
  const s = scoped(actor.db, actor.workspaceId)
  // 平台按决定快照过滤（档案库反映决定当时的站点）；方向按线索当前所属方向过滤：
  // 快照是历史事实，跨空间复制 / 移动后其中的方向 id 指向源空间（add-workspace-data-transfer）
  const where = and(
    filters.kind ? eq(decision.kind, filters.kind) : undefined,
    filters.platform
      ? sql`${decision.snapshot}->'cluster'->>'marketplace' like ${`${filters.platform}-%`}`
      : undefined,
    filters.directionId
      ? sql`exists (select 1 from ${lead} where ${lead.id} = ${decision.leadId}
          and ${lead.directionId} = ${filters.directionId})`
      : undefined,
    filters.from ? gte(decision.decidedAt, new Date(`${filters.from}T00:00:00${SGT}`)) : undefined,
    filters.to
      ? lt(decision.decidedAt, new Date(`${addDaysIso(filters.to, 1)}T00:00:00${SGT}`))
      : undefined,
  )
  const [rows, directions] = await Promise.all([
    s
      .select(decision, where ? { where } : {})
      .orderBy(desc(decision.decidedAt))
      .limit(ARCHIVE_LIMIT),
    s
      .select(direction, { fields: { id: direction.id, name: direction.name } })
      .orderBy(asc(direction.name)),
  ])
  const ctx = await reviewContext(actor, rows)
  const today = todaySgt(now)
  const list = rows.map((d) => archiveRow(d, ctx.outcomes.get(d.id), ctx.notified.has(d.id), today))
  return {
    today,
    rows: list,
    truncated: rows.length === ARCHIVE_LIMIT,
    directions,
    pendingReviews: list.filter((r) => r.review.status === 'due').length,
  }
}

/** 单条决定的完整快照（含 cluster_signal 输入引用） */
export async function decisionDetail(actor: WorkbenchActor, id: string, now = new Date()) {
  const d = await scoped(actor.db, actor.workspaceId).findById(decision, id)
  const ctx = await reviewContext(actor, [d])
  return {
    ...archiveRow(d, ctx.outcomes.get(d.id), ctx.notified.has(d.id), todaySgt(now)),
    snapshot: snapshotOf(d),
  }
}

export async function recordOutcome(actor: DecisionActor, decisionId: string, raw: OutcomeInput) {
  assertWorkbenchWriter(actor)
  const input = outcomeInput.parse(raw)
  const s = scoped(actor.db, actor.workspaceId)
  const d = await s.findById(decision, decisionId)
  if (d.kind !== 'follow')
    throw new AppError('INVALID_INPUT', '只有跟卖决定需要回看', { status: 400 })
  const snap = snapshotOf(d)
  const comparison = compareOutcome(
    d,
    snap.scenario ? summarizeScenario(snap.scenario.result) : null,
    input,
  )
  const values = {
    actualUnits: input.actualUnits,
    actualPriceMinor: input.actualPriceMinor ?? null,
    currency: d.currency,
    note: input.note || null,
    comparison: comparison as unknown as Record<string, unknown>,
    recordedBy: actor.userId,
    recordedAt: new Date(),
  }
  // 同一决定的 30 天回看只有一份，重复录入视为更正
  await s
    .insert(followOutcome, { decisionId, reviewDays: REVIEW_DAYS, ...values })
    .onConflictDoUpdate({
      target: [followOutcome.decisionId, followOutcome.reviewDays],
      set: values,
    })
  return decisionDetail(actor, decisionId)
}
