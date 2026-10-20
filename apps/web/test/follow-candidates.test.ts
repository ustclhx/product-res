import { env } from 'cloudflare:workers'
import {
  cluster,
  clusterMember,
  clusterSignal,
  createDb,
  direction,
  lead,
  leadEvent,
  marketplaceProduct,
  observation,
  organization,
  riskFinding,
  scoped,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { candidatesPage, clusterDetail } from '../src/features/follow/candidates.server.ts'
import { mergeIntoCluster, splitClusterMember } from '../src/features/follow/clusters.server.ts'
import type { WorkbenchActor } from '../src/features/workbench/actor.ts'

// tasks.md 4.1 / 4.2：候选列表（平台、排序、最新线索、空状态）、详情（缺失维度、来源对比）、
// 拆分 / 合并（锁定、lead_event、跨空间与权限）。市场数据表是部署级共享表，商品 ID 每次随机。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []
const products: string[] = []

async function space(): Promise<WorkbenchActor> {
  const id = newId()
  spaces.push(id)
  await db()
    .insert(organization)
    .values({ id, name: 'Candidates test', slug: `cand-${id.slice(-12)}`, isPersonal: false })
  return { db: db(), workspaceId: id, workspaceReadOnly: false, member: { role: 'owner' } }
}

async function product(marketplace: string, title: string) {
  const [row] = await db()
    .insert(marketplaceProduct)
    .values({ marketplace, platformId: `T${newId().slice(-10)}`, title, sellerId: 'seller-a' })
    .returning()
  products.push(row?.id as string)
  return row as typeof marketplaceProduct.$inferSelect
}

const today = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

/** 一个簇：成员、某天的线索与维度信号 */
async function seedCluster(
  actor: WorkbenchActor,
  input: {
    directionId: string
    marketplace: string
    title: string
    members?: number
    score: number | null
    confidence: number
    leadOn?: string
    signals?: Partial<Record<string, number | null>>
  },
) {
  const s = scoped(actor.db, actor.workspaceId)
  const items = []
  for (let i = 0; i < (input.members ?? 1); i += 1)
    items.push(await product(input.marketplace, `${input.title} ${i}`))
  const [c] = await s
    .insert(cluster, {
      directionId: input.directionId,
      marketplace: input.marketplace,
      name: input.title,
      representativeProductId: items[0]?.id ?? null,
    })
    .returning()
  const clusterId = c?.id as string
  await s.insert(
    clusterMember,
    items.map((p, i) => ({
      clusterId,
      productId: p.id,
      method: i === 0 ? ('gtin' as const) : ('title' as const),
      confidence: i === 0 ? 0.95 : 0.7,
    })),
  )
  const leadOn = input.leadOn ?? today
  await s.insert(lead, {
    clusterId,
    directionId: input.directionId,
    leadOn,
    score: input.score,
    confidence: input.confidence,
    settingVersion: 1,
    confidenceDetail: {
      items: [{ id: 'coverage', value: 0.5, note: '快照 15 天' }],
      unverifiedMetrics: ['price'],
    },
  })
  const signals = input.signals ?? {}
  if (Object.keys(signals).length)
    await s.insert(
      clusterSignal,
      Object.entries(signals).map(([dimension, score]) => ({
        clusterId,
        observedOn: leadOn,
        dimension: dimension as 'market-demand',
        score: score ?? null,
        inputs: {
          reason: 'fixture',
          inputs: [
            {
              metric: 'price',
              value: 10,
              observedOn: leadOn,
              sourceId: 'ebay-browse',
              method: 'official',
              fetchedAt: `${leadOn}T01:00:00Z`,
            },
          ],
        },
      })),
    )
  return { clusterId, products: items }
}

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(leadEvent, undefined)
    await s.delete(lead, undefined)
    await s.delete(riskFinding, undefined)
    await s.delete(clusterSignal, undefined)
    await s.delete(clusterMember, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
  }
  if (products.length) {
    await db().delete(observation).where(inArray(observation.entityId, products))
    await db().delete(marketplaceProduct).where(inArray(marketplaceProduct.id, products))
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
})

