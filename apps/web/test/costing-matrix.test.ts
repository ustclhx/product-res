import { env } from 'cloudflare:workers'
import {
  cluster,
  clusterMember,
  costingScenario,
  costParam,
  createDb,
  dataImport,
  decision,
  direction,
  lead,
  leadEvent,
  logisticsProfile,
  member,
  organization,
  rawPayload,
  scoped,
  seasonalNode,
  supplier,
  supplierQuote,
  user,
} from '@product-res/db'
import { setManualRate, upsertEntities, upsertObservations } from '@product-res/marketdata'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type DecisionActor,
  decideLead,
  workbenchHome,
} from '../src/features/costing/decisions.server.ts'
import {
  costingView,
  saveImprovement,
  selectScenario,
  setFollowMode,
} from '../src/features/costing/matrix.server.ts'
import {
  commitQuoteImport,
  previewQuoteImport,
  revertQuoteImport,
} from '../src/features/costing/quote-import.server.ts'
import {
  clusterQuotes,
  deleteQuote,
  saveQuote,
  saveSupplier,
} from '../src/features/costing/quotes.server.ts'
import { summarizeScenario } from '../src/features/costing/scenario.ts'
import { saveCostParam, saveLogisticsProfile } from '../src/features/costing/settings.server.ts'
import { importHistory } from '../src/features/data-center/service.server.ts'

// add-costing-decisions 2.3 / 3.1：供应商报价录入与导入撤销、核算矩阵（最优选择、不可用原因）、选定 → pending、
// 已决定线索拒绝修改。售价币种用 ISO 测试币种 XTS（XTS/CNY 汇率只属于本测试），避免与共享的真实汇率互相影响。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []
const users: string[] = []
const imports: string[] = []
const NOW = new Date('2026-10-19T04:00:00Z') // 新加坡 10-19 12:00

async function space(): Promise<DecisionActor> {
  const id = newId()
  const userId = newId()
  spaces.push(id)
  users.push(userId)
  await db()
    .insert(organization)
    .values({ id, name: 'Matrix test', slug: `matrix-${id.slice(-12)}`, isPersonal: false })
  await db()
    .insert(user)
    .values({ id: userId, name: 'Coster', email: `${userId}@matrix.test` })
  await scoped(db(), id).insert(member, { id: newId(), userId, role: 'owner' })
  return { db: db(), workspaceId: id, workspaceReadOnly: false, member: { role: 'owner' }, userId }
}
const asMember = (a: DecisionActor): DecisionActor => ({ ...a, member: { role: 'member' } })
const view = (a: DecisionActor, leadId: string, options = {}) =>
  costingView({ ...a, canWrite: true }, leadId, options, NOW)

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(decision, undefined)
    await s.delete(leadEvent, undefined)
    await s.delete(costingScenario, undefined)
    await s.delete(supplierQuote, undefined)
    await s.delete(supplier, undefined)
    await s.delete(logisticsProfile, undefined)
    await s.delete(costParam, undefined)
    await s.delete(clusterMember, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(member, undefined)
  }
  if (imports.length) {
    await db().delete(rawPayload).where(inArray(rawPayload.importId, imports))
    await db().delete(dataImport).where(inArray(dataImport.id, imports))
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
  await db().delete(user).where(inArray(user.id, users))
})

const cny = (firstPriceMinor: number) => ({
  kind: 'first-additional' as const,
  currency: 'CNY',
  firstWeightG: 500,
  firstPriceMinor,
  stepWeightG: 500,
  stepPriceMinor: 1500,
  volumetricDivisor: 6000,
})

