import {
  clusterSignal,
  costingScenario,
  direction,
  lead,
  logisticsProfile,
  riskFinding,
  scoped,
  seasonalNode,
  supplier,
  supplierQuote,
} from '@product-res/db'
import { addDays } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { and, eq, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSelectionForWorkspace } from '../src/index.ts'
import { cleanup, createWorkspace, insertProduct, observe, testDb, url } from './helpers.ts'

// add-costing-decisions tasks 3.3：流水线接入核算结果（利润空间、供应与时效、成本确定性）与线索的跟卖方式。
const db = testDb()
const asOf = '2032-05-01'
const nextDay = addDays(asOf, 1)
const now = new Date(`${asOf}T00:00:00+08:00`)
const tag = newId().slice(-10)
const category = `costing-${tag}`
const productIds: string[] = []
let workspaceId = ''
let clusterId = ''
let scenarioId = ''

/** 与 apps/web 核算矩阵 selectScenario 写入的形状一致：MatrixCell + inputs 快照 */
const scenarioResult = (grossMargin: number) => ({
  quoteId: 'q',
  profileId: 'p',
  mode: 'same-source',
  available: true,
  reasons: [],
  missing: [],
  bannedAttributes: [],
  result: {
    status: 'ok',
    currency: 'USD',
    salePriceMinor: 2000,
    landedCostMinor: 900,
    netProfitMinor: Math.round(2000 * grossMargin),
    grossMargin,
    breakEvenMinor: 1300,
    dimensionsMissing: false,
    fulfillmentSource: 'profile',
  },
  deadline: '2032-06-01',
  certainty: 0.8,
  inputs: {
    quote: { supplierName: '义乌工厂', confidence: 'public' },
    profile: { name: 'eBay 直发' },
    node: { id: 'n', name: '返校季', saleStartDate: '2032-07-15' },
  },
})

const signalsOn = (day: string) =>
  scoped(db, workspaceId).select(clusterSignal, {
    where: and(eq(clusterSignal.clusterId, clusterId), eq(clusterSignal.observedOn, day)) as SQL,
  })
const leadOn = async (day: string) => {
  const [row] = await scoped(db, workspaceId).select(lead, {
    where: and(eq(lead.clusterId, clusterId), eq(lead.leadOn, day)) as SQL,
  })
  return row
}
const certaintyItem = (row: Awaited<ReturnType<typeof leadOn>>) =>
  (
    row?.confidenceDetail as { items: { id: string; value: number | null }[] } | undefined
  )?.items.find((i) => i.id === 'cost-certainty')

