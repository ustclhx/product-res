import { type CostParams, resolveCostParams, type ShippingFormula } from '@product-res/costing'
import {
  type CostParamRow,
  costingScenario,
  costParam,
  type LogisticsProfileRow,
  logisticsProfile,
  scoped,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, asc, eq, isNull, ne, type SQL, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import {
  type CostParamInput,
  costParamInput,
  type LogisticsProfileInput,
  logisticsProfileInput,
} from './inputs.ts'
import { LOGISTICS_TYPE_RULES } from './labels.ts'

/**
 * 设置页“物流方案 / 成本参数”（specs/logistics-costs）。
 * 物流方案的计费公式直接按 packages/costing 的 ShippingFormula 存 JSON；
 * 成本参数按平台 × 类目保存，类目未填的项在核算时回退到平台默认（resolveCostParams）。
 */

const all = (...conditions: (SQL | undefined)[]) => and(...conditions) as SQL
const conflict = (message: string) => new AppError('CONFLICT', message, { status: 409 })
const invalid = (message: string) => new AppError('INVALID_INPUT', message, { status: 400 })

const profileRow = (p: LogisticsProfileRow) => ({
  id: p.id,
  name: p.name,
  platform: p.platform,
  type: p.type,
  transitDays: p.transitDays,
  headFreight: (p.headFreight as ShippingFormula | null) ?? null,
  lastMile: (p.lastMile as ShippingFormula | null) ?? null,
  bannedAttributes: p.bannedAttributes,
  updatedAt: p.updatedAt.toISOString(),
})
export type LogisticsProfileView = ReturnType<typeof profileRow>

const PARAM_KEYS = [
  'commissionRate',
  'fixedFeeMinor',
  'adRate',
  'returnRate',
  'storageMonthlyMinor',
  'storageMonths',
  'inboundFeeMinor',
] as const satisfies readonly (keyof CostParams)[]

function paramsOf(row: CostParamRow | undefined): CostParams {
  const params: CostParams = {}
  if (!row) return params
  for (const key of PARAM_KEYS) params[key] = row[key]
  return params
}

/** 每行附带类目回退后的生效值与来源，界面据此标注“平台默认” */
function paramRows(rows: CostParamRow[]) {
  const defaults = new Map(rows.filter((r) => r.categoryId == null).map((r) => [r.platform, r]))
  return rows.map((row) => {
    const own = paramsOf(row)
    const resolved =
      row.categoryId == null
        ? resolveCostParams(own)
        : resolveCostParams(paramsOf(defaults.get(row.platform)), own)
    return {
      id: row.id,
      platform: row.platform,
      categoryId: row.categoryId,
      values: own,
      effective: resolved.params,
      sources: resolved.sources,
      updatedAt: row.updatedAt.toISOString(),
    }
  })
}
export type CostParamView = ReturnType<typeof paramRows>[number]

export async function costingSettings(actor: WorkbenchActor) {
  const s = scoped(actor.db, actor.workspaceId)
  const [profiles, params] = await Promise.all([
    s.select(logisticsProfile).orderBy(asc(logisticsProfile.platform), asc(logisticsProfile.name)),
    // 平台默认（类目为空）排在每个平台最前
    s
      .select(costParam)
      .orderBy(
        asc(costParam.platform),
        sql`${costParam.categoryId} is not null`,
        asc(costParam.categoryId),
      ),
  ])
  return { profiles: profiles.map(profileRow), params: paramRows(params) }
}

/** 核算用：平台 × 类目的生效参数与来源（类目未配置的项取平台默认） */
export async function effectiveCostParams(
  actor: Pick<WorkbenchActor, 'db' | 'workspaceId'>,
  platform: CostParamRow['platform'],
  categoryId?: string | null,
) {
  const s = scoped(actor.db, actor.workspaceId)
  const rows = await s.select(costParam, {
    where: all(
      eq(costParam.platform, platform),
      categoryId
        ? sql`(${costParam.categoryId} is null or ${costParam.categoryId} = ${categoryId})`
        : isNull(costParam.categoryId),
    ),
  })
  const fallback = rows.find((r) => r.categoryId == null)
  const category = categoryId ? rows.find((r) => r.categoryId === categoryId) : undefined
  return resolveCostParams(paramsOf(fallback), category ? paramsOf(category) : null)
}

// ---- 物流方案 ----

function profileValues(raw: LogisticsProfileInput) {
  const input = logisticsProfileInput.parse(raw)
  const rule = LOGISTICS_TYPE_RULES[input.type]
  if (rule.platform !== input.platform) throw invalid('物流类型与平台不一致')
  if (rule.headFreight && !input.headFreight) throw invalid('海外仓与 FBA 方案需要头程计费公式')
  if (rule.lastMile && !input.lastMile) throw invalid('直发与海外仓方案需要运费 / 尾程计费公式')
  return {
    name: input.name,
    platform: input.platform,
    type: input.type,
    transitDays: input.transitDays,
    // 类型不需要的公式不保存，避免切换类型后残留旧公式参与核算
    headFreight: rule.headFreight ? (input.headFreight ?? null) : null,
    lastMile: rule.lastMile ? (input.lastMile ?? null) : null,
    // 禁运属性与风险规则的商品属性一样统一小写
    bannedAttributes: [...new Set(input.bannedAttributes.map((a) => a.toLowerCase()))],
  }
}

export async function saveLogisticsProfile(
  actor: WorkbenchActor,
  id: string | undefined,
  input: LogisticsProfileInput,
) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const values = profileValues(input)
  const same = await s.count(
    logisticsProfile,
    and(eq(logisticsProfile.name, values.name), id ? ne(logisticsProfile.id, id) : undefined),
  )
  if (same > 0) throw conflict('已有同名物流方案')
  if (id) return profileRow(await s.updateById(logisticsProfile, id, values))
  const [row] = await s.insert(logisticsProfile, values).returning()
  if (!row) throw new Error('insert logistics profile failed')
  return profileRow(row)
}

