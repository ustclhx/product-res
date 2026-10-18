import {
  buildCostingMatrix,
  effectiveMoq,
  type FollowMode,
  type FulfillmentFee,
  type MatrixCell,
} from '@product-res/costing'
import type { Marketplace } from '@product-res/datasources'
import {
  cluster,
  clusterMember,
  costingScenario,
  decision,
  direction,
  type JsonValue,
  lead,
  leadEvent,
  logisticsProfile,
  marketplaceProduct,
  notFound,
  scoped,
  seasonalNode,
  supplier,
  supplierQuote,
} from '@product-res/db'
import { latestValue, readMetrics } from '@product-res/marketdata'
import { addDays, DEFAULT_LEAD_TIMES } from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { and, asc, desc, eq, inArray, isNotNull, ne, type SQL, sql } from 'drizzle-orm'
import { platformOfMarketplace } from '../follow/candidates.ts'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import { todaySgt } from './dates.ts'
import {
  assertCostingEditable,
  currentLeadOf,
  type DecisionActor,
  isClusterDecided,
} from './decisions.server.ts'
import {
  type ImprovementInput,
  improvementInput,
  type MatrixOptions,
  matrixOptions,
  type ScenarioPick,
} from './inputs.ts'
import {
  cellIssues,
  cellKey,
  competitorMedian,
  crossRates,
  nearestNode,
  toCostingProfile,
  toCostingQuote,
  toImprovement,
} from './matrix-input.ts'
import { enterCosting, quoteView } from './quotes.server.ts'
import { effectiveCostParams } from './settings.server.ts'

/**
 * 核算矩阵（specs/costing-matrix，tasks 3.1）：供应商报价 × 本平台物流方案 × 跟卖方式，
 * 由 packages/costing 计算。售价默认竞品中位价，汇率取 fx_rate 主值（{币种}/CNY，经 CNY 交叉），
 * 成本参数按类目回退，节点取方向关联节点中最近的一个，提前期默认值沿用 packages/selection。
 * 选定组合写 costing_scenario（result 为完整矩阵格与输入来源），线索进入待决定队列。
 */

const all = (...conditions: (SQL | undefined)[]) => and(...conditions) as SQL
type Actor = Pick<DecisionActor, 'db' | 'workspaceId'>

