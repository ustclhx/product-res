import {
  cluster,
  costingScenario,
  lead,
  leadEvent,
  type Scoped,
  type SupplierQuoteRow,
  scoped,
  supplier,
  supplierQuote,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { DecisionActor } from './decisions.server.ts'
import { type QuoteInput, quoteInput, type SupplierInput, supplierInput } from './inputs.ts'
import { isLeadDecided } from './labels.ts'

/**
 * 供应商与报价（specs/supplier-quotes，tasks 2.3）。供应商是空间级共用的，报价挂在商品簇上；
 * 报价写入后该簇的最新线索从 new 进入 costing（design D4）。簇的最新线索已决定时核算锁定，不能再改报价。
 */

const conflict = (code: string, message: string) => new AppError(code, message, { status: 409 })

/** 簇的最新线索（同一簇按日期一条） */
export async function latestLeadOf(s: Scoped, clusterId: string) {
  const [row] = await s
    .select(lead, { where: eq(lead.clusterId, clusterId) })
    .orderBy(desc(lead.leadOn))
    .limit(1)
  return row ?? null
}

/** 最新线索已决定时拒绝修改该簇的报价（与 assertCostingEditable 同一错误码） */
async function assertClusterEditable(s: Scoped, clusterId: string) {
  await s.findById(cluster, clusterId)
  const latest = await latestLeadOf(s, clusterId)
  if (latest && isLeadDecided(latest.status))
    throw conflict('LEAD_DECIDED', '线索已作出决定，核算已锁定；如需重新核算请新建线索')
  return latest
}

/** 线索进入核算：new → costing，并记 lead_event；其他状态不变 */
export async function enterCosting(
  s: Scoped,
  row: { id: string; clusterId: string; status: string } | null,
  actorUserId: string,
  reason: string,
) {
  if (row?.status !== 'new') return
  await s.updateById(lead, row.id, { status: 'costing' })
  await s.insert(leadEvent, {
    leadId: row.id,
    clusterId: row.clusterId,
    kind: 'status',
    payload: { from: 'new', to: 'costing', reason },
    actorUserId,
  })
}

export const quoteView = (q: SupplierQuoteRow) => ({
  id: q.id,
  supplierId: q.supplierId,
  clusterId: q.clusterId,
  tiers: [...q.tiers].sort((a, b) => a.minQty - b.minQty),
  currency: q.currency,
  moq: q.moq,
  weightG: q.weightG,
  dimensions: q.dimensions ?? null,
  confidence: q.confidence,
  quotedOn: q.quotedOn,
  procurementDays: q.procurementDays,
  source: q.source,
  importId: q.importId,
  note: q.note,
  updatedAt: q.updatedAt.toISOString(),
})
export type QuoteView = ReturnType<typeof quoteView>

/** 簇的报价与全部供应商（录入时可选已有供应商） */
export async function clusterQuotes(
  actor: Pick<DecisionActor, 'db' | 'workspaceId'>,
  clusterId: string,
) {
  const s = scoped(actor.db, actor.workspaceId)
  const [suppliers, quotes] = await Promise.all([
    s.select(supplier).orderBy(asc(supplier.name)),
    s
      .select(supplierQuote, { where: eq(supplierQuote.clusterId, clusterId) })
      .orderBy(desc(supplierQuote.quotedOn), asc(supplierQuote.createdAt)),
  ])
  return {
    suppliers: suppliers.map((x) => ({
      id: x.id,
      name: x.name,
      url: x.url,
      platform: x.platform,
      note: x.note,
    })),
    quotes: quotes.map(quoteView),
  }
}

// ---- 供应商 ----

export async function saveSupplier(
  actor: DecisionActor,
  id: string | undefined,
  raw: SupplierInput,
) {
  assertWorkbenchWriter(actor)
  const input = supplierInput.parse(raw)
  const s = scoped(actor.db, actor.workspaceId)
  const values = {
    name: input.name,
    url: input.url || null,
    platform: input.platform,
    note: input.note || null,
  }
  if (id) return s.updateById(supplier, id, values)
  const [row] = await s.insert(supplier, values).returning()
  if (!row) throw new Error('insert supplier failed')
  return row
}

export async function deleteSupplier(actor: DecisionActor, id: string) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  await s.findById(supplier, id)
  // 报价按供应商级联删除；为免误删其他商品簇的报价，有报价时要求先删报价
  if ((await s.count(supplierQuote, eq(supplierQuote.supplierId, id))) > 0)
    throw conflict('CONFLICT', '该供应商还有报价，请先删除报价')
  await s.deleteById(supplier, id)
}

