import { createConnectors } from '@product-res/connectors'
import type { SourceConnector } from '@product-res/datasources'
import {
  budgetLedger,
  cluster,
  clusterMember,
  direction,
  directionSeller,
  lead,
  scoped,
  seasonalNode,
  sourceBudget,
} from '@product-res/db'
import { reserve, scheduledHeadroom } from '@product-res/marketdata'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  COLLECT_PRIORITY,
  type CollectionTargets,
  loadCollectionTargets,
  planCollections,
  type SourceAllowance,
} from '../src/index.ts'
import { cleanup, createWorkspace, insertProduct, testDb, url } from './helpers.ts'

// tasks.md 3.2：每日采集计划。计划只调用连接器的 plan() 估算花费，不发出任何请求。
const connectors = new Map(createConnectors().map((c) => [c.id, c]))
const connector = (id: string) => connectors.get(id) as SourceConnector
const allowance = (id: string, headroom: number, minuteSlots?: number): SourceAllowance => ({
  connector: connector(id),
  headroom,
  ...(minuteSlots === undefined ? {} : { minuteSlots }),
})
const allSources = (headroom = 1_000_000) =>
  new Map([
    ['ebay-browse', allowance('ebay-browse', headroom)],
    ['keepa', allowance('keepa', 20, 60)],
    ['dataforseo', allowance('dataforseo', 40_000_000)],
  ])

const ebayIds = (n: number, prefix = 'e') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