describe.skipIf(!url)('流水线接入核算结果', () => {
  beforeAll(async () => {
    workspaceId = await createWorkspace(db, 'Costing')
    const s = scoped(db, workspaceId)
    const [node] = await s
      .insert(seasonalNode, {
        name: `返校季-${tag}`,
        startMonth: 7,
        startDay: 15,
        salesDays: 45,
        keywords: [],
      })
      .returning()
    await s.insert(direction, {
      name: '厨房',
      marketplaces: ['ebay-us'],
      categoryIds: [category],
      nodeIds: [node?.id as string],
    })
    const id = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `pot-${tag}`,
      title: 'Kitchenpro Stainless Pot Rack',
      categoryId: category,
      sellerId: 'seller-x',
      brand: 'Kitchenpro',
      firstSeenOn: addDays(asOf, -20),
    })
    productIds.push(id)
    await observe(db, [
      { entityId: id, metric: 'sold_quantity_total', observedOn: addDays(asOf, -30), value: 100 },
      { entityId: id, metric: 'sold_quantity_total', observedOn: asOf, value: 220 },
      { entityId: id, metric: 'price', observedOn: asOf, value: 20 },
      { entityId: id, metric: 'price', observedOn: nextDay, value: 20 },
    ])
  })

  afterAll(async () => {
    if (!url) return
    await cleanup(db, workspaceId, productIds)
  })

  it('未核算时利润为空、成本确定性为空；风险按同货源（品牌高）', async () => {
    await runSelectionForWorkspace(db, workspaceId, { now, asOf })
    const s = scoped(db, workspaceId)
    const [c] = await s.select(clusterSignal, { where: eq(clusterSignal.observedOn, asOf) })
    clusterId = c?.clusterId as string
    const signals = await signalsOn(asOf)
    expect(signals.find((x) => x.dimension === 'profit')?.score).toBeNull()
    const first = await leadOn(asOf)
    expect(certaintyItem(first)).toMatchObject({ value: null })
    // 默认提前期：7/15 − 48 天
    expect(first?.latestDecisionOn).toBe('2032-05-28')
    const findings = await s.select(riskFinding, { where: eq(riskFinding.clusterId, clusterId) })
    expect(findings.find((f) => f.kind === 'brand')?.level).toBe('high')

    // 团队在核算矩阵选定组合（与 selectScenario 一样写 costing_scenario、线索 → pending）
    const [sup] = await s.insert(supplier, { name: '义乌工厂' }).returning()
    const [quote] = await s
      .insert(supplierQuote, {
        supplierId: sup?.id as string,
        clusterId,
        tiers: [{ minQty: 1, unitPriceMinor: 3000 }],
        currency: 'CNY',
        confidence: 'public',
        quotedOn: asOf,
      })
      .returning()
    const [profile] = await s
      .insert(logisticsProfile, {
        name: `eBay 直发-${tag}`,
        platform: 'ebay',
        type: 'ebay-direct',
        transitDays: 12,
      })
      .returning()
    const [scenario] = await s
      .insert(costingScenario, {
        leadId: first?.id as string,
        quoteId: quote?.id as string,
        profileId: profile?.id as string,
        mode: 'same-source',
        plannedQty: 100,
        salePriceMinor: 2000,
        currency: 'USD',
        result: scenarioResult(0.31),
        selected: true,
      })
      .returning()
    scenarioId = scenario?.id as string
    await s.update(lead, { status: 'pending' }, eq(lead.id, first?.id as string))
  })

  it('有核算时利润空间与供应时效采用核算结果，来源标注 costing_scenario；置信度含成本确定性', async () => {
    // 次日的新线索没有核算行：维度仍取最近一条有核算组合的线索
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: nextDay })
    const signals = await signalsOn(nextDay)
    const profitSignal = signals.find((x) => x.dimension === 'profit')
    expect(profitSignal?.score).not.toBeNull()
    const profitInputs = profitSignal?.inputs as {
      reason: string
      refs: { sourceId: string; entityId?: string }[]
      detail: Record<string, unknown>
    }
    expect(profitInputs.detail).toMatchObject({
      bestMargin: 0.31,
      source: 'costing_scenario',
      scenarioId,
    })
    expect(profitInputs.refs).toContainEqual(
      expect.objectContaining({ sourceId: 'costing_scenario', entityId: scenarioId }),
    )
    expect(profitInputs.reason).toContain('义乌工厂')

    const timing = signals.find((x) => x.dimension === 'supply-timing')
    expect(timing?.score).not.toBeNull()
    expect(
      (timing?.inputs as { detail: Record<string, unknown> } | undefined)?.detail,
    ).toMatchObject({
      deadline: '2032-06-01',
      leadDays: 44,
      slackDays: 30,
      usedDefaultLeadTime: false,
      source: 'costing_scenario',
    })

    const row = await leadOn(nextDay)
    expect(row?.latestDecisionOn).toBe('2032-06-01')
    expect(row?.status).toBe('pending')
    expect(certaintyItem(row)).toMatchObject({ value: 0.8 })
    expect(row?.gates).toMatchObject({ passed: true })
  })

  it('核算毛利率低于底线时毛利门槛不通过', async () => {
    const s = scoped(db, workspaceId)
    await s.update(
      costingScenario,
      { result: scenarioResult(0.08) },
      eq(costingScenario.id, scenarioId),
    )
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: nextDay })
    const row = await leadOn(nextDay)
    expect(row?.vetoed).toBe(true)
    expect(row?.gates).toMatchObject({ passed: false, failures: [{ gate: 'margin' }] })
    await s.update(
      costingScenario,
      { result: scenarioResult(0.31) },
      eq(costingScenario.id, scenarioId),
    )
  })

  it('follow_mode=improved 时品牌风险降为中，合规分随之提高；新一天的线索沿用跟卖方式', async () => {
    const s = scoped(db, workspaceId)
    const before = (await signalsOn(nextDay)).find((x) => x.dimension === 'compliance')?.score
    const today = await leadOn(nextDay)
    await s.update(lead, { followMode: 'improved' }, eq(lead.id, today?.id as string))
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: nextDay })
    const findings = await s.select(riskFinding, { where: eq(riskFinding.clusterId, clusterId) })
    expect(findings.find((f) => f.kind === 'brand')?.level).toBe('medium')
    const after = (await signalsOn(nextDay)).find((x) => x.dimension === 'compliance')?.score
    expect(after).toBeGreaterThan(before as number)

    const third = addDays(nextDay, 1)
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: third })
    expect((await leadOn(third))?.followMode).toBe('improved')
    const again = await s.select(riskFinding, { where: eq(riskFinding.clusterId, clusterId) })
    expect(again.find((f) => f.kind === 'brand')?.level).toBe('medium')
  })
})
