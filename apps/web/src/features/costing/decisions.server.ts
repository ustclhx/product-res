import {
  type CostingScenarioRow,
  cluster,
  clusterSignal,
  costingScenario,
  decision,
  direction,
  type JsonValue,
  lead,
  leadEvent,
  notFound,
  type Scoped,
  scoped,
  seasonalNode,
  sourceBudget,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, desc, eq, gte, inArray, type SQL, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import { deadlineTone, nextNodeStart, todaySgt, weekStartSgt } from './dates.ts'
import { type DecisionInput, decisionInput } from './inputs.ts'
import { isLeadDecided } from './labels.ts'
import { latestLeadOf } from './quotes.server.ts'
import { summarizeScenario } from './scenario.ts'

/**
 * 工作台首页（待决定队列、KPI、节点倒计时）与跟卖 / 放弃决定（specs/decision-queue、design D4）。
 * 决定写入 decision（含当时的快照）与 lead_event，线索进入终态后不能再改核算。
 */

export interface DecisionActor extends WorkbenchActor {
  userId: string
}

type Lead = typeof lead.$inferSelect

/** and() 的结果在至少有一个条件时不为空 */
const all = (...conditions: (SQL | undefined)[]) => and(...conditions) as SQL

const conflict = (code: string, message: string) => new AppError(code, message, { status: 409 })

/**
 * 线索按簇 × 日期每天生成一条，新线索继承上一条的状态与核算组合（packages/follow 流水线），
 * 所以核算与决定都作用于簇的最新线索：传入较早的线索 id（如页面停留跨天）时解析到同簇最新一条。
 */
export async function currentLeadOf(s: Scoped, leadId: string): Promise<Lead> {
  const row = await s.findById(lead, leadId)
  return (await latestLeadOf(s, row.clusterId)) ?? row
}

/** 簇的最新线索（候选数、待决定队列只看它，同一簇每天的线索不重复计入） */
export const isLatestLead = sql`${lead.leadOn} = (select max(l2.lead_on) from lead l2 where l2.cluster_id = ${lead.clusterId})`
/** 簇的任一线索已有决定 */
const clusterHasDecision = sql`exists (select 1 from decision d join lead l3 on l3.id = d.lead_id where l3.cluster_id = ${lead.clusterId})`

/**
 * 簇是否已决定（核算按簇锁定，与报价锁定一致）：最新线索继承了已决定状态，或该簇任一线索已有 decision。
 */
export async function isClusterDecided(s: Scoped, row: Pick<Lead, 'clusterId' | 'status'>) {
  if (isLeadDecided(row.status)) return true
  const [hit] = await s
    .select(decision, {
      where: sql`${decision.leadId} in (select l.id from lead l where l.cluster_id = ${row.clusterId})`,
      fields: { id: decision.id },
    })
    .limit(1)
  return Boolean(hit)
}

/** 簇已决定时拒绝修改核算；核算矩阵（tasks 3.1）在写 costing_scenario 前调用。返回簇的最新线索 */
export async function assertCostingEditable(
  actor: Pick<WorkbenchActor, 'db' | 'workspaceId'>,
  leadId: string,
) {
  const s = scoped(actor.db, actor.workspaceId)
  const row = await currentLeadOf(s, leadId)
  if (await isClusterDecided(s, row))
    throw conflict('LEAD_DECIDED', '线索已作出决定，核算已锁定；如需重新核算请新建线索')
  return row
}

// ---- 工作台首页 ----

/** 今日数据源额度：按天计的额度中使用率最高的一项；没有任何按天额度时为空 */
async function quotaToday(actor: WorkbenchActor, today: string) {
  // source_budget 是部署级表（不带空间列），所有空间共用同一份数据源额度
  const rows = await actor.db.select().from(sourceBudget).where(eq(sourceBudget.periodKey, today))
  const usable = rows.filter((r) => r.hardCap > 0)
  if (usable.length === 0) return null
  const ranked = usable
    .map((r) => ({
      sourceId: r.sourceId,
      used: r.reserved + r.settled,
      cap: r.hardCap,
      unit: r.unit,
      ratio: (r.reserved + r.settled) / r.hardCap,
    }))
    .sort((a, b) => b.ratio - a.ratio)
  return { top: ranked[0] as (typeof ranked)[number], sources: ranked.length }
}

function queueRow(
  l: Lead,
  names: { cluster?: { name: string; marketplace: string }; direction?: string },
  scenario: CostingScenarioRow | undefined,
  today: string,
) {
  const summary = scenario ? summarizeScenario(scenario.result) : null
  // 所选组合算出的最晚决定日优先，其次线索生成时的估算值
  const deadline = summary?.deadline ?? l.latestDecisionOn
  return {
    leadId: l.id,
    clusterName: names.cluster?.name ?? '—',
    marketplace: names.cluster?.marketplace ?? null,
    directionName: names.direction ?? '—',
    score: l.score,
    grade: l.grade,
    confidence: l.confidence,
    deadline,
    tone: deadlineTone(deadline, today),
    scenario: scenario
      ? {
          id: scenario.id,
          mode: scenario.mode,
          plannedQty: scenario.plannedQty,
          currency: summary?.currency ?? scenario.currency,
          salePriceMinor: summary?.salePriceMinor ?? scenario.salePriceMinor,
          landedCostMinor: summary?.landedCostMinor ?? null,
          grossMargin: summary?.grossMargin ?? null,
        }
      : null,
  }
}
export type QueueRow = ReturnType<typeof queueRow>

async function namesFor(s: Scoped, rows: Pick<Lead, 'clusterId' | 'directionId'>[]) {
  const clusterIds = [...new Set(rows.map((r) => r.clusterId))]
  const directionIds = [...new Set(rows.map((r) => r.directionId))]
  const [clusters, directions] = await Promise.all([
    clusterIds.length
      ? s.select(cluster, {
          where: inArray(cluster.id, clusterIds),
          fields: { id: cluster.id, name: cluster.name, marketplace: cluster.marketplace },
        })
      : [],
    directionIds.length
      ? s.select(direction, {
          where: inArray(direction.id, directionIds),
          fields: { id: direction.id, name: direction.name },
        })
      : [],
  ])
  return {
    cluster: new Map(clusters.map((c) => [c.id, c])),
    direction: new Map(directions.map((d) => [d.id, d.name])),
  }
}

export async function workbenchHome(actor: WorkbenchActor, now = new Date()) {
  const today = todaySgt(now)
  const s = scoped(actor.db, actor.workspaceId)
  const [pending, candidates, decidedThisWeek, nodes, quota] = await Promise.all([
    // 线索按簇 × 日期生成，同一簇每天一条：队列与候选数都只看簇的最新线索，已有决定的簇不再列出
    s.select(lead, {
      where: all(eq(lead.status, 'pending'), isLatestLead, sql`not ${clusterHasDecision}`),
    }),
    s.select(lead, {
      where: all(inArray(lead.status, ['new', 'costing']), isLatestLead),
      fields: { n: sql<number>`count(distinct ${lead.clusterId})::int` },
    }),
    s.count(decision, gte(decision.decidedAt, weekStartSgt(now))),
    s.select(seasonalNode),
    quotaToday(actor, today),
  ])
  const names = await namesFor(s, pending)
  const scenarios = pending.length
    ? await s.select(costingScenario, {
        where: all(
          inArray(
            costingScenario.leadId,
            pending.map((l) => l.id),
          ),
          eq(costingScenario.selected, true),
        ),
      })
    : []
  const selected = new Map(scenarios.map((sc) => [sc.leadId, sc]))
  const queue = pending
    .map((l) => {
      const c = names.cluster.get(l.clusterId)
      const d = names.direction.get(l.directionId)
      return queueRow(
        l,
        { ...(c ? { cluster: c } : {}), ...(d ? { direction: d } : {}) },
        selected.get(l.id),
        today,
      )
    })
    // 最晚决定日升序，没有日期的排最后
    .sort((a, b) => (a.deadline ?? '9999-12-31').localeCompare(b.deadline ?? '9999-12-31'))
  const countdown = nodes
    .map((n) => ({ id: n.id, name: n.name, salesDays: n.salesDays, ...nextNodeStart(n, today) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 6)
  return {
    today,
    kpi: {
      candidates: candidates[0]?.n ?? 0,
      pending: pending.length,
      decidedThisWeek,
      quota,
    },
    queue,
    countdown,
  }
}

// ---- 决定 ----

/** 决定快照：决定当时的线索分数、所选组合与观测引用；档案库只读这里，不重算 */
export interface DecisionSnapshot {
  lead: {
    id: string
    leadOn: string
    score: number | null
    grade: string | null
    confidence: number | null
    confidenceDetail: JsonValue | null
    settingVersion: number
    latestDecisionOn: string | null
    vetoed: boolean
  }
  cluster: { id: string; name: string; marketplace: string }
  direction: { id: string; name: string }
  scenario: {
    id: string
    quoteId: string
    profileId: string
    mode: string
    plannedQty: number
    salePriceMinor: number | null
    currency: string | null
    result: JsonValue
    computedAt: string
  } | null
  /** cluster_signal 的输入引用（观测值主键、来源与获取时间） */
  signals: { dimension: string; observedOn: string; score: number | null; inputs: JsonValue }[]
}

export async function decideLead(actor: DecisionActor, leadId: string, raw: DecisionInput) {
  assertWorkbenchWriter(actor)
  const input = decisionInput.parse(raw)
  if (input.kind === 'drop' && input.reason === 'other' && !input.note)
    throw new AppError('INVALID_INPUT', '选择“其他”时请填写说明', { status: 400 })

  return scoped(actor.db, actor.workspaceId).transaction(async (tx) => {
    const [given] = await tx.select(lead, {
      where: eq(lead.id, leadId),
      fields: { clusterId: lead.clusterId },
    })
    if (!given) throw notFound()
    // 决定作用于簇的最新线索（它继承了选定组合）；锁住该行，避免两人同时决定
    const [row] = await tx
      .select(lead, { where: eq(lead.clusterId, given.clusterId) })
      .orderBy(desc(lead.leadOn))
      .limit(1)
      .for('update')
    if (!row) throw notFound()
    if (await isClusterDecided(tx, row)) throw conflict('LEAD_DECIDED', '该线索已作出决定')
    const [scenario] = await tx
      .select(costingScenario, {
        where: all(eq(costingScenario.leadId, row.id), eq(costingScenario.selected, true)),
      })
      .limit(1)
    if (input.kind === 'follow' && (row.status !== 'pending' || !scenario))
      throw conflict('NO_SELECTED_SCENARIO', '线索还没有选定核算组合，不能跟卖')

    const [c, d, signals] = await Promise.all([
      tx.findById(cluster, row.clusterId),
      tx.findById(direction, row.directionId),
      tx.select(clusterSignal, {
        where: all(
          eq(clusterSignal.clusterId, row.clusterId),
          eq(clusterSignal.observedOn, row.leadOn),
        ),
      }),
    ])
    const snapshot: DecisionSnapshot = {
      lead: {
        id: row.id,
        leadOn: row.leadOn,
        score: row.score,
        grade: row.grade,
        confidence: row.confidence,
        confidenceDetail: (row.confidenceDetail as JsonValue | null) ?? null,
        settingVersion: row.settingVersion,
        latestDecisionOn: row.latestDecisionOn,
        vetoed: row.vetoed,
      },
      cluster: { id: c.id, name: c.name, marketplace: c.marketplace },
      direction: { id: d.id, name: d.name },
      scenario: scenario
        ? {
            id: scenario.id,
            quoteId: scenario.quoteId,
            profileId: scenario.profileId,
            mode: scenario.mode,
            plannedQty: scenario.plannedQty,
            salePriceMinor: scenario.salePriceMinor,
            currency: scenario.currency,
            result: scenario.result as JsonValue,
            computedAt: scenario.computedAt.toISOString(),
          }
        : null,
      signals: signals.map((sg) => ({
        dimension: sg.dimension,
        observedOn: sg.observedOn,
        score: sg.score,
        inputs: sg.inputs as JsonValue,
      })),
    }
    const values =
      input.kind === 'follow'
        ? {
            kind: 'follow' as const,
            firstBatchQty: input.firstBatchQty,
            targetPriceMinor: input.targetPriceMinor,
            currency: input.currency,
            plannedListingOn: input.plannedListingOn,
          }
        : { kind: 'drop' as const, dropReason: input.reason, dropNote: input.note || null }
    const [created] = await tx
      .insert(decision, {
        leadId: row.id,
        scenarioId: scenario?.id ?? null,
        snapshot: snapshot as unknown as Record<string, unknown>,
        decidedBy: actor.userId,
        ...values,
      })
      .returning({ id: decision.id })
    if (!created) throw new Error('insert decision failed')
    const status = input.kind === 'follow' ? 'followed' : 'dropped'
    await tx.updateById(lead, row.id, { status })
    await tx.insert(leadEvent, {
      leadId: row.id,
      clusterId: row.clusterId,
      kind: 'status',
      payload: {
        from: row.status,
        to: status,
        decisionId: created.id,
        ...(input.kind === 'drop' ? { reason: input.reason } : {}),
      },
      actorUserId: actor.userId,
    })
    return { decisionId: created.id, leadId: row.id, status }
  })
}
