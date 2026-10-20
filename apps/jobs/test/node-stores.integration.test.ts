import {
  createRegistry,
  type FetchTask,
  type NormalizedBatch,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'
import {
  createDb,
  dataSource,
  jobMessage,
  jobQueue,
  marketplaceProduct,
  organization,
  rawPayload,
  scoped,
  storeListing,
  syncRun,
  trackedProduct,
  trackedStore,
} from '@product-res/db'
import { addStore, checkedOfferAsins } from '@product-res/follow'
import { ensureSources } from '@product-res/marketdata'
import type { DeadLetterSink, QueueBatch } from '@product-res/platform'
import { createNodeQueueProducer } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { and, eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createQueueDispatcher, type DailyMessage } from '../src/datasources/plan.ts'
import { consumeDataSync, DATASYNC_QUEUE, type DataSyncContext } from '../src/datasources/sync.ts'
import {
  createStoreBatchHook,
  dispatchStoreOffers,
  OFFER_KEY_PREFIX,
  runStoreTrackingRound,
} from '../src/stores/round.ts'

// add-accuracy-store-tracking tasks 3.2：店铺新品发现在真实 PG（Node 队列表）上验证，连接器为
// 本测试的假实现（与正式连接器同 ID），不发出任何外部请求。
const databaseUrl = process.env.TEST_JOB_DATABASE_URL
if (!databaseUrl) throw new Error('Isolated PG required')
const db = createDb(databaseUrl, { max: 3 })
afterAll(() => db.close())

const tag = newId().slice(-8).toUpperCase()
const seller = `A${tag}`
const keyword = `rack ${tag.toLowerCase()}`
const asins = Array.from({ length: 35 }, (_, i) => `B${tag}${String(i).padStart(2, '0')}`)
// 2031-07-01 10:00 新加坡时间
const now = new Date('2031-07-01T02:00:00Z')
const today = '2031-07-01'
const tomorrow = '2031-07-02'
const workspaceId = newId()

/** 假 DataForSEO：搜索返回 35 个 ASIN；报价把第一个 ASIN 归属到店铺 */
function fakeDataForSeo(): SourceConnector {
  return {
    id: 'dataforseo',
    label: 'fake',
    access: 'api',
    marketplaces: ['amazon-us'],
    capabilities: ['amazon-search', 'amazon-asin', 'amazon-offers'],
    budget: {
      unit: 'usd-micro',
      period: 'month',
      hardCap: 1_000_000_000,
      safetyLine: 900_000_000,
      timeZone: 'UTC',
      monthlyAllocation: 'first-come',
    },
    secrets: ['FAKE_DFS'],
    queue: { concurrency: 1 },
    probe: async () => ({
      sourceId: 'dataforseo',
      checkedAt: '',
      credentials: 'valid',
      checks: [],
    }),
    plan: () => 1,
    async fetch(task: FetchTask) {
      const payload: RawPayload = {
        sourceId: 'dataforseo',
        task,
        request: { method: 'POST', url: 'https://fake.invalid/' },
        status: 200,
        body: JSON.stringify(task),
        fetchedAt: now.toISOString(),
      }
      return { payloads: [payload], cost: 1 }
    },
    normalize(payload): NormalizedBatch {
      const task = payload.task
      const key = (id: string) => ({
        type: 'product' as const,
        marketplace: 'amazon-us' as const,
        platformId: id,
      })
      if (task.kind === 'amazon-search')
        return {
          entities: asins.map((id, i) => ({
            key: key(id),
            // 标题包含店铺显示名的排在前面
            facts: { title: i === 34 ? 'Rack House spice rack' : `generic ${id}` },
          })),
          observations: [],
        }
      const ids = (task.scope.ids as string[]) ?? []
      return {
        entities: ids.map((id) => ({ key: key(id) })),
        observations: [],
        offers: ids.map((id) => ({
          product: key(id),
          sellerId: id === asins[34] ? seller : 'SOMEONEELSE',
          buyBox: true,
        })),
      }
    },
  }
}

/** 假 eBay：凭据未配置（secret 不返回 FAKE_EBAY） */
const fakeEbay: SourceConnector = {
  ...fakeDataForSeo(),
  id: 'ebay-browse',
  marketplaces: ['ebay-us'],
  capabilities: ['seller-new-listings', 'product-snapshot'],
  secrets: ['FAKE_EBAY'],
}

const registry = createRegistry([fakeDataForSeo(), fakeEbay])
const context: DataSyncContext = {
  db,
  registry,
  secret: (name) => (name === 'FAKE_DFS' ? 'fixture' : undefined),
  now: () => now,
  dispatcher: createQueueDispatcher(
    db,
    DATASYNC_QUEUE,
    createNodeQueueProducer<DailyMessage['body']>(db, DATASYNC_QUEUE).producer,
  ),
  onBatch: (message, input) => hook(message, input),
}
const hook = createStoreBatchHook(context)
const sink = { failed: vi.fn(async () => {}) } as unknown as DeadLetterSink<unknown>

async function consume(bodies: unknown[]) {
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    body,
    attempts: 1,
    timestamp: now,
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  await consumeDataSync(
    { queue: DATASYNC_QUEUE, messages, ackAll() {}, retryAll() {} } as QueueBatch<unknown>,
    context,
    sink,
  )
  return messages
}

const ours = () =>
  db
    .select()
    .from(jobMessage)
    .where(
      and(
        eq(jobMessage.queue, DATASYNC_QUEUE),
        inArray(
          jobMessage.idempotencyKey,
          [today, tomorrow].flatMap((d) =>
            asins.map((a) => `${OFFER_KEY_PREFIX}:${d}:amazon-us:${a}`),
          ),
        ),
      ),
    )

describe('店铺新品发现（mock 连接器）', () => {
  let insertedQueue = false
  let previous: (typeof dataSource.$inferSelect)[] = []
  let storeId = ''

  beforeAll(async () => {
    insertedQueue =
      (
        await db
          .insert(jobQueue)
          .values({ name: DATASYNC_QUEUE, policy: { maxRetries: 5 } })
          .onConflictDoNothing()
          .returning({ name: jobQueue.name })
      ).length > 0
    await ensureSources(db, registry.all())
    previous = await db
      .select()
      .from(dataSource)
      .where(inArray(dataSource.id, ['dataforseo', 'ebay-browse']))
    await db
      .update(dataSource)
      .set({ enabled: true, pausedReason: null, pausedUntil: null, config: {} })
      .where(inArray(dataSource.id, ['dataforseo', 'ebay-browse']))
    await db.insert(organization).values({
      id: workspaceId,
      name: 'Stores',
      slug: `stores-${tag.toLowerCase()}`,
      isPersonal: false,
    })
    storeId = (
      await addStore(db, workspaceId, {
        url: `https://www.amazon.com/sp?seller=${seller}`,
        kind: 'benchmark',
        keywords: [keyword],
        displayName: 'Rack House',
      })
    ).store.id
    await addStore(db, workspaceId, {
      url: `https://www.ebay.com/usr/ebay_${tag.toLowerCase()}`,
      kind: 'watch',
      keywords: ['rack'],
    })
  })

  afterAll(async () => {
    await db
      .delete(jobMessage)
      .where(and(eq(jobMessage.queue, DATASYNC_QUEUE), like(jobMessage.idempotencyKey, `%${tag}%`)))
    // 假连接器的同步记录与存档（开始时间固定为 now）
    const runs = await db
      .select({ id: syncRun.id })
      .from(syncRun)
      .where(and(eq(syncRun.sourceId, 'dataforseo'), eq(syncRun.startedAt, now)))
    if (runs.length > 0) {
      const ids = runs.map((r) => r.id)
      await db.delete(rawPayload).where(inArray(rawPayload.runId, ids))
      await db.delete(syncRun).where(inArray(syncRun.id, ids))
    }
    if (insertedQueue) await db.delete(jobQueue).where(eq(jobQueue.name, DATASYNC_QUEUE))
    for (const row of previous)
      await db
        .update(dataSource)
        .set({
          enabled: row.enabled,
          pausedReason: row.pausedReason,
          pausedUntil: row.pausedUntil,
          config: row.config,
        })
        .where(eq(dataSource.id, row.id))
    const s = scoped(db, workspaceId)
    await s.delete(trackedProduct, undefined)
    await s.delete(trackedStore, undefined)
    await db.delete(marketplaceProduct).where(inArray(marketplaceProduct.platformId, asins))
    await db.delete(organization).where(eq(organization.id, workspaceId))
  })

  it('手动一轮：Amazon 店铺按搜索词投递搜索；eBay 来源未配置时跳过，不阻塞 Amazon', async () => {
    const summary = await runStoreTrackingRound(context, {
      scheduledAt: now,
      workspaceId,
      manual: true,
      requestId: tag,
    })
    expect(summary.skipped).toMatchObject({ 'ebay-browse': 'credentials-missing' })
    expect(summary.unavailable).toMatchObject({ 'ebay-browse': 1 })
    const rows = await db
      .select()
      .from(jobMessage)
      .where(
        and(
          eq(jobMessage.queue, DATASYNC_QUEUE),
          like(jobMessage.idempotencyKey, `store-tracking:manual:${tag}:%`),
        ),
      )
    expect(rows.map((r) => r.body)).toEqual([
      expect.objectContaining({
        sourceId: 'dataforseo',
        task: { kind: 'amazon-search', marketplace: 'amazon-us', scope: { keyword } },
        mode: 'manual',
        origin: 'store-tracking',
      }),
    ])
  })

  it('搜索结果的新 ASIN 投递报价：每日上限 30，超出顺延到次日；已排队的不重复', async () => {
    const [search] = await db
      .select()
      .from(jobMessage)
      .where(
        and(
          eq(jobMessage.queue, DATASYNC_QUEUE),
          like(jobMessage.idempotencyKey, `store-tracking:manual:${tag}:%`),
        ),
      )
    const [message] = await consume([search?.body])
    expect(message?.ack).toHaveBeenCalled()
    const queued = await ours()
    const byDay = (day: string) =>
      queued.filter((r) => r.idempotencyKey?.startsWith(`${OFFER_KEY_PREFIX}:${day}:`))
    expect(byDay(today)).toHaveLength(30)
    expect(byDay(tomorrow)).toHaveLength(5)
    // 标题含店铺显示名的 ASIN 优先进入当天
    expect(byDay(today).some((r) => r.idempotencyKey?.endsWith(asins[34] as string))).toBe(true)
    // 次日的任务在次日 03:30（SGT，即 19:30 UTC）之后可执行：延迟 17.5 小时（队列按真实时钟写入）
    const delayed = byDay(tomorrow)[0]
    const delay =
      ((delayed?.availableAt?.getTime() ?? 0) - (delayed?.createdAt?.getTime() ?? 0)) / 1000
    expect(Math.abs(delay - 17.5 * 3600)).toBeLessThan(60)
    expect(
      byDay(today).every(
        (r) => (r.availableAt?.getTime() ?? 0) - (r.createdAt?.getTime() ?? 0) < 60_000,
      ),
    ).toBe(true)

    const again = await dispatchStoreOffers(context, { marketplace: 'amazon-us', asins, now })
    expect(again.enqueued).toBe(0)
    expect(await ours()).toHaveLength(35)
  })

  it('报价命中店铺写入 store_listing（search-offer）；其他卖家不记录', async () => {
    const queued = await ours()
    const target = queued.find((r) => r.idempotencyKey?.endsWith(asins[34] as string))
    const other = queued.find((r) => r.idempotencyKey?.endsWith(asins[0] as string))
    await consume([target?.body, other?.body])
    const rows = await db
      .select({ productId: storeListing.productId, discovery: storeListing.discovery })
      .from(storeListing)
      .where(eq(storeListing.sellerKey, seller))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.discovery).toBe('search-offer')
    // 查过报价的 ASIN 记为已检查，之后的搜索结果不再投递
    expect(
      await checkedOfferAsins(db, 'amazon-us', [asins[34], asins[0], asins[1]] as string[]),
    ).toEqual(new Set([asins[34], asins[0]]))
    expect(storeId).toBeTruthy()
  })
})