/** 方向（关联 12/1 节点）、3 个成员的 eBay 商品簇（XTS 价格 19.99 / 21.99 / 24.99）、线索、两个物流方案、成本参数 */
async function seed(actor: DecisionActor) {
  const s = scoped(actor.db, actor.workspaceId)
  const [node] = await s
    .insert(seasonalNode, {
      name: '圣诞',
      startMonth: 12,
      startDay: 1,
      salesDays: 25,
      keywords: [],
    })
    .returning()
  const [dir] = await s
    .insert(direction, {
      name: '厨房收纳',
      marketplaces: ['ebay-us'],
      nodeIds: [node?.id as string],
    })
    .returning()
  const key = newId().slice(-10)
  const products = ['A', 'B', 'C'].map((x) => ({
    type: 'product' as const,
    marketplace: 'ebay-us' as const,
    platformId: `MX-${key}-${x}`,
  }))
  const ids = await upsertEntities(
    actor.db,
    products.map((p) => ({ key: p, facts: { title: `Rack ${p.platformId}` } })),
  )
  await upsertObservations(
    actor.db,
    products.map((entity, i) => ({
      entity,
      metric: 'price',
      observedOn: '2026-10-18',
      value: [19.99, 21.99, 24.99][i] as number,
      currency: 'XTS',
      method: 'official' as const,
    })),
    ids,
    { sourceId: 'ebay-browse', fetchedAt: NOW },
  )
  await setManualRate(actor.db, { pair: 'XTS/CNY', observedOn: '2026-10-17', value: 7, now: NOW })

  const [c] = await s
    .insert(cluster, { directionId: dir?.id as string, marketplace: 'ebay-us', name: '磁吸调料架' })
    .returning()
  const clusterId = c?.id as string
  for (const p of products)
    await s.insert(clusterMember, {
      clusterId,
      productId: ids.get(`product:ebay-us:${p.platformId}`) as string,
      method: 'platform-id',
      confidence: 0.9,
    })
  const [l] = await s
    .insert(lead, {
      clusterId,
      directionId: dir?.id as string,
      leadOn: '2026-10-18',
      score: 76,
      grade: 'recommend',
      confidence: 0.7,
      settingVersion: 1,
      status: 'new',
    })
    .returning()
  const direct = await saveLogisticsProfile(actor, undefined, {
    name: '云途直发',
    platform: 'ebay',
    type: 'ebay-direct',
    transitDays: 12,
    lastMile: cny(3000),
    bannedAttributes: ['battery'],
  })
  const overseas = await saveLogisticsProfile(actor, undefined, {
    name: '美西海外仓',
    platform: 'ebay',
    type: 'ebay-overseas',
    transitDays: 50,
    headFreight: { kind: 'volume', currency: 'CNY', pricePerCbmMinor: 120_000 },
    lastMile: cny(2000),
    bannedAttributes: [],
  })
  await saveCostParam(actor, undefined, {
    platform: 'ebay',
    commissionRate: 0.13,
    fixedFeeMinor: 30,
    adRate: 0.05,
    returnRate: 0.03,
    storageMonthlyMinor: 20,
    storageMonths: 2,
  })
  const [sup] = await s.insert(supplier, { name: '义乌工厂', platform: '1688' }).returning()
  return {
    clusterId,
    leadId: l?.id as string,
    supplierId: sup?.id as string,
    platformId: products[0]?.platformId as string,
    direct,
    overseas,
  }
}

const quote = (supplierId: string, over: Record<string, unknown> = {}) => ({
  supplierId,
  tiers: [
    { minQty: 100, unitPriceMinor: 1200 },
    { minQty: 500, unitPriceMinor: 1000 },
  ],
  currency: 'cny',
  weightG: 400,
  dimensions: { lengthCm: 20, widthCm: 15, heightCm: 10 },
  confidence: 'confirmed' as const,
  quotedOn: '2026-10-15',
  procurementDays: 10,
  ...over,
})

const csv = (rows: string[][]) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(rows.map((r) => r.join(',')).join('\n'))))