async function loadContext(actor: Actor, leadId: string, raw: MatrixOptions, now: Date) {
  const opts = matrixOptions.parse(raw)
  const s = scoped(actor.db, actor.workspaceId)
  // 核算标签与写入都落到簇的最新线索：它继承了上一天的状态与核算组合
  const leadRow = await currentLeadOf(s, leadId)
  const c = await s.findById(cluster, leadRow.clusterId)
  const platform = platformOfMarketplace(c.marketplace) ?? 'amazon'
  const today = todaySgt(now)
  const [dir, members, quoteRows, profileRows, selectedRows] = await Promise.all([
    s.findById(direction, leadRow.directionId),
    s.select(clusterMember, {
      where: eq(clusterMember.clusterId, c.id),
      fields: { productId: clusterMember.productId },
    }),
    s
      .select(supplierQuote, { where: eq(supplierQuote.clusterId, c.id) })
      .orderBy(asc(supplierQuote.createdAt)),
    s
      .select(logisticsProfile, { where: eq(logisticsProfile.platform, platform) })
      .orderBy(asc(logisticsProfile.name)),
    s.select(costingScenario, {
      where: all(eq(costingScenario.leadId, leadRow.id), eq(costingScenario.selected, true)),
    }),
  ])
  const supplierIds = [...new Set(quoteRows.map((q) => q.supplierId))]
  const [suppliers, nodes] = await Promise.all([
    supplierIds.length ? s.select(supplier, { where: inArray(supplier.id, supplierIds) }) : [],
    dir.nodeIds.length
      ? s.select(seasonalNode, { where: inArray(seasonalNode.id, dir.nodeIds) })
      : [],
  ])

  // 代表商品的类目决定成本参数；成员最近 30 天的价格主值给出竞品中位价
  const productIds = members.map((m) => m.productId)
  const repId = c.representativeProductId ?? productIds[0] ?? null
  const [rep] = repId
    ? await actor.db
        .select({ categoryId: marketplaceProduct.categoryId })
        .from(marketplaceProduct)
        .where(eq(marketplaceProduct.id, repId))
    : []
  const prices = productIds.length
    ? await readMetrics(actor.db, {
        entityType: 'product',
        entityIds: productIds,
        metrics: ['price'],
        marketplace: c.marketplace as Marketplace,
        from: addDays(today, -30),
      })
    : new Map()
  const latestPrices = productIds.flatMap((id) => {
    const point = prices.get(id)?.get('price')?.at(-1)
    return point ? [{ value: point.primary.value, currency: point.primary.currency ?? null }] : []
  })
  const median = competitorMedian(latestPrices, 'USD')
  const salePrice = opts.salePriceMinor
    ? {
        amountMinor: opts.salePriceMinor,
        currency: median?.currency ?? 'USD',
        source: 'manual' as const,
      }
    : median
      ? { amountMinor: median.amountMinor, currency: median.currency, source: 'median' as const }
      : null

  const costParams = await effectiveCostParams(actor, platform, rep?.categoryId ?? null)
  const improvementValue = leadRow.improvement ?? null
  const improvement = toImprovement(improvementValue)
  const fulfillmentFee: FulfillmentFee | null = opts.fbaFeeMinor
    ? {
        amountMinor: opts.fbaFeeMinor,
        currency: salePrice?.currency ?? 'USD',
        source: 'rate-table',
      }
    : null

  // 汇率：报价、物流公式、改款费与售价涉及的币种，取当日（或最近一日）的主值
  const currencies = new Set<string>()
  for (const q of quoteRows) currencies.add(q.currency.toUpperCase())
  for (const p of profileRows)
    for (const f of [p.headFreight, p.lastMile])
      if (f && typeof f.currency === 'string') currencies.add(f.currency.toUpperCase())
  if (improvement) currencies.add(improvement.toolingCost.currency.toUpperCase())
  if (salePrice) currencies.add(salePrice.currency.toUpperCase())
  currencies.delete('CNY')
  const observed = await Promise.all(
    [...currencies].map(async (code) => {
      const v = await latestValue(actor.db, {
        entity: { type: 'currency', marketplace: 'global', platformId: `${code}/CNY` },
        metric: 'fx_rate',
        onOrBefore: today,
      })
      return v
        ? {
            pair: `${code}/CNY`,
            currency: code,
            rate: v.value,
            observedOn: v.observedOn,
            sourceId: v.sourceId,
          }
        : null
    }),
  )
  const fx = observed.filter((x): x is NonNullable<typeof x> => x !== null)
  const fxRates = crossRates(new Map(fx.map((r) => [r.currency, r.rate])))

  const node = nearestNode(nodes, today)
  const leadTimes = DEFAULT_LEAD_TIMES[platform]
  const quotes = quoteRows.map(toCostingQuote)
  const selected = selectedRows[0] ?? null
  // 计划数量：已选组合的数量 → 报价中最小的 MOQ → 100
  const plannedQty =
    opts.plannedQty ??
    selected?.plannedQty ??
    (quotes.length ? Math.max(1, Math.min(...quotes.map(effectiveMoq))) : 100)
  const modes: FollowMode[] = opts.modes ?? [leadRow.followMode]
  const attributes = [...new Set((opts.attributes ?? []).map((a) => a.toLowerCase()))]

  return {
    s,
    leadRow,
    cluster: c,
    platform,
    today,
    quoteRows,
    profileRows,
    suppliers,
    selected,
    plannedQty,
    modes,
    attributes,
    salePrice,
    median,
    costParams,
    improvementValue,
    improvement,
    fulfillmentFee,
    fx,
    fxRates,
    node,
    leadTimes,
    input: {
      plannedQty,
      salePrice: salePrice
        ? { amountMinor: salePrice.amountMinor, currency: salePrice.currency }
        : null,
      quotes,
      profiles: profileRows.map(toCostingProfile),
      modes,
      improvement,
      costParams: { [platform]: costParams.params },
      fulfillmentFee,
      fxRates,
      productAttributes: attributes,
      schedule: node
        ? {
            saleStartDate: node.saleStartDate,
            today,
            listingPrepDays: leadTimes.listingPrepDays,
            inboundDays: leadTimes.fbaInboundDays ?? null,
            defaultProcurementDays: leadTimes.procurementDays,
          }
        : null,
    },
  }
}
type Context = Awaited<ReturnType<typeof loadContext>>