export async function deleteLogisticsProfile(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  await s.findById(logisticsProfile, id)
  // 核算方案保存的是计算快照，被引用的方案删除后无法追溯输入，因此拒绝
  if ((await s.count(costingScenario, eq(costingScenario.profileId, id))) > 0)
    throw conflict('该物流方案已被核算方案引用，不能删除')
  await s.deleteById(logisticsProfile, id)
}

// ---- 成本参数 ----

function paramValues(raw: CostParamInput) {
  const input = costParamInput.parse(raw)
  const categoryId = input.categoryId?.trim() || null
  const values = {
    platform: input.platform,
    categoryId,
    commissionRate: input.commissionRate ?? null,
    fixedFeeMinor: input.fixedFeeMinor ?? null,
    adRate: input.adRate ?? null,
    returnRate: input.returnRate ?? null,
    storageMonthlyMinor: input.storageMonthlyMinor ?? null,
    storageMonths: input.storageMonths ?? null,
    inboundFeeMinor: input.inboundFeeMinor ?? null,
  }
  if (PARAM_KEYS.every((k) => values[k] == null)) throw invalid('至少填写一项成本参数')
  return values
}

export async function saveCostParam(
  actor: WorkbenchActor,
  id: string | undefined,
  input: CostParamInput,
) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const values = paramValues(input)
  // 与唯一索引 (workspace, platform, coalesce(category, '')) 一致，先查重给出可读错误
  const same = await s.count(
    costParam,
    and(
      eq(costParam.platform, values.platform),
      values.categoryId
        ? eq(costParam.categoryId, values.categoryId)
        : isNull(costParam.categoryId),
      id ? ne(costParam.id, id) : undefined,
    ),
  )
  if (same > 0)
    throw conflict(values.categoryId ? '该平台已配置这个类目的参数' : '该平台已有默认参数')
  if (id) await s.updateById(costParam, id, values)
  else await s.insert(costParam, values)
  return (await costingSettings(actor)).params
}

export async function deleteCostParam(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  await scoped(actor.db, actor.workspaceId).deleteById(costParam, id)
}