describe('候选列表', () => {
  let owner: WorkbenchActor
  let directionId: string
  beforeAll(async () => {
    owner = await space()
    const [d] = await scoped(owner.db, owner.workspaceId)
      .insert(direction, { name: '厨房', marketplaces: ['amazon-us', 'ebay-us'] })
      .returning()
    directionId = d?.id as string
  })

  it('没有线索时返回空状态所需的配置情况，不返回示例数据', async () => {
    const empty = await space()
    const page = await candidatesPage(empty, { platform: 'ebay', offset: 0 })
    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
    expect(page.setup).toMatchObject({ directions: 0, platformDirections: 0 })
  })

  it('按平台筛选、按 综合分 × 置信度 排序，每个簇只取最新一天的线索', async () => {
    const a = await seedCluster(owner, {
      directionId,
      marketplace: 'amazon-us',
      title: 'Bowl A',
      score: 90,
      confidence: 0.4, // 36
      signals: { 'market-demand': 85, competition: 20, profit: null },
    })
    // 同一簇昨天的旧线索不应出现
    await scoped(owner.db, owner.workspaceId).insert(lead, {
      clusterId: a.clusterId,
      directionId,
      leadOn: yesterday,
      score: 10,
      confidence: 1,
      settingVersion: 1,
    })
    await seedCluster(owner, {
      directionId,
      marketplace: 'amazon-us',
      title: 'Bowl B',
      score: 70,
      confidence: 0.8, // 56
    })
    await seedCluster(owner, {
      directionId,
      marketplace: 'amazon-us',
      title: 'Bowl C',
      score: null,
      confidence: 0.9,
    })
    await seedCluster(owner, {
      directionId,
      marketplace: 'ebay-us',
      title: 'Lamp E',
      score: 80,
      confidence: 0.3,
    })

    const amazon = await candidatesPage(owner, { platform: 'amazon', offset: 0 })
    expect(amazon.items.map((i) => i.name)).toEqual(['Bowl B 0', 'Bowl A 0', 'Bowl C 0'])
    expect(amazon.total).toBe(3)
    expect(amazon.setup).toBeNull()
    const bowlA = amazon.items[1]
    expect(bowlA?.grade).toBe('unverified')
    expect(bowlA?.signals.map((s) => s.label)).toEqual(['市场需求', '竞争强度'])
    expect(bowlA?.sources).toEqual([
      expect.objectContaining({ sourceId: 'ebay-browse', method: 'official' }),
    ])

    const ebay = await candidatesPage(owner, { platform: 'ebay', offset: 0 })
    expect(ebay.items.map((i) => i.name)).toEqual(['Lamp E 0'])
    // 高分低置信
    expect(ebay.items[0]?.attention).toBe(true)
    expect(ebay.items[0]?.bsr).toBeNull()

    const other = await space()
    expect((await candidatesPage(other, { platform: 'amazon', offset: 0 })).items).toEqual([])
  })

  it('详情：缺失维度为空而不是 0；来源对比带各来源值与离散度', async () => {
    const c = await seedCluster(owner, {
      directionId,
      marketplace: 'amazon-us',
      title: 'Detail',
      members: 2,
      score: 72,
      confidence: 0.6,
      signals: { 'market-demand': 70, compliance: 100 },
    })
    const productId = c.products[0]?.id as string
    const fetchedAt = new Date()
    await db()
      .insert(observation)
      .values(
        ['keepa', 'jungle-scout'].map((sourceId, i) => ({
          entityType: 'product',
          entityId: productId,
          metric: 'sales_estimate_monthly',
          observedOn: today,
          sourceId,
          value: 1000 + i * 200,
          method: 'estimate' as const,
          tier: 3,
          fetchedAt,
        })),
      )
    const detail = await clusterDetail(owner, c.clusterId, true)
    expect(detail.dimensions).toHaveLength(7)
    expect(detail.dimensions.find((d) => d.dimension === 'profit')?.score).toBeNull()
    expect(detail.dimensions.find((d) => d.dimension === 'market-demand')?.score).toBe(70)
    expect(detail.headline.sales).toMatchObject({
      primarySourceId: 'jungle-scout',
      dispersion: 0.2,
    })
    expect(detail.headline.sales?.values.map((v) => v.sourceId)).toEqual(['jungle-scout', 'keepa'])
    expect(detail.series.sales.series[0]?.points).toEqual([[today, 1200]])
    expect(detail.members).toHaveLength(2)
    expect(detail.members[0]?.isRepresentative).toBe(true)

    const other = await space()
    await expect(clusterDetail(other, c.clusterId, true)).rejects.toMatchObject({ status: 404 })
  })
})

