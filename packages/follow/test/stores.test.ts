import type { NormalizedBatch } from '@product-res/datasources'
import {
  direction,
  lead,
  leadEvent,
  marketplaceSeller,
  observation,
  scoped,
  storeListing,
  trackedProduct,
  trackedStore,
} from '@product-res/db'
import { listTrackedProducts, trackProduct, upsertEntities } from '@product-res/marketdata'
import { AppError, newId } from '@product-res/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addStore,
  evaluateStoreTracking,
  listStores,
  loadStoreCollectionTargets,
  mergedBenchmarks,
  recordStoreListings,
  STORE_LEAD_SOURCE,
  setStoreStatus,
} from '../src/index.ts'
import { cleanup, createWorkspace, testDb, url } from './helpers.ts'

// add-accuracy-store-tracking tasks 3.1–3.3：店铺池、店铺新品归属、出单线索去重、升降档与店铺指标。
// 只写入本测试生成的 ASIN / 卖家，不调用任何外部接口。
describe.skipIf(!url)('店铺追踪', () => {
  const db = testDb()
  const tag = newId().slice(-8).toUpperCase()
  const seller = `A${tag}`
  const ebaySeller = `kitchen_${tag.toLowerCase()}`
  const day = '2031-06-20'
  const now = new Date('2031-06-20T03:00:00Z')
  let ws = ''
  let other = ''
  let directionId = ''
  const productIds: string[] = []

  const asin = (n: number) => `B0${tag}${n}`
  async function products(keys: { platformId: string; marketplace: string; listedAt?: string }[]) {
    const ids = await upsertEntities(
      db,
      keys.map((k) => ({
        key: {
          type: 'product' as const,
          marketplace: k.marketplace as never,
          platformId: k.platformId,
        },
        facts: { title: `Rack ${k.platformId}`, ...(k.listedAt ? { listedAt: k.listedAt } : {}) },
      })),
    )
    for (const id of ids.values()) productIds.push(id)
    return ids
  }
  async function bought(productId: string, rows: { on: string; low: number; high: number }[]) {
    await db.insert(observation).values(
      rows.map((r) => ({
        entityType: 'product',
        entityId: productId,
        metric: 'bought_month',
        observedOn: r.on,
        sourceId: 'dataforseo',
        value: Math.sqrt(r.low * r.high),
        valueLow: r.low,
        valueHigh: r.high,
        method: 'official' as const,
        tier: 2,
        fetchedAt: new Date(`${r.on}T01:00:00Z`),
      })),
    )
  }

  beforeAll(async () => {
    ws = await createWorkspace(db, 'Stores')
    other = await createWorkspace(db, 'Other')
    const [dir] = await scoped(db, ws)
      .insert(direction, {
        name: `收纳-${tag}`,
        marketplaces: ['amazon-us', 'ebay-us'],
        keywords: ['spice rack'],
      })
      .returning()
    directionId = dir?.id as string
  })

  afterAll(async () => {
    for (const id of [ws, other]) {
      await scoped(db, id).delete(trackedProduct, undefined)
      await scoped(db, id).delete(trackedStore, undefined)
    }
    await db.delete(storeListing).where(inArray(storeListing.sellerKey, [seller, ebaySeller]))
    const sellers = await db
      .select({ id: marketplaceSeller.id })
      .from(marketplaceSeller)
      .where(inArray(marketplaceSeller.platformId, [seller, ebaySeller]))
    if (sellers.length)
      await db.delete(observation).where(
        inArray(
          observation.entityId,
          sellers.map((s) => s.id),
        ),
      )
    await cleanup(db, ws, productIds)
    await cleanup(db, other, [])
  })

  it('粘贴 seller= 链接加入 Amazon 店铺；空间隔离；无法识别的链接不建记录；重复添加 409', async () => {
    const { store } = await addStore(db, ws, {
      url: `https://www.amazon.com/sp?seller=${seller}`,
      kind: 'benchmark',
      directionIds: [directionId],
      displayName: 'Rack House',
    })
    expect(store).toMatchObject({ platform: 'amazon', marketplace: 'amazon-us', sellerKey: seller })
    expect(await listStores(db, other)).toEqual([])
    await expect(
      addStore(db, ws, { url: 'https://www.amazon.com/dp/B0C1234567', kind: 'watch' }),
    ).rejects.toMatchObject({ code: 'STORE_LINK_UNRECOGNIZED' })
    expect(await listStores(db, ws)).toHaveLength(1)
    await expect(
      addStore(db, ws, { url: `amazon.com/s?me=${seller}`, kind: 'hot' }),
    ).rejects.toMatchObject({ code: 'STORE_EXISTS', status: 409 })
    // 关联其他空间的方向：不存在
    await expect(
      addStore(db, other, {
        url: `https://www.ebay.com/usr/${ebaySeller}`,
        kind: 'watch',
        directionIds: [directionId],
      }),
    ).rejects.toBeInstanceOf(AppError)
    // 方向读取时合并店铺池
    expect((await mergedBenchmarks(db, ws)).get(directionId)).toEqual([
      { marketplace: 'amazon-us', sellerId: seller },
    ])
  })

  it('/str/ 链接：解析出卖家用户名后按 /usr/ 保存，显示名保留店铺名；解析失败不建记录', async () => {
    const storeName = `watch${tag.toLowerCase()}`
    const username = `seller-${tag.toLowerCase()}`
    await expect(
      addStore(db, other, { url: `https://www.ebay.com/str/${storeName}`, kind: 'watch' }),
    ).rejects.toMatchObject({ code: 'STORE_USERNAME_UNRESOLVED', status: 422 })
    await expect(
      addStore(
        db,
        other,
        { url: `https://www.ebay.com/str/${storeName}`, kind: 'watch' },
        { resolveEbayStore: async () => null },
      ),
    ).rejects.toMatchObject({ code: 'STORE_USERNAME_UNRESOLVED' })
    expect(await listStores(db, other)).toEqual([])
    const asked: string[] = []
    const { store } = await addStore(
      db,
      other,
      { url: `ebay.com/str/${storeName}`, kind: 'watch' },
      {
        resolveEbayStore: async (name) => {
          asked.push(name)
          return username
        },
      },
    )
    expect(asked).toEqual([storeName])
    expect(store).toMatchObject({
      platform: 'ebay',
      sellerKey: username,
      displayName: storeName,
      url: `https://www.ebay.com/usr/${username}`,
    })
    await setStoreStatus(db, other, store.id, 'removed')
  })

  it('移除后保留记录，再次添加重新启用', async () => {
    const { store } = await addStore(db, ws, {
      url: `https://www.ebay.com/usr/${ebaySeller}`,
      kind: 'watch',
      keywords: ['Spice Rack', 'spice rack'],
    })
    expect(store.keywords).toEqual(['spice rack'])
    await setStoreStatus(db, ws, store.id, 'removed')
    expect((await listStores(db, ws)).map((s) => s.sellerKey)).toEqual([seller])
    const again = await addStore(db, ws, {
      url: `https://www.ebay.com/sch/i.html?_ssn=${ebaySeller}`,
      kind: 'hot',
    })
    expect(again).toMatchObject({ reactivated: true, store: { id: store.id, status: 'active' } })
  })

  it('报价命中店铺写入 store_listing；店铺不再出现在报价中记为下架', async () => {
    const ids = await products([{ platformId: asin(1), marketplace: 'amazon-us' }])
    const product = {
      type: 'product' as const,
      marketplace: 'amazon-us' as const,
      platformId: asin(1),
    }
    const batch: NormalizedBatch = {
      entities: [{ key: product }],
      observations: [],
      offers: [
        { product, sellerId: seller.toLowerCase(), sellerName: 'Rack House', buyBox: true },
        { product, sellerName: 'Amazon.com', buyBox: false },
      ],
    }
    const task = {
      kind: 'amazon-offers' as const,
      marketplace: 'amazon-us' as const,
      scope: { ids: [asin(1)] },
    }
    const first = await recordStoreListings(db, { task, batch, ids, observedOn: '2031-06-11' })
    expect(first.created).toEqual([
      { sellerKey: seller, productId: ids.get(`product:amazon-us:${asin(1)}`) },
    ])
    const again = await recordStoreListings(db, { task, batch, ids, observedOn: '2031-06-12' })
    expect(again.created).toEqual([])
    const [row] = await db
      .select()
      .from(storeListing)
      .where(and(eq(storeListing.sellerKey, seller), eq(storeListing.platform, 'amazon')))
    expect(row).toMatchObject({
      firstSeenOn: '2031-06-11',
      lastSeenOn: '2031-06-12',
      delistedOn: null,
      discovery: 'search-offer',
    })

    await recordStoreListings(db, {
      task,
      batch: { ...batch, offers: [{ product, sellerName: 'Amazon.com', buyBox: true }] },
      ids,
      observedOn: '2031-06-13',
    })
    const [gone] = await db.select().from(storeListing).where(eq(storeListing.sellerKey, seller))
    expect(gone?.delistedOn).toBe('2031-06-13')
  })

  it('eBay 卖家新品属于 scope 中的店铺；其他卖家的扫描不记录', async () => {
    const ids = await products([
      { platformId: `9${tag}1`, marketplace: 'ebay-us', listedAt: '2031-06-14T00:00:00Z' },
    ])
    const entity = {
      type: 'product' as const,
      marketplace: 'ebay-us' as const,
      platformId: `9${tag}1`,
    }
    const batch: NormalizedBatch = { entities: [{ key: entity }], observations: [] }
    const task = (sellerId: string) => ({
      kind: 'seller-new-listings' as const,
      marketplace: 'ebay-us' as const,
      scope: { sellerId, q: 'rack' },
    })
    expect(
      (
        await recordStoreListings(db, {
          task: task('someone-else'),
          batch,
          ids,
          observedOn: '2031-06-14',
        })
      ).created,
    ).toEqual([])
    expect(
      (
        await recordStoreListings(db, {
          task: task(ebaySeller.toUpperCase()),
          batch,
          ids,
          observedOn: '2031-06-14',
        })
      ).created,
    ).toHaveLength(1)
  })

  it('上架 10 天的新品进入 50+ bought：生成一条店铺新品出单线索，重复运行不重复生成', async () => {
    const ids = await products([
      { platformId: asin(2), marketplace: 'amazon-us', listedAt: '2031-06-10T00:00:00Z' },
      { platformId: asin(3), marketplace: 'amazon-us', listedAt: '2020-01-01T00:00:00Z' },
    ])
    const fresh = ids.get(`product:amazon-us:${asin(2)}`) as string
    const old = ids.get(`product:amazon-us:${asin(3)}`) as string
    await db.insert(storeListing).values(
      [fresh, old].map((productId) => ({
        platform: 'amazon' as const,
        sellerKey: seller,
        productId,
        firstSeenOn: '2031-06-12',
        lastSeenOn: '2031-06-19',
        discovery: 'search-offer' as const,
      })),
    )
    await bought(fresh, [{ on: '2031-06-20', low: 50, high: 100 }])
    // 老品同样出单，但不是店铺新品：不生成线索
    await bought(old, [{ on: '2031-06-20', low: 1000, high: 2000 }])

    const first = await evaluateStoreTracking(db, { day, now, workspaceId: ws })
    expect(first.failures).toEqual([])
    expect(first.workspaces[0]).toMatchObject({ leads: 1, leadsWithoutDirection: 0 })
    const events = await scoped(db, ws).select(leadEvent)
    const ours = events.filter((e) => e.payload.source === STORE_LEAD_SOURCE)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.payload).toMatchObject({ productId: fresh, sellerKey: seller })
    const [created] = await scoped(db, ws).select(lead, {
      where: eq(lead.id, ours[0]?.leadId as string),
    })
    expect(created).toMatchObject({ directionId, leadOn: day, status: 'new' })

    // 新品进入追踪并因出单升为热点；老品不进入追踪
    const tracked = await listTrackedProducts(db, ws)
    expect(tracked.find((t) => t.productId === fresh)).toMatchObject({
      tier: 'hot',
      origin: 'store',
    })
    expect(tracked.some((t) => t.productId === old)).toBe(false)

    const second = await evaluateStoreTracking(db, { day, now, workspaceId: ws })
    expect(second.workspaces[0]?.leads).toBe(0)
    expect(
      (await scoped(db, ws).select(leadEvent)).filter(
        (e) => e.payload.source === STORE_LEAD_SOURCE,
      ),
    ).toHaveLength(1)
  })

  it('普通档商品 bought 区间 7 天内上升 → 热点并记录原因；30 天无变化的热点降档', async () => {
    const ids = await products([
      { platformId: asin(4), marketplace: 'amazon-us' },
      { platformId: asin(5), marketplace: 'amazon-us' },
    ])
    const rising = ids.get(`product:amazon-us:${asin(4)}`) as string
    const stale = ids.get(`product:amazon-us:${asin(5)}`) as string
    await trackProduct(db, ws, { productId: rising, origin: 'manual' })
    await trackProduct(db, ws, { productId: stale, origin: 'manual', tier: 'hot' })
    await scoped(db, ws).update(
      trackedProduct,
      { tierChangedAt: new Date('2031-04-01T00:00:00Z') },
      inArray(trackedProduct.productId, [rising, stale]),
    )
    await bought(rising, [
      { on: '2031-06-10', low: 50, high: 100 },
      { on: '2031-06-18', low: 100, high: 200 },
    ])
    await bought(stale, [{ on: '2031-04-02', low: 100, high: 200 }])
    await evaluateStoreTracking(db, { day, now, workspaceId: ws })
    const tracked = await listTrackedProducts(db, ws)
    expect(tracked.find((t) => t.productId === rising)).toMatchObject({
      tier: 'hot',
      tierReason: 'bought-up',
    })
    expect(tracked.find((t) => t.productId === stale)).toMatchObject({
      tier: 'normal',
      tierReason: 'stale-30d',
    })

    // 热点每日快照：次日起进入快照计划
    const targets = await loadStoreCollectionTargets(db, {
      day: '2031-06-21',
      now,
      workspaceId: ws,
    })
    expect(targets.snapshots.find((s) => s.productId === rising)).toMatchObject({ tier: 'hot' })
    expect(targets.searches).toEqual([{ marketplace: 'amazon-us', keyword: 'spice rack' }])
  })

  it('被追踪商品不超过上限；样本不足的店铺指标为空', async () => {
    const before = (await listTrackedProducts(db, ws)).length
    const ids = await products(
      [6, 7].map((n) => ({ platformId: asin(n), marketplace: 'amazon-us' })),
    )
    await db.insert(storeListing).values(
      [...ids.values()].map((productId) => ({
        platform: 'amazon' as const,
        sellerKey: seller,
        productId,
        firstSeenOn: '2031-06-19',
        lastSeenOn: '2031-06-19',
        discovery: 'search-offer' as const,
      })),
    )
    const result = await evaluateStoreTracking(db, {
      day,
      now,
      workspaceId: ws,
      settings: { productCap: before + 1 },
    })
    expect(result.workspaces[0]).toMatchObject({ enrolled: 1, overCap: 1 })
    expect(await listTrackedProducts(db, ws)).toHaveLength(before + 1)
    // Amazon 店铺只有 1 个确认的新品：所有店铺指标都不写
    const sellerRows = await db
      .select({ id: marketplaceSeller.id })
      .from(marketplaceSeller)
      .where(eq(marketplaceSeller.platformId, seller))
    const metrics = sellerRows.length
      ? await db
          .select()
          .from(observation)
          .where(
            inArray(
              observation.entityId,
              sellerRows.map((r) => r.id),
            ),
          )
      : []
    expect(metrics).toEqual([])
  })
})