/** 选定组合时随结果保存的输入来源，档案库与队列据此追溯 */
function inputsSnapshot(ctx: Context, cell: MatrixCell) {
  const quote = ctx.quoteRows.find((q) => q.id === cell.quoteId)
  const profile = ctx.profileRows.find((p) => p.id === cell.profileId)
  const sup = ctx.suppliers.find((x) => x.id === quote?.supplierId)
  return {
    plannedQty: ctx.plannedQty,
    salePrice: ctx.salePrice,
    competitorMedian: ctx.median,
    fxRates: ctx.fx,
    costParams: ctx.costParams.params,
    costParamSources: ctx.costParams.sources,
    fulfillmentFee: ctx.fulfillmentFee,
    node: ctx.node,
    leadTimes: ctx.leadTimes,
    attributes: ctx.attributes,
    improvement: cell.mode === 'improved' ? ctx.improvement : null,
    quote: quote
      ? {
          supplierName: sup?.name ?? null,
          tiers: quote.tiers,
          currency: quote.currency,
          moq: quote.moq,
          weightG: quote.weightG,
          dimensions: quote.dimensions ?? null,
          confidence: quote.confidence,
          quotedOn: quote.quotedOn,
          source: quote.source,
        }
      : null,
    profile: profile
      ? { name: profile.name, type: profile.type, transitDays: profile.transitDays }
      : null,
  }
}

function cellView(cell: MatrixCell, bestKey: string | null) {
  return { ...cell, key: cellKey(cell), best: cellKey(cell) === bestKey, issues: cellIssues(cell) }
}
export type MatrixCellView = ReturnType<typeof cellView>

/** 商品簇详情“核算”标签的全部数据；没有线索时只返回报价 */
export async function costingView(
  actor: Actor & { canWrite: boolean },
  leadId: string,
  options: MatrixOptions = {},
  now = new Date(),
) {
  const ctx = await loadContext(actor, leadId, options, now)
  const matrix = buildCostingMatrix(ctx.input)
  const bestKey = matrix.best ? cellKey(matrix.best) : null
  const supplierName = new Map(ctx.suppliers.map((x) => [x.id, x.name]))
  const decided = await isClusterDecided(ctx.s, ctx.leadRow)
  // 已决定的簇：新一天的线索只继承状态，选定组合留在做决定的线索上，从 decision 取回展示
  const sel = ctx.selected ?? (decided ? await decidedScenario(ctx.s, ctx.leadRow.clusterId) : null)
  return {
    canWrite: actor.canWrite,
    editable: !decided,
    today: ctx.today,
    lead: {
      id: ctx.leadRow.id,
      status: ctx.leadRow.status,
      followMode: ctx.leadRow.followMode,
      improvement: ctx.improvementValue,
      improvementReady: ctx.improvement !== null,
    },
    platform: ctx.platform,
    plannedQty: ctx.plannedQty,
    modes: ctx.modes,
    attributes: ctx.attributes,
    salePrice: ctx.salePrice,
    competitorMedian: ctx.median,
    fx: ctx.fx,
    node: ctx.node,
    leadTimes: ctx.leadTimes,
    fulfillmentFee: ctx.fulfillmentFee,
    costParams: { values: ctx.costParams.params, sources: ctx.costParams.sources },
    quotes: ctx.quoteRows.map((q) => ({
      ...quoteView(q),
      supplierName: supplierName.get(q.supplierId) ?? '—',
      moqEffective: effectiveMoq(toCostingQuote(q)),
    })),
    profiles: ctx.profileRows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      transitDays: p.transitDays,
      bannedAttributes: p.bannedAttributes,
    })),
    cells: matrix.cells.map((cell) => cellView(cell, bestKey)),
    bestKey,
    selected: sel
      ? {
          id: sel.id,
          key: cellKey(sel),
          quoteId: sel.quoteId,
          profileId: sel.profileId,
          mode: sel.mode,
          plannedQty: sel.plannedQty,
          salePriceMinor: sel.salePriceMinor,
          currency: sel.currency,
          result: sel.result as JsonValue,
          computedAt: sel.computedAt.toISOString(),
        }
      : null,
  }
}
export type CostingViewData = Awaited<ReturnType<typeof costingView>>

/** 簇最近一次决定所用的组合 */
async function decidedScenario(s: Context['s'], clusterId: string) {
  const [row] = await s
    .select(decision, {
      where: all(
        sql`${decision.leadId} in (select l.id from lead l where l.cluster_id = ${clusterId})`,
        isNotNull(decision.scenarioId),
      ),
      fields: { scenarioId: decision.scenarioId },
    })
    .orderBy(desc(decision.decidedAt))
    .limit(1)
  if (!row?.scenarioId) return null
  const [scenario] = await s.select(costingScenario, {
    where: eq(costingScenario.id, row.scenarioId),
  })
  return scenario ?? null
}

