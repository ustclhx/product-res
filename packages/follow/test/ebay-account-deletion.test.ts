import {
  auditLog,
  direction,
  directionSeller,
  leadEvent,
  marketplaceProduct,
  marketplaceSeller,
  observation,
  rawPayload,
  scoped,
  storeListing,
  syncRun,
  trackedStore,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteEbayUserData, EBAY_ACCOUNT_DELETION_ACTION, ebayUserHash } from '../src/index.ts'
import { cleanup, createWorkspace, insertProduct, testDb, url } from './helpers.ts'

// add-ebay-account-deletion 2.1：跨空间删除 / 匿名化某个 eBay 用户的数据，按 notificationId 去重。
// 只写入本测试生成的卖家与商品；Amazon 与其他 eBay 卖家的数据必须保持不变。
describe.skipIf(!url)('eBay 账号删除', () => {
  const db = testDb()
  const tag = newId().slice(-8).toLowerCase()
  // 店铺池中保存的是用户粘贴的大小写；通知中的用户名为小写，匹配不区分大小写
  const target = `Kitchen_${tag}`
  const other = `garden_${tag}`
  let wsA = ''
  let wsB = ''
  const productIds: string[] = []
  let targetProduct = ''
  let otherProduct = ''
  let amazonProduct = ''
  const sellerIds: string[] = []
  const syncIds: string[] = []
  const rawIds: string[] = []

  beforeAll(async () => {
    wsA = await createWorkspace(db, `EbayDelA${tag}`)
    wsB = await createWorkspace(db, `EbayDelB${tag}`)
    targetProduct = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `v1|${tag}1|0`,
      title: 'Rack',
      sellerId: target.toLowerCase(),
      firstSeenOn: '2031-01-01',
    })
    otherProduct = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `v1|${tag}2|0`,
      title: 'Shovel',
      sellerId: other,
      firstSeenOn: '2031-01-01',
    })
    // Amazon 卖家 ID 恰好与 eBay 用户名同名：不得受影响
    amazonProduct = await insertProduct(db, {
      marketplace: 'amazon-us',
      platformId: `B0${tag.toUpperCase()}`,
      title: 'Rack',
      sellerId: target.toLowerCase(),
      firstSeenOn: '2031-01-01',
    })
    productIds.push(targetProduct, otherProduct, amazonProduct)

    for (const ws of [wsA, wsB]) {
      await db.insert(trackedStore).values([
        {
          workspaceId: ws,
          platform: 'ebay',
          marketplace: 'ebay-us',
          sellerKey: target,
          kind: 'benchmark',
          url: `https://www.ebay.com/usr/${target}`,
        },
        {
          workspaceId: ws,
          platform: 'ebay',
          marketplace: 'ebay-us',
          sellerKey: other,
          kind: 'watch',
        },
        {
          workspaceId: ws,
          platform: 'amazon',
          marketplace: 'amazon-us',
          sellerKey: target.toLowerCase(),
          kind: 'watch',
        },
      ])
      const [dir] = await db
        .insert(direction)
        .values({ workspaceId: ws, name: `dir-${tag}`, marketplaces: ['ebay-us'] })
        .returning({ id: direction.id })
      await db.insert(directionSeller).values([
        {
          workspaceId: ws,
          directionId: dir?.id as string,
          marketplace: 'ebay-us',
          sellerPlatformId: target.toLowerCase(),
          status: 'accepted',
        },
        {
          workspaceId: ws,
          directionId: dir?.id as string,
          marketplace: 'ebay-us',
          sellerPlatformId: other,
          status: 'accepted',
        },
      ])
      await db.insert(leadEvent).values([
        {
          workspaceId: ws,
          kind: 'note',
          payload: { source: 'store', sellerKey: target, storeId: newId() },
        },
        { workspaceId: ws, kind: 'note', payload: { source: 'store', sellerKey: other } },
      ])
    }

    await db.insert(storeListing).values([
      {
        platform: 'ebay',
        sellerKey: target.toLowerCase(),
        productId: targetProduct,
        firstSeenOn: '2031-01-01',
        lastSeenOn: '2031-01-02',
        discovery: 'browse-seller',
      },
      {
        platform: 'ebay',
        sellerKey: other,
        productId: otherProduct,
        firstSeenOn: '2031-01-01',
        lastSeenOn: '2031-01-02',
        discovery: 'browse-seller',
      },
    ])

    const sellers = await db
      .insert(marketplaceSeller)
      .values([
        { marketplace: 'ebay-us', platformId: target.toLowerCase() },
        { marketplace: 'ebay-us', platformId: other },
        { marketplace: 'amazon-us', platformId: target.toLowerCase() },
      ])
      .returning({ id: marketplaceSeller.id })
    sellerIds.push(...sellers.map((s) => s.id))
    await db.insert(observation).values(
      sellerIds.map((entityId) => ({
        entityType: 'seller',
        entityId,
        metric: 'feedback_score',
        observedOn: '2031-01-02',
        sourceId: 'ebay-browse',
        value: 100,
        method: 'official' as const,
        tier: 1,
        fetchedAt: new Date('2031-01-02T00:00:00Z'),
      })),
    )

    const runs = await db
      .insert(syncRun)
      .values([
        {
          sourceId: 'ebay-browse',
          dataKind: 'seller-new-listings',
          marketplace: 'ebay-us',
          scope: { sellerId: target },
          trigger: 'scheduled',
          status: 'succeeded',
        },
        {
          sourceId: 'ebay-browse',
          dataKind: 'seller-new-listings',
          marketplace: 'ebay-us',
          scope: { sellerId: other },
          trigger: 'scheduled',
          status: 'succeeded',
        },
      ])
      .returning({ id: syncRun.id })
    syncIds.push(...runs.map((r) => r.id))
    const raws = await db
      .insert(rawPayload)
      .values(
        [target, other].map((seller) => ({
          sourceId: 'ebay-browse',
          task: {
            kind: 'seller-new-listings',
            marketplace: 'ebay-us',
            scope: { sellerId: seller },
          },
          request: {
            method: 'GET',
            url: `https://api.ebay.com/buy/browse/v1/item_summary/search?filter=sellers:{${seller}}`,
          },
          status: 200,
          bytes: 2,
          sha256: 'x',
          storage: 'db' as const,
          body: new Uint8Array([1, 2]),
          fetchedAt: new Date('2031-01-02T00:00:00Z'),
          expiresAt: new Date('2031-04-02T00:00:00Z'),
        })),
      )
      .returning({ id: rawPayload.id })
    rawIds.push(...raws.map((r) => r.id))
  })

  afterAll(async () => {
    await db.delete(rawPayload).where(inArray(rawPayload.id, rawIds))
    await db.delete(syncRun).where(inArray(syncRun.id, syncIds))
    await db.delete(observation).where(inArray(observation.entityId, sellerIds))
    await db.delete(marketplaceSeller).where(inArray(marketplaceSeller.id, sellerIds))
    await db.delete(storeListing).where(inArray(storeListing.productId, productIds))
    for (const ws of [wsA, wsB]) {
      await scoped(db, ws).delete(trackedStore, undefined)
      await cleanup(db, ws, ws === wsB ? productIds : [])
    }
  })

  const notificationId = `test-${tag}`

  it('删除所有空间中该用户的数据，其他卖家与 Amazon 数据不变；审计只记哈希', async () => {
    const result = await deleteEbayUserData(db, {
      notificationId,
      username: target.toLowerCase(),
      userId: `uid${tag}`,
      eventDate: '2031-01-03T00:00:00Z',
      publishAttemptCount: 1,
    })
    expect(result.status).toBe('processed')
    expect(result.counts).toMatchObject({
      trackedStores: 2,
      directionSellers: 2,
      storeListings: 1,
      sellers: 1,
      sellerObservations: 1,
      productsUnlinked: 1,
      leadEvents: 2,
      syncRuns: 1,
      rawPayloads: 1,
    })

    const stores = await db
      .select({ key: trackedStore.sellerKey, platform: trackedStore.platform })
      .from(trackedStore)
      .where(inArray(trackedStore.workspaceId, [wsA, wsB]))
    expect(stores.filter((s) => s.platform === 'ebay').map((s) => s.key)).toEqual([other, other])
    expect(stores.filter((s) => s.platform === 'amazon')).toHaveLength(2)

    const dirSellers = await db
      .select({ key: directionSeller.sellerPlatformId })
      .from(directionSeller)
      .where(inArray(directionSeller.workspaceId, [wsA, wsB]))
    expect(dirSellers.map((s) => s.key)).toEqual([other, other])

    const listings = await db
      .select({ key: storeListing.sellerKey })
      .from(storeListing)
      .where(inArray(storeListing.productId, productIds))
    expect(listings.map((l) => l.key)).toEqual([other])

    const sellers = await db
      .select({ id: marketplaceSeller.id, marketplace: marketplaceSeller.marketplace })
      .from(marketplaceSeller)
      .where(inArray(marketplaceSeller.id, sellerIds))
    expect(sellers.map((s) => s.marketplace).sort()).toEqual(['amazon-us', 'ebay-us'])
    const obs = await db
      .select({ id: observation.entityId })
      .from(observation)
      .where(inArray(observation.entityId, sellerIds))
    expect(obs).toHaveLength(2)

    const products = await db
      .select({ id: marketplaceProduct.id, sellerId: marketplaceProduct.sellerId })
      .from(marketplaceProduct)
      .where(inArray(marketplaceProduct.id, productIds))
    const sellerOf = new Map(products.map((p) => [p.id, p.sellerId]))
    expect(sellerOf.get(targetProduct)).toBeNull()
    expect(sellerOf.get(otherProduct)).toBe(other)
    expect(sellerOf.get(amazonProduct)).toBe(target.toLowerCase())

    const events = await db
      .select({ payload: leadEvent.payload })
      .from(leadEvent)
      .where(inArray(leadEvent.workspaceId, [wsA, wsB]))
    const keys = events.map((e) => e.payload.sellerKey ?? null)
    expect(keys.filter((k) => k === target)).toHaveLength(0)
    expect(keys.filter((k) => k === other)).toHaveLength(2)

    const runs = await db.select().from(syncRun).where(inArray(syncRun.id, syncIds))
    expect(runs.map((r) => r.scope.sellerId ?? null).sort()).toEqual([other, null].sort())

    const raws = await db.select().from(rawPayload).where(inArray(rawPayload.id, rawIds))
    const purged = raws.filter((r) => r.purgedAt !== null)
    expect(purged).toHaveLength(1)
    expect(purged[0]?.body).toBeNull()
    expect(JSON.stringify(purged[0]?.task)).not.toContain(target)
    expect(purged[0]?.request.url).not.toContain(target)

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, EBAY_ACCOUNT_DELETION_ACTION),
          eq(auditLog.targetId, notificationId),
        ),
      )
    expect(audits).toHaveLength(1)
    const meta = JSON.stringify(audits[0]?.meta)
    expect(meta).toContain(await ebayUserHash({ username: target }))
    expect(meta.toLowerCase()).not.toContain(target.toLowerCase())
  })

  it('同一 notificationId 重发：返回 duplicate，不再写审计', async () => {
    const again = await deleteEbayUserData(db, { notificationId, username: other })
    expect(again.status).toBe('duplicate')
    // 重复通知不会处理，即使正文中的用户不同
    const rows = await db
      .select({ id: trackedStore.id })
      .from(trackedStore)
      .where(and(inArray(trackedStore.workspaceId, [wsA, wsB]), eq(trackedStore.sellerKey, other)))
    expect(rows).toHaveLength(2)
    const audits = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.targetId, notificationId))
    expect(audits).toHaveLength(1)
  })

  it('并发重发只处理一次', async () => {
    const id = `test-concurrent-${tag}`
    const results = await Promise.all([
      deleteEbayUserData(db, { notificationId: id, username: `nobody_${tag}` }),
      deleteEbayUserData(db, { notificationId: id, username: `nobody_${tag}` }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['duplicate', 'processed'])
  })
})
