import {
  brandEntry,
  cluster,
  clusterMember,
  clusterSignal,
  createDb,
  direction,
  directionSeller,
  lead,
  marketplaceProduct,
  observation,
  organization,
  riskFinding,
  scoped,
  scoringSetting,
  seasonalNode,
} from '@product-res/db'
import { addDays } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendScoringSetting, runSelectionDaily, runSelectionForWorkspace } from '../src/index.ts'

// tasks.md 3.1：用模拟数据（直接写 marketplace_product 与 observation）在真实 PG 上跑流水线。
const url = process.env.FOLLOW_TEST_DATABASE_URL
const db = createDb(url ?? 'postgres://skip@127.0.0.1:1/skip')
afterAll(() => db.$client.end())

// 远期日期，避免与其他用例的观测混在同一天
const asOf = '2031-05-01'
const now = new Date(`${asOf}T00:00:00+08:00`)
const tag = newId().slice(-10)
const category = `cat-${tag}`
const workspaceId = newId()
const productIds: string[] = []

const product = async (values: {
  platformId: string
  title: string
  sellerId: string
  gtin?: string
  brand?: string
  listedOn?: string
}) => {
  const [row] = await db
    .insert(marketplaceProduct)
    .values({
      marketplace: 'ebay-us',
      platformId: `${values.platformId}-${tag}`,
      title: values.title,
      sellerId: values.sellerId,
      gtin: values.gtin,
      brand: values.brand,
      categoryId: category,
      listedAt: values.listedOn ? new Date(`${values.listedOn}T00:00:00Z`) : null,
      firstSeenAt: new Date(`${addDays(asOf, -20)}T00:00:00Z`),
    })
    .returning({ id: marketplaceProduct.id })
  productIds.push(row?.id as string)
  return row?.id as string
}

const observe = (
  entityId: string,
  metric: string,
  observedOn: string,
  value: number,
  sourceId = 'ebay-browse',
) =>
  db.insert(observation).values({
    entityType: 'product',
    entityId,
    metric,
    observedOn,
    sourceId,
    value,
    method: 'official',
    fetchedAt: new Date(`${observedOn}T01:00:00Z`),
  })

let directionId = ''
let spice1 = ''
let spice2 = ''
let spice3 = ''
let mat = ''
let knife = ''

