import {
  cluster,
  clusterMember,
  createDb,
  dataSource,
  direction,
  directionSeller,
  jobMessage,
  jobQueue,
  marketplaceProduct,
  organization,
  scoped,
} from '@product-res/db'
import { ensureSources } from '@product-res/marketdata'
import { createNodeQueueProducer } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { and, eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createQueueDispatcher,
  DAILY_KEY_PREFIX,
  type DailyMessage,
  dispatchDailyCollections,
  isWeeklyRun,
} from '../src/datasources/plan.ts'
import {
  createConnectorRegistry,
  DATASYNC_QUEUE,
  type DataSyncContext,
} from '../src/datasources/sync.ts'

// tasks.md 3.2：每日采集投递在真实 PG（Node 队列表）上验证；使用真实连接器的 plan() 估算，
// 但不消费队列，不发出任何外部请求。
const databaseUrl = process.env.TEST_JOB_DATABASE_URL
if (!databaseUrl) throw new Error('Isolated PG required')
const db = createDb(databaseUrl, { max: 3 })
afterAll(() => db.close())

const tag = newId().slice(-10)
// 2031-06-02 是周一；02:00 新加坡时间 = 前一天 18:00 UTC
const monday = new Date('2031-06-01T18:00:00Z')
const tuesday = new Date('2031-06-02T18:00:00Z')
const SOURCES = ['ebay-browse', 'keepa', 'dataforseo']
const workspaceId = newId()
const productIds: string[] = []
let previous: (typeof dataSource.$inferSelect)[] = []

const registry = createConnectorRegistry()
const context = (now: Date): DataSyncContext => ({
  db,
  registry,
  // 只用于判断“凭据已配置”；不会真正调用外部接口
  secret: () => 'fixture',
  now: () => now,
  dispatcher: createQueueDispatcher(
    db,
    DATASYNC_QUEUE,
    createNodeQueueProducer<DailyMessage['body']>(db, DATASYNC_QUEUE).producer,
  ),
})

async function ours(day: string) {
  const rows = await db
    .select()
    .from(jobMessage)
    .where(
      and(
        eq(jobMessage.queue, DATASYNC_QUEUE),
        like(jobMessage.idempotencyKey, `${DAILY_KEY_PREFIX}:${day}:%`),
      ),
    )
  return rows.filter((r) => JSON.stringify(r.body).includes(tag))
}