describe('采集计划（纯函数）', () => {
  const targets: CollectionTargets = {
    sellers: [
      // 两个方向（可能不同空间）共享同一卖家与类目：只扫描一次
      { marketplace: 'ebay-us', sellerId: 'shop-a', categoryIds: ['100'], keywords: [] },
      { marketplace: 'ebay-us', sellerId: 'shop-a', categoryIds: ['100', '200'], keywords: [] },
      // 没有类目的方向用关键词作 q
      { marketplace: 'ebay-us', sellerId: 'shop-b', categoryIds: [], keywords: ['Spice Rack'] },
      // 既没有类目也没有关键词：无法搜索，不生成
      { marketplace: 'ebay-us', sellerId: 'shop-c', categoryIds: [], keywords: [] },
      // Amazon 卖家不走 eBay 卖家扫描
      { marketplace: 'amazon-us', sellerId: 'A1', categoryIds: ['1'], keywords: [] },
    ],
    products: [
      { marketplace: 'ebay-us', platformId: 'e1', hasLead: false },
      // 同一商品在另一个簇里有线索：合并为一个，按线索优先级
      { marketplace: 'ebay-us', platformId: 'e1', hasLead: true },
      { marketplace: 'ebay-us', platformId: 'e2', hasLead: false },
      { marketplace: 'amazon-us', platformId: 'B001', hasLead: false },
      { marketplace: 'amazon-us', platformId: 'B002', hasLead: true },
    ],
    keywords: ['Spice Rack', 'spice  rack', 'Back to School'],
  }

  it('去重并按 卖家新品 > 有线索快照 > 其他快照 > 关键词 排序', () => {
    const plan = planCollections(targets, allSources(), { keywords: true })
    const sellers = plan.tasks.filter((t) => t.task.kind === 'seller-new-listings')
    expect(sellers.map((t) => t.task.scope)).toEqual([
      { sellerId: 'shop-a', categoryIds: '100' },
      { sellerId: 'shop-a', categoryIds: '200' },
      { sellerId: 'shop-b', q: 'spice rack' },
    ])
    expect(sellers.every((t) => t.sourceId === 'ebay-browse' && t.stage === 'seller-scan')).toBe(
      true,
    )
    const snapshots = plan.tasks.filter((t) => t.task.kind === 'product-snapshot')
    expect(snapshots.map((t) => [t.sourceId, t.priority, t.task.scope.ids])).toEqual([
      ['ebay-browse', COLLECT_PRIORITY.leadSnapshot, ['e1']],
      ['keepa', COLLECT_PRIORITY.leadSnapshot, ['B002']],
      ['ebay-browse', COLLECT_PRIORITY.memberSnapshot, ['e2']],
      ['keepa', COLLECT_PRIORITY.memberSnapshot, ['B001']],
    ])
    const priorities = plan.tasks.map((t) => t.priority)
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
    // 关键词去重归一后：每个词一个 Trends 任务 + 一个搜索量批次
    const keywords = plan.tasks.filter((t) => t.sourceId === 'dataforseo')
    expect(keywords.map((t) => [t.task.kind, t.task.scope.keywords])).toEqual([
      ['search-trend', ['back to school']],
      ['search-trend', ['spice rack']],
      ['keyword-volume', ['back to school', 'spice rack']],
    ])
    expect(new Set(plan.tasks.map((t) => t.key)).size).toBe(plan.tasks.length)
    expect(plan.truncated).toEqual({})
  })

  it('非周一不生成关键词任务', () => {
    const plan = planCollections(targets, allSources(), { keywords: false })
    expect(plan.tasks.some((t) => t.sourceId === 'dataforseo')).toBe(false)
  })

  it('按安全线截断：低优先级先被顺延，并记录被截断数量', () => {
    const many: CollectionTargets = {
      sellers: Array.from({ length: 3 }, (_, i) => ({
        marketplace: 'ebay-us',
        sellerId: `s${i}`,
        categoryIds: ['1'],
        keywords: [],
      })),
      products: [
        ...ebayIds(40, 'L').map((platformId) => ({
          marketplace: 'ebay-us',
          platformId,
          hasLead: true,
        })),
        ...ebayIds(100, 'M').map((platformId) => ({
          marketplace: 'ebay-us',
          platformId,
          hasLead: false,
        })),
      ],
      keywords: [],
    }
    // eBay 快照逐个 getItem 计费（每批 20 个 = 20 次）：
    // 3 次卖家扫描 + 2 批线索快照（40 次）+ 5 批其他快照（100 次）；只剩 63 次额度
    const plan = planCollections(many, allSources(63), { keywords: false })
    expect(plan.tasks.reduce((n, t) => n + t.cost, 0)).toBeLessThanOrEqual(63)
    expect(plan.tasks.map((t) => t.priority)).toEqual([0, 0, 0, 1, 1, 2])
    expect(plan.truncated).toEqual({ 'ebay-browse': 4 })
    // 额度为 0（已到安全线）：一个都不投递
    const none = planCollections(many, allSources(0), { keywords: false })
    expect(none.tasks).toEqual([])
    expect(none.truncated).toEqual({ 'ebay-browse': 10 })
  })

  it('Keepa 按每分钟令牌分批并错开时间槽，窗口用完即截断', () => {
    const asins: CollectionTargets = {
      sellers: [],
      products: Array.from({ length: 70 }, (_, i) => ({
        marketplace: 'amazon-us',
        platformId: `B${String(i).padStart(4, '0')}`,
        hasLead: false,
      })),
      keywords: [],
    }
    const sources = new Map([['keepa', allowance('keepa', 20, 3)]])
    const plan = planCollections(asins, sources, { keywords: false })
    // 每批 20 个 ASIN（20 令牌 = 每分钟容量），3 个时间槽装 3 批，第 4 批顺延
    expect(plan.tasks.map((t) => [t.slot, t.cost, (t.task.scope.ids as string[]).length])).toEqual([
      [0, 20, 20],
      [1, 20, 20],
      [2, 20, 20],
    ])
    expect(plan.truncated).toEqual({ keepa: 1 })
  })

  it('数据源不可用时不生成任务并记录', () => {
    const plan = planCollections(targets, new Map([['keepa', allowance('keepa', 20, 60)]]), {
      keywords: true,
    })
    expect(new Set(plan.tasks.map((t) => t.sourceId))).toEqual(new Set(['keepa']))
    expect(plan.unavailable).toEqual({ 'ebay-browse': 5, dataforseo: 3 })
  })
})