/**
 * 选定组合：服务端按同样输入重算该格（不信任客户端结果），只有可用格可选；
 * 写 costing_scenario（同一线索只保留一个 selected）、线索 → pending、follow_mode 写回，并记 lead_event。
 */
export async function selectScenario(
  actor: DecisionActor,
  leadId: string,
  pick: ScenarioPick,
  options: MatrixOptions = {},
  now = new Date(),
) {
  assertWorkbenchWriter(actor)
  const current = await assertCostingEditable(actor, leadId)
  const ctx = await loadContext(actor, current.id, { ...options, modes: [pick.mode] }, now)
  const target = ctx.leadRow.id
  const quote = ctx.input.quotes.find((q) => q.id === pick.quoteId)
  const profile = ctx.input.profiles.find((p) => p.id === pick.profileId)
  if (!quote || !profile) throw notFound()
  const [cell] = buildCostingMatrix({ ...ctx.input, quotes: [quote], profiles: [profile] }).cells
  if (!cell?.available || !cell.result)
    throw new AppError(
      'SCENARIO_UNAVAILABLE',
      `该组合不可用：${cell ? cellIssues(cell).join('；') : '无结果'}`,
      { status: 409 },
    )
  const result = { ...cell, inputs: inputsSnapshot(ctx, cell) }

  return scoped(actor.db, actor.workspaceId).transaction(async (tx) => {
    // 锁住线索行：与 decideLead 互斥，避免决定后仍写入核算
    const [row] = await tx.select(lead, { where: eq(lead.id, target) }).for('update')
    if (!row) throw notFound()
    if (await isClusterDecided(tx, row))
      throw new AppError('LEAD_DECIDED', '线索已作出决定，核算已锁定；如需重新核算请新建线索', {
        status: 409,
      })
    const values = {
      plannedQty: ctx.plannedQty,
      salePriceMinor: cell.result?.salePriceMinor ?? null,
      currency: cell.result?.currency ?? null,
      improvement:
        pick.mode === 'improved' ? (ctx.improvement as Record<string, unknown> | null) : null,
      result: result as unknown as Record<string, unknown>,
      selected: true,
      computedAt: now,
    }
    const [saved] = await tx
      .insert(costingScenario, { leadId: target, ...pick, ...values })
      .onConflictDoUpdate({
        target: [
          costingScenario.leadId,
          costingScenario.quoteId,
          costingScenario.profileId,
          costingScenario.mode,
        ],
        set: values,
      })
      .returning({ id: costingScenario.id })
    if (!saved) throw new Error('save scenario failed')
    await tx.update(
      costingScenario,
      { selected: false },
      all(eq(costingScenario.leadId, target), ne(costingScenario.id, saved.id)),
    )
    await tx.updateById(lead, target, { status: 'pending', followMode: pick.mode })
    await tx.insert(leadEvent, {
      leadId: target,
      clusterId: row.clusterId,
      kind: 'status',
      payload: {
        from: row.status,
        to: 'pending',
        scenarioId: saved.id,
        grossMargin: cell.result?.grossMargin ?? null,
        deadline: cell.deadline,
      },
      actorUserId: actor.userId,
    })
    return { scenarioId: saved.id, leadId: target, status: 'pending' as const }
  })
}

/** 切换跟卖方式（矩阵对比后写回线索） */
export async function setFollowMode(actor: DecisionActor, leadId: string, mode: FollowMode) {
  assertWorkbenchWriter(actor)
  const row = await assertCostingEditable(actor, leadId)
  const s = scoped(actor.db, actor.workspaceId)
  return s.transaction(async (tx) => {
    await tx.updateById(lead, row.id, { followMode: mode })
    await enterCosting(tx, row, actor.userId, 'follow-mode')
    return { followMode: mode }
  })
}

export async function saveImprovement(actor: DecisionActor, leadId: string, raw: ImprovementInput) {
  assertWorkbenchWriter(actor)
  const input = improvementInput.parse(raw)
  const row = await assertCostingEditable(actor, leadId)
  const value = {
    unitSurchargeRate: input.unitSurchargeRate ?? null,
    toolingCost: input.toolingCost ?? null,
    sampleDays: input.sampleDays ?? null,
    note: input.note || null,
  }
  const s = scoped(actor.db, actor.workspaceId)
  return s.transaction(async (tx) => {
    await tx.updateById(lead, row.id, { improvement: value })
    await enterCosting(tx, row, actor.userId, 'improvement')
    return value
  })
}