describe('每日采集投递', () => {
  beforeAll(async () => {
    await db
      .insert(jobQueue)
      .values({ name: DATASYNC_QUEUE, policy: { maxRetries: 5 } })
      .onConflictDoNothing()
    await ensureSources(db, registry.all())
    previous = await db.select().from(dataSource).where(inArray(dataSource.id, SOURCES))
    await db
      .update(dataSource)
      .set({ enabled: true, pausedReason: null, pausedUntil: null })
      .where(inArray(dataSource.id, ['ebay-browse', 'dataforseo']))
    // Keepa 停用：Amazon 商品的快照跳过并记录
    await db.update(dataSource).set({ enabled: false }).where(eq(dataSource.id, 'keepa'))

    await db.insert(organization).values({
      id: workspaceId,
      name: 'Collect',
      slug: `collect-${tag}`,
      isPersonal: false,
    })
    const s = scoped(db, workspaceId)
    const [on] = await s
      .insert(direction, {
        name: `启用-${tag}`,
        marketplaces: ['ebay-us'],
        categoryIds: [`cat-${tag}`],
        keywords: [`kw ${tag}`],
      })
      .returning()
    const [off] = await s
      .insert(direction, {
        name: `停用-${tag}`,
        marketplaces: ['ebay-us'],
        categoryIds: [`off-${tag}`],
        keywords: [`off ${tag}`],
        enabled: false,
      })
      .returning()
    await s.insert(directionSeller, [
      {
        directionId: on?.id as string,
        marketplace: 'ebay-us',
        sellerPlatformId: `seed-${tag}`,
        status: 'seed',
      },
      {
        directionId: off?.id as string,
        marketplace: 'ebay-us',
        sellerPlatformId: `off-${tag}`,
        status: 'seed',
      },
    ])
    const products = await db
      .insert(marketplaceProduct)
      .values([
        { marketplace: 'ebay-us', platformId: `item-${tag}`, title: 'Spice Rack' },
        { marketplace: 'amazon-us', platformId: `B-${tag}`, title: 'Spice Rack' },
      ])
      .returning({ id: marketplaceProduct.id })
    productIds.push(...products.map((p) => p.id))
    const [c] = await s
      .insert(cluster, { directionId: on?.id as string, marketplace: 'ebay-us', name: 'c' })
      .returning()
    await s.insert(
      clusterMember,
      productIds.map((productId) => ({
        clusterId: c?.id as string,
        productId,
        method: 'manual' as const,
        confidence: 1,
      })),
    )
  })

  afterAll(async () => {
    await db
      .delete(jobMessage)
      .where(
        and(
          eq(jobMessage.queue, DATASYNC_QUEUE),
          like(jobMessage.idempotencyKey, `${DAILY_KEY_PREFIX}:2031-06-0%`),
        ),
      )
    for (const row of previous)
      await db
        .update(dataSource)
        .set({
          enabled: row.enabled,
          pausedReason: row.pausedReason,
          pausedUntil: row.pausedUntil,
        })
        .where(eq(dataSource.id, row.id))
    const s = scoped(db, workspaceId)
    await s.delete(clusterMember, undefined)
    await s.delete(cluster, undefined)
    await s.delete(directionSeller, undefined)
    await s.delete(direction, undefined)
    await db.delete(marketplaceProduct).where(inArray(marketplaceProduct.id, productIds))
    await db.delete(organization).where(eq(organization.id, workspaceId))
  })

  it('周一：投递卖家新品、快照与关键词任务；停用方向与停用数据源不生成', async () => {
    expect(isWeeklyRun(monday)).toBe(true)
    const result = await dispatchDailyCollections(context(monday), monday)
    expect(result.day).toBe('2031-06-02')
    expect(result.skipped).toMatchObject({ keepa: 'disabled' })
    expect(result.plan.unavailable.keepa).toBeGreaterThanOrEqual(1)
    const rows = await ours('2031-06-02')
    const bodies = rows.map((r) => r.body as DailyMessage['body'])
    expect(
      bodies
        .map((b) => [b.sourceId, b.task.kind, b.mode, b.trigger])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['dataforseo', 'keyword-volume', 'scheduled', 'scheduled'],
      ['dataforseo', 'search-trend', 'scheduled', 'scheduled'],
      ['ebay-browse', 'product-snapshot', 'scheduled', 'scheduled'],
      ['ebay-browse', 'seller-new-listings', 'scheduled', 'scheduled'],
    ])
    const seller = bodies.find((b) => b.task.kind === 'seller-new-listings')
    expect(seller?.task.scope).toEqual({ sellerId: `seed-${tag}`, categoryIds: `cat-${tag}` })
    expect(bodies.some((b) => JSON.stringify(b).includes(`off-${tag}`))).toBe(false)
    // 时间表：卖家新品 02:10、快照 02:30
    const at = (kind: string) =>
      rows.find((r) => (r.body as DailyMessage['body']).task.kind === kind)?.availableAt.getTime()
    expect(Math.round(((at('seller-new-listings') ?? 0) - Date.now()) / 60_000)).toBeGreaterThan(0)
    expect(((at('product-snapshot') ?? 0) - (at('seller-new-listings') ?? 0)) / 60_000).toBeCloseTo(
      20,
      0,
    )
  })

  it('同一天重复触发（重启 / 补跑）不重复投递', async () => {
    const before = await ours('2031-06-02')
    const again = await dispatchDailyCollections(context(monday), monday)
    expect(again.enqueued).toBe(0)
    expect(again.duplicates).toBe(again.plan.tasks.length)
    expect(await ours('2031-06-02')).toHaveLength(before.length)
  })

  it('非周一不生成关键词任务', async () => {
    expect(isWeeklyRun(tuesday)).toBe(false)
    const result = await dispatchDailyCollections(context(tuesday), tuesday)
    expect(result.weekly).toBe(false)
    const bodies = (await ours('2031-06-03')).map((r) => r.body as DailyMessage['body'])
    expect(bodies.map((b) => b.sourceId)).not.toContain('dataforseo')
    expect(bodies.map((b) => b.task.kind).sort()).toEqual([
      'product-snapshot',
      'seller-new-listings',
    ])
  })
})