describe.skipIf(!url)('selection-daily 流水线', () => {
  beforeAll(async () => {
    await db
      .insert(organization)
      .values({ id: workspaceId, name: 'Pipeline', slug: `pipeline-${tag}`, isPersonal: false })
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
    const [row] = await s
      .insert(direction, {
        name: '厨房收纳',
        marketplaces: ['ebay-us'],
        categoryIds: [category],
        nodeIds: [node?.id as string],
      })
      .returning()
    directionId = row?.id as string
    await s.insert(directionSeller, [
      { directionId, marketplace: 'ebay-us', sellerPlatformId: 'seller-a', status: 'seed' },
      { directionId, marketplace: 'ebay-us', sellerPlatformId: 'seller-b', status: 'accepted' },
    ])
    await s.insert(brandEntry, { name: 'Acmeknife', kind: 'vero' })

    spice1 = await product({
      platformId: 'spice-1',
      title: 'Bamboo Spice Rack Organizer 3 Tier for Kitchen Cabinet',
      sellerId: 'seller-a',
      gtin: '0012345678905',
      listedOn: addDays(asOf, -3),
    })
    spice2 = await product({
      platformId: 'spice-2',
      title: 'Wooden shelf for spices',
      sellerId: 'seller-b',
      gtin: '12345678905',
      listedOn: addDays(asOf, -5),
    })
    spice3 = await product({
      platformId: 'spice-3',
      title: 'Bamboo Spice Rack Organizer 3 Tier Kitchen Cabinet Shelf',
      sellerId: 'seller-c',
    })
    mat = await product({
      platformId: 'mat',
      title: 'Silicone Baking Mat Non Stick Sheet',
      sellerId: 'seller-d',
    })
    knife = await product({
      platformId: 'knife',
      title: 'Acmeknife Kitchen Knife Sharpener',
      sellerId: 'seller-e',
      brand: 'Acmeknife',
    })

    for (const [offset, sold] of [
      [-30, 100],
      [-7, 160],
      [0, 220],
    ] as const) {
      await observe(spice1, 'sold_quantity_total', addDays(asOf, offset), sold)
      await observe(spice1, 'price', addDays(asOf, offset), 20 - offset / 10)
      await observe(spice1, 'review_count', addDays(asOf, offset), 50)
    }
    // 同一天另一个来源的价格：只作来源对比，不改主值
    await observe(spice1, 'price', asOf, 21, 'dataforseo')
    await observe(mat, 'price', asOf, 12)
    await observe(knife, 'price', asOf, 30)
  })

  afterAll(async () => {
    if (!url) return
    const s = scoped(db, workspaceId)
    await s.delete(lead, undefined)
    await s.delete(riskFinding, undefined)
    await s.delete(clusterSignal, undefined)
    await s.delete(clusterMember, undefined)
    await s.delete(cluster, undefined)
    await s.delete(directionSeller, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(brandEntry, undefined)
    await s.delete(scoringSetting, undefined)
    await db.delete(observation).where(inArray(observation.entityId, productIds))
    await db.delete(marketplaceProduct).where(inArray(marketplaceProduct.id, productIds))
    await db.delete(organization).where(eq(organization.id, workspaceId))
  })

  const leadsOn = (day: string) =>
    scoped(db, workspaceId).select(lead, { where: eq(lead.leadOn, day) })

  it('归并、信号、风险与线索写入；第二次运行不产生重复', async () => {
    const first = await runSelectionForWorkspace(db, workspaceId, { now, asOf })
    expect(first.failures).toEqual([])
    expect(first.directions[0]).toMatchObject({ clusters: 3, createdClusters: 3, leads: 3 })

    const s = scoped(db, workspaceId)
    const members = await s.select(clusterMember)
    const byProduct = new Map(members.map((m) => [m.productId, m]))
    expect(byProduct.get(spice2)).toMatchObject({ method: 'gtin', confidence: 0.95 })
    expect(byProduct.get(spice3)?.method).toBe('title')
    expect(byProduct.get(spice2)?.clusterId).toBe(byProduct.get(spice1)?.clusterId)
    expect(byProduct.get(spice3)?.clusterId).toBe(byProduct.get(spice1)?.clusterId)
    expect(byProduct.get(mat)?.clusterId).not.toBe(byProduct.get(spice1)?.clusterId)
    const spiceCluster = byProduct.get(spice1)?.clusterId as string
    const knifeCluster = byProduct.get(knife)?.clusterId as string

    const leads = await leadsOn(asOf)
    expect(leads).toHaveLength(3)
    const spiceLead = leads.find((l) => l.clusterId === spiceCluster)
    expect(spiceLead).toMatchObject({ settingVersion: 1, status: 'new', vetoed: false })
    // 冷启动：保存计算出的等级，界面显示“未验证”
    expect(spiceLead?.score).not.toBeNull()
    expect(spiceLead?.confidenceDetail).toMatchObject({
      readiness: 'cold-start',
      displayGrade: 'unverified',
    })
    // 返校季 7/15 − 默认提前期 48 天
    expect(spiceLead?.latestDecisionOn).toBe('2031-05-28')

    const signals = await s.select(clusterSignal, {
      where: eq(clusterSignal.clusterId, spiceCluster),
    })
    expect(signals).toHaveLength(7)
    const signal = (d: string) => signals.find((x) => x.dimension === d)
    expect(signal('market-demand')?.score).not.toBeNull()
    // M3 核算前没有落地成本：利润为空而不是 0；没有关键词趋势：增长与季节为空
    expect(signal('profit')?.score).toBeNull()
    expect(signal('growth-season')?.score).toBeNull()
    expect(signal('peer-spread')?.score).toBeGreaterThan(0)
    const competitionInputs = signal('competition')?.inputs as
      | { refs: { metric: string; sourceId: string }[] }
      | undefined
    const priceRefs = (competitionInputs?.refs ?? []).filter((r) => r.metric === 'price')
    expect(new Set(priceRefs.map((r) => r.sourceId))).toEqual(
      new Set(['ebay-browse', 'dataforseo']),
    )

    const knifeLead = leads.find((l) => l.clusterId === knifeCluster)
    expect(knifeLead?.vetoed).toBe(true)
    expect(knifeLead?.grade).toBe('reject')
    expect(knifeLead?.gates).toMatchObject({ passed: false, failures: [{ gate: 'compliance' }] })
    const findings = await s.select(riskFinding, { where: eq(riskFinding.clusterId, knifeCluster) })
    expect(findings.some((f) => f.kind === 'vero' && f.veto)).toBe(true)
    const findingCount = await s.count(riskFinding)

    // 团队处理过的线索状态在重复运行时保留
    await s.update(lead, { status: 'costing' }, eq(lead.id, spiceLead?.id as string))
    const second = await runSelectionForWorkspace(db, workspaceId, { now, asOf })
    expect(second.directions[0]).toMatchObject({ clusters: 3, createdClusters: 0, leads: 3 })
    const again = await leadsOn(asOf)
    expect(again).toHaveLength(3)
    expect(again.map((l) => l.id).sort()).toEqual(leads.map((l) => l.id).sort())
    expect(again.find((l) => l.id === spiceLead?.id)?.status).toBe('costing')
    expect(await s.count(clusterMember)).toBe(members.length)
    expect(await s.count(clusterSignal)).toBe(21)
    expect(await s.count(riskFinding)).toBe(findingCount)
  })

  it('锁定成员不被自动归并合回；新版本设置只用于之后的线索', async () => {
    const s = scoped(db, workspaceId)
    const [member] = await s.select(clusterMember, { where: eq(clusterMember.productId, spice3) })
    const [split] = await s
      .insert(cluster, { directionId, marketplace: 'ebay-us', name: '拆分' })
      .returning()
    await s.update(
      clusterMember,
      { clusterId: split?.id as string, method: 'manual', confidence: 1, locked: true },
      eq(clusterMember.id, member?.id as string),
    )
    await appendScoringSetting(db, workspaceId, {
      weights: {
        'market-demand': 2,
        'growth-season': 1,
        'peer-spread': 1,
        profit: 1,
        competition: 1,
        'supply-timing': 1,
        compliance: 1,
      },
      reverseDimensions: ['competition', 'supply-timing'],
      vetoThreshold: 30,
      minDimensions: 4,
      hardGates: { compliance: true, timing: true, margin: true },
      marginFloorBp: 1500,
    })

    const nextDay = addDays(asOf, 1)
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: nextDay })
    const [after] = await s.select(clusterMember, { where: eq(clusterMember.productId, spice3) })
    expect(after).toMatchObject({ clusterId: split?.id, locked: true })

    const today = await leadsOn(nextDay)
    expect(today).toHaveLength(4)
    expect(today.every((l) => l.settingVersion === 2)).toBe(true)
    // 新一天的线索沿用该簇上一条线索的处理状态
    const spiceCluster = (
      await s.select(clusterMember, { where: eq(clusterMember.productId, spice1) })
    )[0]?.clusterId
    expect(today.find((l) => l.clusterId === spiceCluster)?.status).toBe('costing')
    // 已有线索保留原版本
    expect((await leadsOn(asOf)).every((l) => l.settingVersion === 1)).toBe(true)
  })

  it('停用方向不生成新线索', async () => {
    const s = scoped(db, workspaceId)
    await s.update(direction, { enabled: false }, eq(direction.id, directionId))
    const day = addDays(asOf, 2)
    const results = await runSelectionDaily(db, { now, asOf: day })
    expect(results.some((r) => r.workspaceId === workspaceId)).toBe(false)
    expect(await runSelectionForWorkspace(db, workspaceId, { now, asOf: day })).toMatchObject({
      directions: [],
    })
    expect(await leadsOn(day)).toHaveLength(0)
  })
})