describe.skipIf(!url)('采集对象读取（真实 PG）', () => {
  const db = testDb()
  const asOf = '2031-06-02'
  const tag = newId().slice(-10)
  const workspaces: string[] = []
  const productIds: string[] = []

  beforeAll(async () => {
    const [w1, w2] = [await createWorkspace(db, 'CollectA'), await createWorkspace(db, 'CollectB')]
    workspaces.push(w1, w2)
    for (const [index, ws] of [w1, w2].entries()) {
      const s = scoped(db, ws)
      const [node] = await s
        .insert(seasonalNode, {
          name: `节点-${tag}`,
          startMonth: 8,
          startDay: 1,
          salesDays: 30,
          keywords: [`node kw ${tag}`],
        })
        .returning()
      const [on] = await s
        .insert(direction, {
          name: `启用-${tag}`,
          marketplaces: ['ebay-us'],
          categoryIds: [`cat-${tag}`],
          keywords: [`kw ${tag}`],
          nodeIds: [node?.id as string],
        })
        .returning()
      const [off] = await s
        .insert(direction, {
          name: `停用-${tag}`,
          marketplaces: ['ebay-us'],
          categoryIds: [`off-${tag}`],
          keywords: [`off kw ${tag}`],
          enabled: false,
        })
        .returning()
      await s.insert(directionSeller, [
        // 两个空间共享的种子卖家
        {
          directionId: on?.id as string,
          marketplace: 'ebay-us',
          sellerPlatformId: `shared-${tag}`,
          status: 'seed',
        },
        {
          directionId: on?.id as string,
          marketplace: 'ebay-us',
          sellerPlatformId: `rejected-${tag}-${index}`,
          status: 'rejected',
        },
        {
          directionId: off?.id as string,
          marketplace: 'ebay-us',
          sellerPlatformId: `off-${tag}-${index}`,
          status: 'accepted',
        },
      ])
      const p = await insertProduct(db, {
        marketplace: 'ebay-us',
        platformId: `item-${tag}-${index}`,
        title: 'Spice Rack',
        firstSeenOn: asOf,
      })
      const q = await insertProduct(db, {
        marketplace: 'ebay-us',
        platformId: `off-item-${tag}-${index}`,
        title: 'Spice Rack',
        firstSeenOn: asOf,
      })
      productIds.push(p, q)
      const [c] = await s
        .insert(cluster, { directionId: on?.id as string, marketplace: 'ebay-us', name: 'c' })
        .returning()
      const [d] = await s
        .insert(cluster, { directionId: off?.id as string, marketplace: 'ebay-us', name: 'd' })
        .returning()
      await s.insert(clusterMember, [
        { clusterId: c?.id as string, productId: p, method: 'gtin', confidence: 1 },
        { clusterId: d?.id as string, productId: q, method: 'gtin', confidence: 1 },
      ])
      // 只有第一个空间的簇有线索
      if (index === 0)
        await s.insert(lead, {
          clusterId: c?.id as string,
          directionId: on?.id as string,
          leadOn: asOf,
          settingVersion: 1,
        })
    }
  })

  afterAll(async () => {
    if (!url) return
    // 商品被两个空间的簇成员引用：最后一个空间清理时再删商品
    for (const [i, ws] of workspaces.entries())
      await cleanup(db, ws, i === workspaces.length - 1 ? productIds : [])
  })

  it('读取启用方向的卖家、簇成员与关键词；停用方向与拒绝的卖家不进入计划', async () => {
    const targets = await loadCollectionTargets(db, { asOf, keywords: true })
    const sellers = targets.sellers.filter((s) => s.sellerId.includes(tag))
    expect(sellers.map((s) => s.sellerId)).toEqual([`shared-${tag}`, `shared-${tag}`])
    expect(sellers[0]?.categoryIds).toEqual([`cat-${tag}`])
    const products = targets.products.filter((p) => p.platformId.includes(tag))
    expect(products.sort((a, b) => a.platformId.localeCompare(b.platformId))).toEqual([
      { marketplace: 'ebay-us', platformId: `item-${tag}-0`, hasLead: true },
      { marketplace: 'ebay-us', platformId: `item-${tag}-1`, hasLead: false },
    ])
    const keywords = targets.keywords.filter((k) => k.includes(tag))
    expect(new Set(keywords)).toEqual(new Set([`kw ${tag}`, `node kw ${tag}`]))

    // 计划中两个空间的同一卖家只扫描一次
    const plan = planCollections(targets, allSources(), { keywords: true })
    expect(
      plan.tasks.filter(
        (t) => t.task.kind === 'seller-new-listings' && t.task.scope.sellerId === `shared-${tag}`,
      ),
    ).toHaveLength(1)
  })

  it('非周一不读取关键词', async () => {
    const targets = await loadCollectionTargets(db, { asOf, keywords: false })
    expect(targets.keywords).toEqual([])
  })

  it('定时额度只算到安全线', async () => {
    const sourceId = `headroom-${tag}`
    const spec = {
      unit: 'call' as const,
      period: 'day' as const,
      hardCap: 100,
      safetyLine: 90,
      timeZone: 'UTC',
    }
    const now = new Date('2031-06-02T00:00:00Z')
    expect(await scheduledHeadroom(db, sourceId, spec, now)).toBe(90)
    const r = await reserve(db, { sourceId, spec, amount: 85, mode: 'scheduled', now })
    expect(r.ok).toBe(true)
    expect(await scheduledHeadroom(db, sourceId, spec, now)).toBe(5)
    // 人工刷新用到安全线以上后，定时额度为 0
    await reserve(db, { sourceId, spec, amount: 10, mode: 'manual', now })
    expect(await scheduledHeadroom(db, sourceId, spec, now)).toBe(0)
    await db.delete(budgetLedger).where(eq(budgetLedger.sourceId, sourceId))
    await db.delete(sourceBudget).where(eq(sourceBudget.sourceId, sourceId))
  })
})