describe('拆分与合并', () => {
  let owner: WorkbenchActor
  let directionId: string
  beforeAll(async () => {
    owner = await space()
    const [d] = await scoped(owner.db, owner.workspaceId)
      .insert(direction, { name: '收纳', marketplaces: ['ebay-us'] })
      .returning()
    directionId = d?.id as string
  })

  const members = (clusterId: string) =>
    scoped(owner.db, owner.workspaceId).select(clusterMember, {
      where: eq(clusterMember.clusterId, clusterId),
    })

  it('拆分：成员进入新簇并锁定，原簇与新簇各记一条事件；代表商品改为剩余成员', async () => {
    const c = await seedCluster(owner, {
      directionId,
      marketplace: 'ebay-us',
      title: 'Rack',
      members: 3,
      score: 60,
      confidence: 0.5,
    })
    const before = await members(c.clusterId)
    const rep = before.find((m) => m.productId === c.products[0]?.id)
    const { clusterId: created } = await splitClusterMember(owner, {
      clusterId: c.clusterId,
      memberId: rep?.id as string,
    })
    const moved = await members(created)
    expect(moved).toEqual([
      expect.objectContaining({ productId: rep?.productId, method: 'manual', locked: true }),
    ])
    expect(moved[0]?.confidence).toBe(1)
    expect(await members(c.clusterId)).toHaveLength(2)
    const s = scoped(owner.db, owner.workspaceId)
    const original = await s.findById(cluster, c.clusterId)
    expect(original.representativeProductId).toBe(c.products[1]?.id)
    const events = await s.select(leadEvent, {
      where: inArray(leadEvent.clusterId, [c.clusterId, created]),
    })
    expect(events.map((e) => e.kind)).toEqual(['split', 'split'])
    // 原簇的事件挂到最新线索上
    expect(events.find((e) => e.clusterId === c.clusterId)?.leadId).toBeTruthy()
    expect(events[0]?.payload).toMatchObject({ fromClusterId: c.clusterId, toClusterId: created })

    // 新簇只剩一个成员，不能再拆
    await expect(
      splitClusterMember(owner, { clusterId: created, memberId: moved[0]?.id as string }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('合并：来源簇成员移入并锁定，来源簇标为 merged；同一商品不重复', async () => {
    const into = await seedCluster(owner, {
      directionId,
      marketplace: 'ebay-us',
      title: 'Hook',
      members: 1,
      score: 60,
      confidence: 0.5,
    })
    const from = await seedCluster(owner, {
      directionId,
      marketplace: 'ebay-us',
      title: 'Hook dup',
      members: 2,
      score: 50,
      confidence: 0.5,
    })
    // 来源簇里有一个与目标簇相同的商品
    await scoped(owner.db, owner.workspaceId).insert(clusterMember, {
      clusterId: from.clusterId,
      productId: into.products[0]?.id as string,
      method: 'title',
      confidence: 0.6,
    })
    const result = await mergeIntoCluster(owner, {
      intoClusterId: into.clusterId,
      fromClusterId: from.clusterId,
    })
    expect(result.moved).toBe(2)
    const merged = await members(into.clusterId)
    expect(merged).toHaveLength(3)
    expect(merged.filter((m) => m.locked).map((m) => m.method)).toEqual(['manual', 'manual'])
    expect(await members(from.clusterId)).toEqual([])
    const s = scoped(owner.db, owner.workspaceId)
    expect(await s.findById(cluster, from.clusterId)).toMatchObject({
      status: 'merged',
      mergedIntoId: into.clusterId,
    })
    expect(
      (await s.select(leadEvent, { where: eq(leadEvent.kind, 'merge') })).map((e) => e.clusterId),
    ).toEqual(expect.arrayContaining([into.clusterId, from.clusterId]))
    // 合并后的簇不再出现在候选列表中
    const page = await candidatesPage(owner, { platform: 'ebay', offset: 0 })
    expect(page.items.map((i) => i.clusterId)).not.toContain(from.clusterId)
    // 已合并的簇不能再参与合并
    await expect(
      mergeIntoCluster(owner, { intoClusterId: from.clusterId, fromClusterId: into.clusterId }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('不同站点不能合并；member、只读空间与其他空间不能修改', async () => {
    const a = await seedCluster(owner, {
      directionId,
      marketplace: 'ebay-us',
      title: 'Cup',
      members: 2,
      score: 60,
      confidence: 0.5,
    })
    const b = await seedCluster(owner, {
      directionId,
      marketplace: 'amazon-us',
      title: 'Cup amz',
      score: 60,
      confidence: 0.5,
    })
    await expect(
      mergeIntoCluster(owner, { intoClusterId: a.clusterId, fromClusterId: b.clusterId }),
    ).rejects.toMatchObject({ status: 400 })
    const [m] = await members(a.clusterId)
    const input = { clusterId: a.clusterId, memberId: m?.id as string }
    await expect(
      splitClusterMember({ ...owner, member: { role: 'member' } }, input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await expect(
      splitClusterMember({ ...owner, workspaceReadOnly: true }, input),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY', status: 403 })
    const other = await space()
    await expect(splitClusterMember(other, input)).rejects.toMatchObject({ status: 404 })
    expect(await members(a.clusterId)).toHaveLength(2)
  })
})