describe('供应商与报价', () => {
  it('录入报价后线索 new → costing 并记事件；成员只读；有报价的供应商不能删', async () => {
    const owner = await space()
    const seeded = await seed(owner)
    await expect(
      saveQuote(asMember(owner), seeded.clusterId, undefined, quote(seeded.supplierId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      saveQuote(owner, seeded.clusterId, undefined, {
        ...quote(seeded.supplierId),
        tiers: [
          { minQty: 100, unitPriceMinor: 1 },
          { minQty: 100, unitPriceMinor: 2 },
        ],
      }),
    ).rejects.toThrow()
    const saved = await saveQuote(owner, seeded.clusterId, undefined, quote(seeded.supplierId))
    expect(saved).toMatchObject({ currency: 'CNY', source: 'manual', weightG: 400 })
    const s = scoped(owner.db, owner.workspaceId)
    expect((await s.findById(lead, seeded.leadId)).status).toBe('costing')
    expect(await s.select(leadEvent, { where: eq(leadEvent.leadId, seeded.leadId) })).toEqual([
      expect.objectContaining({
        kind: 'status',
        payload: { from: 'new', to: 'costing', reason: 'quote' },
      }),
    ])
    const sup = await saveSupplier(owner, seeded.supplierId, {
      name: '义乌工厂（改）',
      url: 'https://detail.1688.com/offer/1.html',
      platform: '1688',
    })
    expect(sup.name).toBe('义乌工厂（改）')
    const { deleteSupplier } = await import('../src/features/costing/quotes.server.ts')
    await expect(deleteSupplier(owner, seeded.supplierId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await deleteQuote(owner, seeded.clusterId, saved.id)
    expect((await clusterQuotes(owner, seeded.clusterId)).quotes).toEqual([])
  })

  it('报价导入：按簇 ID / 平台商品 ID 关联，错误行需跳过；撤销只删导入的报价，手工与导入后改过的保留', async () => {
    const owner = await space()
    const other = await space()
    const seeded = await seed(owner)
    const manual = await saveQuote(owner, seeded.clusterId, undefined, quote(seeded.supplierId))
    const file = {
      fileName: 'quotes.csv',
      contentBase64: csv([
        [
          '簇 ID',
          '平台商品 ID',
          '供应商',
          '阶梯价',
          '币种',
          'MOQ',
          '重量(g)',
          '尺寸(cm)',
          '可信度',
          '报价日期',
        ],
        [
          seeded.clusterId,
          '',
          '导入工厂甲',
          '100:12; 500:10',
          'CNY',
          '',
          '380',
          '30x20x10',
          '公开价',
          '2026-10-18',
        ],
        ['', seeded.platformId, '导入工厂乙', '200:11', '', '200', '', '', '已确认', ''],
        ['', 'NOT-IN-CLUSTER', '导入工厂丙', '100:9', 'CNY', '', '', '', '', ''],
      ]),
      marketplace: 'ebay-us',
      currency: 'CNY',
    }
    const preview = await previewQuoteImport(owner, file)
    expect(preview).toMatchObject({ rowCount: 3, quoteCount: 2, clusterCount: 1, errorRows: [3] })
    expect(preview.rows[0]).toMatchObject({
      supplier: '导入工厂甲',
      tiers: [
        { minQty: 100, unitPriceMinor: 1200 },
        { minQty: 500, unitPriceMinor: 1000 },
      ],
      dimensions: { lengthCm: 30, widthCm: 20, heightCm: 10 },
    })
    await expect(
      commitQuoteImport(owner, { ...file, skipErrorRows: false, confirmDuplicate: false }),
    ).rejects.toMatchObject({ code: 'IMPORT_HAS_ERRORS' })
    const done = await commitQuoteImport(
      owner,
      { ...file, skipErrorRows: true, confirmDuplicate: false },
      NOW,
    )
    imports.push(done.importId)
    expect(done).toMatchObject({ imported: 2, skippedRows: 1 })
    await expect(
      commitQuoteImport(owner, { ...file, skipErrorRows: true, confirmDuplicate: false }),
    ).rejects.toMatchObject({ code: 'IMPORT_DUPLICATE' })

    let quotes = (await clusterQuotes(owner, seeded.clusterId)).quotes
    expect(quotes).toHaveLength(3)
    const imported = quotes.filter((q) => q.source === 'import')
    expect(imported.map((q) => q.importId)).toEqual([done.importId, done.importId])
    const second = imported.find((q) => q.moq === 200)
    expect(second).toMatchObject({ currency: 'CNY', confidence: 'confirmed', weightG: null })
    // 导入的报价被手工修改后改记为手工录入
    const edited = await saveQuote(owner, seeded.clusterId, second?.id, {
      ...quote(seeded.supplierId),
      weightG: 410,
    })
    expect(edited.source).toBe('manual')

    // 其他空间看不到也不能撤销这个批次
    expect((await importHistory(owner.db, other.workspaceId)).map((h) => h.id)).not.toContain(
      done.importId,
    )
    expect((await importHistory(owner.db, owner.workspaceId)).map((h) => h.id)).toContain(
      done.importId,
    )
    await expect(revertQuoteImport(other, done.importId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    expect(await revertQuoteImport(owner, done.importId, NOW)).toBe(1)
    quotes = (await clusterQuotes(owner, seeded.clusterId)).quotes
    expect(quotes.map((q) => q.id).sort()).toEqual([manual.id, edited.id].sort())
    expect(await revertQuoteImport(owner, done.importId, NOW)).toBe(0)
    const [batch] = await owner.db.select().from(dataImport).where(eq(dataImport.id, done.importId))
    expect(batch?.revertedAt).not.toBeNull()
  })
})

describe('核算矩阵', () => {
  let owner: DecisionActor
  let seeded: Awaited<ReturnType<typeof seed>>
  let ids: { good: string; bulk: string; noWeight: string }
  beforeAll(async () => {
    owner = await space()
    seeded = await seed(owner)
    const good = await saveQuote(owner, seeded.clusterId, undefined, quote(seeded.supplierId))
    // MOQ 500 > 计划数量 300
    const bulk = await saveQuote(owner, seeded.clusterId, undefined, {
      ...quote(seeded.supplierId),
      tiers: [{ minQty: 500, unitPriceMinor: 900 }],
    })
    const noWeight = await saveQuote(owner, seeded.clusterId, undefined, {
      ...quote(seeded.supplierId),
      tiers: [{ minQty: 50, unitPriceMinor: 1100 }],
      weightG: null,
      dimensions: null,
      confidence: 'public',
    })
    ids = { good: good.id, bulk: bulk.id, noWeight: noWeight.id }
  })

  it('售价默认竞品中位价、汇率取 fx_rate 主值；各格不可用原因与最优组合', async () => {
    const v = await view(owner, seeded.leadId, { plannedQty: 300 })
    expect(v.salePrice).toMatchObject({ amountMinor: 2199, currency: 'XTS', source: 'median' })
    expect(v.competitorMedian?.sampleSize).toBe(3)
    expect(v.fx).toEqual([
      expect.objectContaining({
        pair: 'XTS/CNY',
        rate: 7,
        observedOn: '2026-10-17',
        sourceId: 'manual',
      }),
    ])
    expect(v.node).toMatchObject({ name: '圣诞', saleStartDate: '2026-12-01' })
    expect(v.cells).toHaveLength(6)
    const at = (q: string, p: string) => v.cells.find((c) => c.quoteId === q && c.profileId === p)

    const best = at(ids.good, seeded.direct.id)
    // 采购 ¥12 ÷ 7 ≈ 171、直发首重（体积重 0.5 kg）¥30 ÷ 7 ≈ 429 → 落地 600
    expect(best).toMatchObject({ available: true, best: true, deadline: '2026-11-06' })
    expect(best?.result?.landedCostMinor).toBe(600)
    expect(v.bestKey).toBe(best?.key)
    // 海外仓头程 50 天：最晚决定日 9/29 早于今天
    expect(at(ids.good, seeded.overseas.id)).toMatchObject({
      available: false,
      reasons: ['too-late'],
      issues: ['来不及'],
      deadline: '2026-09-29',
    })
    expect(at(ids.good, seeded.overseas.id)?.result).not.toBeNull()
    expect(at(ids.bulk, seeded.direct.id)?.issues).toEqual(['低于 MOQ'])
    expect(at(ids.noWeight, seeded.direct.id)).toMatchObject({ available: false, result: null })
    expect(at(ids.noWeight, seeded.direct.id)?.issues).toEqual(['缺少：重量'])

    // 禁运属性与改售价：带电商品直发不可用，最优随之消失（海外仓来不及）
    const banned = await view(owner, seeded.leadId, { plannedQty: 300, attributes: ['Battery'] })
    expect(banned.cells.find((c) => c.key === best?.key)?.issues).toEqual(['禁运（battery）'])
    expect(banned.bestKey).toBeNull()
    const priced = await view(owner, seeded.leadId, { plannedQty: 300, salePriceMinor: 2999 })
    expect(priced.salePrice).toMatchObject({ amountMinor: 2999, source: 'manual' })
  })

  it('跟卖方式：切换写回线索；微改良缺参数时报告缺少，补齐后可对比', async () => {
    await setFollowMode(owner, seeded.leadId, 'improved')
    const s = scoped(owner.db, owner.workspaceId)
    expect((await s.findById(lead, seeded.leadId)).followMode).toBe('improved')
    let v = await view(owner, seeded.leadId, { plannedQty: 300 })
    expect(v.modes).toEqual(['improved'])
    expect(
      v.cells.find((c) => c.quoteId === ids.good && c.profileId === seeded.direct.id)?.issues,
    ).toEqual(['缺少：微改良参数、打样天数'])
    await saveImprovement(owner, seeded.leadId, {
      unitSurchargeRate: 0.1,
      toolingCost: { amountMinor: 300_000, currency: 'cny' },
      sampleDays: 7,
      note: '加防滑垫',
    })
    v = await view(owner, seeded.leadId, { plannedQty: 300, modes: ['same-source', 'improved'] })
    expect(v.cells).toHaveLength(12)
    const improved = v.cells.find(
      (c) => c.quoteId === ids.good && c.profileId === seeded.direct.id && c.mode === 'improved',
    )
    // 打样 7 天让最晚决定日提前；改款费 ¥3000 ÷ 300 件分摊进采购
    expect(improved).toMatchObject({ available: true, deadline: '2026-10-30' })
    expect(improved?.result?.costs.modificationMinor).toBe(143)
    await setFollowMode(owner, seeded.leadId, 'same-source')
  })

  it('选定组合：服务端重算并写 costing_scenario、线索 → pending 进入待决定队列；不可用组合拒绝', async () => {
    await expect(
      selectScenario(
        owner,
        seeded.leadId,
        {
          quoteId: ids.good,
          profileId: seeded.overseas.id,
          mode: 'same-source',
        },
        { plannedQty: 300 },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_UNAVAILABLE' })
    await expect(
      selectScenario(
        asMember(owner),
        seeded.leadId,
        {
          quoteId: ids.good,
          profileId: seeded.direct.id,
          mode: 'same-source',
        },
        { plannedQty: 300 },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const pick = { quoteId: ids.good, profileId: seeded.direct.id, mode: 'same-source' as const }
    const first = await selectScenario(owner, seeded.leadId, pick, { plannedQty: 300 }, NOW)
    expect(first.status).toBe('pending')
    // 改售价后重选同一组合：更新同一行，仍只有一个选定
    const again = await selectScenario(
      owner,
      seeded.leadId,
      pick,
      { plannedQty: 300, salePriceMinor: 2499 },
      NOW,
    )
    expect(again.scenarioId).toBe(first.scenarioId)
    const s = scoped(owner.db, owner.workspaceId)
    const rows = await s.select(costingScenario, {
      where: eq(costingScenario.leadId, seeded.leadId),
    })
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      selected: true,
      plannedQty: 300,
      salePriceMinor: 2499,
      currency: 'XTS',
    })
    expect(row?.result).toMatchObject({
      quoteId: ids.good,
      available: true,
      deadline: '2026-11-06',
      inputs: { plannedQty: 300, salePrice: { source: 'manual' }, node: { name: '圣诞' } },
    })
    expect(summarizeScenario(row?.result)).toMatchObject({
      currency: 'XTS',
      salePriceMinor: 2499,
      landedCostMinor: 600,
      deadline: '2026-11-06',
    })
    expect((await s.findById(lead, seeded.leadId)).status).toBe('pending')
    const events = await s.select(leadEvent, { where: eq(leadEvent.leadId, seeded.leadId) })
    expect(events.map((e) => [e.payload.from, e.payload.to])).toEqual(
      expect.arrayContaining([
        ['new', 'costing'],
        ['costing', 'pending'],
        ['pending', 'pending'],
      ]),
    )
    const home = await workbenchHome(owner, NOW)
    expect(home.queue).toEqual([
      expect.objectContaining({
        leadId: seeded.leadId,
        deadline: '2026-11-06',
        scenario: expect.objectContaining({ landedCostMinor: 600 }),
      }),
    ])
    const v = await view(owner, seeded.leadId)
    expect(v.selected?.key).toBe(`${ids.good}:${seeded.direct.id}:same-source`)
    expect(v.plannedQty).toBe(300)
  })

  it('已决定的线索拒绝修改核算：选定、切换方式、微改良、报价与报价导入', async () => {
    await decideLead(owner, seeded.leadId, {
      kind: 'follow',
      firstBatchQty: 300,
      targetPriceMinor: 2499,
      currency: 'XTS',
      plannedListingOn: '2026-11-20',
    })
    const pick = { quoteId: ids.good, profileId: seeded.direct.id, mode: 'same-source' as const }
    await expect(selectScenario(owner, seeded.leadId, pick, {}, NOW)).rejects.toMatchObject({
      code: 'LEAD_DECIDED',
      status: 409,
    })
    await expect(setFollowMode(owner, seeded.leadId, 'improved')).rejects.toMatchObject({
      code: 'LEAD_DECIDED',
    })
    await expect(
      saveImprovement(owner, seeded.leadId, { unitSurchargeRate: 0.2 }),
    ).rejects.toMatchObject({
      code: 'LEAD_DECIDED',
    })
    await expect(
      saveQuote(owner, seeded.clusterId, undefined, quote(seeded.supplierId)),
    ).rejects.toMatchObject({ code: 'LEAD_DECIDED' })
    await expect(deleteQuote(owner, seeded.clusterId, ids.bulk)).rejects.toMatchObject({
      code: 'LEAD_DECIDED',
    })
    const preview = await previewQuoteImport(owner, {
      fileName: 'late.csv',
      contentBase64: csv([
        ['簇 ID', '供应商', '单价', 'MOQ'],
        [seeded.clusterId, '迟到工厂', '9', '100'],
      ]),
      marketplace: 'ebay-us',
      currency: 'CNY',
    })
    expect(preview.issues).toEqual([
      expect.objectContaining({ row: 1, message: '该商品簇的线索已作出决定，核算已锁定' }),
    ])
    const v = await view(owner, seeded.leadId)
    expect(v.editable).toBe(false)
    expect(v.lead.status).toBe('followed')
  })
})