// ---- 报价 ----

function quoteValues(raw: QuoteInput) {
  const input = quoteInput.parse(raw)
  return {
    supplierId: input.supplierId,
    tiers: [...input.tiers].sort((a, b) => a.minQty - b.minQty),
    currency: input.currency,
    moq: input.moq ?? null,
    weightG: input.weightG ?? null,
    dimensions: input.dimensions ?? null,
    confidence: input.confidence,
    quotedOn: input.quotedOn,
    procurementDays: input.procurementDays ?? null,
    note: input.note || null,
  }
}

export async function saveQuote(
  actor: DecisionActor,
  clusterId: string,
  id: string | undefined,
  raw: QuoteInput,
) {
  assertWorkbenchWriter(actor)
  const values = quoteValues(raw)
  return scoped(actor.db, actor.workspaceId).transaction(async (s) => {
    const latest = await assertClusterEditable(s, clusterId)
    await s.findById(supplier, values.supplierId)
    let row: SupplierQuoteRow
    if (id) {
      const existing = await s.findById(supplierQuote, id)
      if (existing.clusterId !== clusterId)
        throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
      // 手工修改导入的报价后改记为手工录入，撤销导入时不再删除它
      row = await s.updateById(supplierQuote, id, { ...values, source: 'manual' })
    } else {
      const [created] = await s
        .insert(supplierQuote, { ...values, clusterId, source: 'manual', createdBy: actor.userId })
        .returning()
      if (!created) throw new Error('insert quote failed')
      row = created
    }
    await enterCosting(s, latest, actor.userId, 'quote')
    return quoteView(row)
  })
}

/**
 * 删除报价：只引用它的未选定组合一并删除（组合是计算快照，可随时重算）；
 * 被选定组合或已决定线索引用时拒绝，避免待决定队列与档案库失去依据。
 */
export async function removeQuotes(s: Scoped, quoteIds: string[]) {
  if (quoteIds.length === 0) return 0
  const refs = await s.select(costingScenario, {
    where: inArray(costingScenario.quoteId, quoteIds),
    fields: {
      id: costingScenario.id,
      leadId: costingScenario.leadId,
      selected: costingScenario.selected,
    },
  })
  const leadIds = [...new Set(refs.map((r) => r.leadId))]
  const statuses = leadIds.length
    ? await s.select(lead, {
        where: inArray(lead.id, leadIds),
        fields: { id: lead.id, status: lead.status },
      })
    : []
  const decided = new Set(statuses.filter((l) => isLeadDecided(l.status)).map((l) => l.id))
  if (refs.some((r) => r.selected || decided.has(r.leadId)))
    throw conflict('QUOTE_IN_USE', '报价已被选定的核算组合或已决定的线索引用，不能删除')
  if (refs.length > 0)
    await s.delete(
      costingScenario,
      inArray(
        costingScenario.id,
        refs.map((r) => r.id),
      ),
    )
  const removed = await s
    .delete(supplierQuote, inArray(supplierQuote.id, quoteIds))
    .returning({ id: supplierQuote.id })
  return removed.length
}

export async function deleteQuote(actor: DecisionActor, clusterId: string, id: string) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).transaction(async (s) => {
    await assertClusterEditable(s, clusterId)
    const row = await s.findById(supplierQuote, id)
    if (row.clusterId !== clusterId) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    await removeQuotes(s, [id])
  })
}
