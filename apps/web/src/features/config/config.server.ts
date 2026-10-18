import {
  type BrandEntry,
  brandEntry,
  direction,
  ensureSelectionDefaults,
  type RiskRule,
  type RiskRuleMatch,
  riskRule,
  type SeasonalNode,
  scoped,
  seasonalNode,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, arrayContains, asc, eq, ne, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'

/**
 * 设置页：节点日历、品牌库、风险规则（specs/selection-directions、specs/risk-checks）。
 * 物流方案与成本参数属于 M3 核算，不在这里。
 */

export interface NodeInput {
  name: string
  startMonth: number
  startDay: number
  salesDays: number
  keywords: string[]
}
export interface BrandInput {
  name: string
  kind: BrandEntry['kind']
  marketplace?: string | null | undefined
  note?: string | null | undefined
}
export interface RuleInput {
  kind: RiskRule['kind']
  level: RiskRule['level']
  description: string
  match: {
    platform?: 'amazon' | 'ebay' | null | undefined
    categoryIds: string[]
    attributes: string[]
  }
  veto: boolean
  enabled: boolean
}

const conflict = (message: string) => new AppError('CONFLICT', message, { status: 409 })
const iso = (d: Date) => d.toISOString()

const nodeRow = (n: SeasonalNode) => ({
  id: n.id,
  name: n.name,
  startMonth: n.startMonth,
  startDay: n.startDay,
  salesDays: n.salesDays,
  keywords: n.keywords,
  preset: n.preset,
  updatedAt: iso(n.updatedAt),
})
const brandRow = (b: BrandEntry) => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
  marketplace: b.marketplace,
  note: b.note,
  updatedAt: iso(b.updatedAt),
})
const ruleRow = (r: RiskRule) => ({
  id: r.id,
  kind: r.kind,
  level: r.level,
  description: r.description,
  match: {
    platform: r.match.platform ?? null,
    categoryIds: r.match.categoryIds ?? [],
    attributes: r.match.attributes ?? [],
  },
  veto: r.veto,
  enabled: r.enabled,
  updatedAt: iso(r.updatedAt),
})
export type NodeRow = ReturnType<typeof nodeRow>
export type BrandRow = ReturnType<typeof brandRow>
export type RuleRow = ReturnType<typeof ruleRow>

/** 月日组合必须真实存在（按闰年判断，2/29 允许） */
function assertValidDate(month: number, day: number) {
  const days = new Date(Date.UTC(2024, month, 0)).getUTCDate()
  if (day > days) throw new AppError('INVALID_DATE', `${month} 月没有 ${day} 日`, { status: 400 })
}

export async function configPage(actor: WorkbenchActor) {
  const { db, workspaceId } = actor
  await ensureSelectionDefaults(db, workspaceId)
  const s = scoped(db, workspaceId)
  const [nodes, brands, rules] = await Promise.all([
    s.select(seasonalNode).orderBy(asc(seasonalNode.startMonth), asc(seasonalNode.startDay)),
    s.select(brandEntry).orderBy(asc(brandEntry.kind), asc(brandEntry.name)),
    s.select(riskRule).orderBy(asc(riskRule.kind), asc(riskRule.createdAt)),
  ])
  return { nodes: nodes.map(nodeRow), brands: brands.map(brandRow), rules: rules.map(ruleRow) }
}

// ---- 节点日历 ----

async function nodeValues(actor: WorkbenchActor, input: NodeInput, excludeId?: string) {
  assertValidDate(input.startMonth, input.startDay)
  const name = input.name.trim()
  const same = await scoped(actor.db, actor.workspaceId).count(
    seasonalNode,
    excludeId
      ? and(eq(seasonalNode.name, name), ne(seasonalNode.id, excludeId))
      : eq(seasonalNode.name, name),
  )
  if (same > 0) throw conflict('已有同名节点')
  return {
    name,
    startMonth: input.startMonth,
    startDay: input.startDay,
    salesDays: input.salesDays,
    keywords: [...new Set(input.keywords)],
  }
}

export async function saveNode(actor: WorkbenchActor, id: string | undefined, input: NodeInput) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  if (id) {
    await s.findById(seasonalNode, id)
    return nodeRow(await s.updateById(seasonalNode, id, await nodeValues(actor, input, id)))
  }
  const [row] = await s.insert(seasonalNode, await nodeValues(actor, input)).returning()
  if (!row) throw new Error('insert node failed')
  return nodeRow(row)
}

/** 删除节点并从引用它的方向中移除 */
export async function deleteNode(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).transaction(async (s) => {
    await s.deleteById(seasonalNode, id)
    await s.update(
      direction,
      { nodeIds: sql`array_remove(${direction.nodeIds}, ${id}::uuid)` },
      arrayContains(direction.nodeIds, [id]),
    )
  })
}

// ---- 品牌库 ----

export async function saveBrand(actor: WorkbenchActor, id: string | undefined, input: BrandInput) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const values = {
    name: input.name.trim(),
    kind: input.kind,
    marketplace: input.marketplace || null,
    note: input.note?.trim() || null,
  }
  // 同类型、同平台下品牌名不区分大小写唯一
  const duplicate = await s.count(
    brandEntry,
    and(
      sql`lower(${brandEntry.name}) = lower(${values.name})`,
      eq(brandEntry.kind, values.kind),
      values.marketplace
        ? eq(brandEntry.marketplace, values.marketplace)
        : sql`${brandEntry.marketplace} is null`,
      id ? ne(brandEntry.id, id) : undefined,
    ),
  )
  if (duplicate > 0) throw conflict('品牌库中已有该条目')
  if (id) return brandRow(await s.updateById(brandEntry, id, values))
  const [row] = await s.insert(brandEntry, values).returning()
  if (!row) throw new Error('insert brand failed')
  return brandRow(row)
}

export async function deleteBrand(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).deleteById(brandEntry, id)
}

// ---- 风险规则 ----

function ruleValues(input: RuleInput) {
  // 结构与 packages/risk 的 RiskRule.match 一致；属性统一小写便于匹配
  const match: RiskRuleMatch = {}
  const clean = (list: string[]) => [...new Set(list.map((v) => v.trim()).filter(Boolean))]
  const categoryIds = clean(input.match.categoryIds)
  const attributes = clean(input.match.attributes.map((a) => a.toLowerCase()))
  if (input.match.platform) match.platform = input.match.platform
  if (categoryIds.length) match.categoryIds = categoryIds
  if (attributes.length) match.attributes = attributes
  if (!match.categoryIds && !match.attributes)
    throw new AppError('INVALID_RULE', '至少填写一个类目 ID 或商品属性', { status: 400 })
  return {
    kind: input.kind,
    level: input.level,
    description: input.description.trim(),
    match,
    veto: input.veto,
    enabled: input.enabled,
  }
}

export async function saveRule(actor: WorkbenchActor, id: string | undefined, input: RuleInput) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const values = ruleValues(input)
  if (id) return ruleRow(await s.updateById(riskRule, id, values))
  const [row] = await s.insert(riskRule, values).returning()
  if (!row) throw new Error('insert rule failed')
  return ruleRow(row)
}

export async function deleteRule(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).deleteById(riskRule, id)
}
