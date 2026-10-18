import { createKeepaConnector } from '@product-res/connectors'
import type { ConnectorContext } from '@product-res/datasources'
import {
  budgetLedger,
  cluster,
  clusterMember,
  dataSource,
  direction,
  rawPayload,
  recommendation,
  recommendationLabel,
  scoped,
  seasonalNode,
  sourceBudget,
  syncRun,
} from '@product-res/db'
import { createDbArchive, effectiveBudget, reserve } from '@product-res/marketdata'
import { addDays } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  getValidationOverview,
  listReplays,
  type ReplayMessage,
  runReplayStep,
  startReplay,
} from '../src/index.ts'
import { cleanup, createWorkspace, insertProduct, testDb, url } from './helpers.ts'

// tasks 3.1：Keepa 历史回放。额度用真实 PG 账本；Keepa 响应用夹具（csv 与 monthlySoldHistory），不发真实请求
const db = testDb()
const archive = createDbArchive(db)
const tag = newId().slice(-10)
const now = new Date('2031-09-01T00:00:00Z')
const nodeDate = '2031-07-01'
const frozenOn = '2031-06-01'
const keepa = { ...createKeepaConnector(), id: `keepa-test-${tag}` }
const asins = [`B0A${tag}`, `B0B${tag}`]
const productIds: string[] = []
let workspaceId = ''
let directionId = ''

/** Keepa 时间 = 自 2011-01-01 起的分钟数 */
const keepaTime = (day: string) => Date.parse(`${day}T12:00:00Z`) / 60_000 - 21_564_000

/** 2031-04-01 至 2031-08-15 每天：价格 $20.00、BSR 5000、3 个卖家、月销量 900 */
function keepaFixture(ids: readonly string[]) {
  const days: string[] = []
  for (let d = '2031-04-01'; d <= '2031-08-15'; d = addDays(d, 1)) days.push(d)
  const series = (value: number) => days.flatMap((d) => [keepaTime(d), value])
  return {
    products: ids.map((asin) => {
      const csv: (number[] | null)[] = Array(20).fill(null)
      csv[1] = series(2000)
      csv[3] = series(5000)
      csv[11] = series(3)
      return { asin, title: `Seat organizer ${asin}`, csv, monthlySoldHistory: series(900) }
    }),
  }
}

function context(
  at: Date,
  options: { key?: boolean; fetch?: typeof fetch } = {},
): ConnectorContext {
  return {
    fetch:
      options.fetch ??
      ((() => {
        throw new Error('network disabled in tests')
      }) as unknown as typeof fetch),
    secret: (name) => (options.key !== false && name === 'KEEPA_API_KEY' ? 'test-key' : undefined),
    now: () => at,
  }
}

const fixtureFetch = () =>
  vi.fn(async (input: string | URL | Request) => {
    const ids = new URL(String(input)).searchParams.get('asin')?.split(',') ?? []
    return new Response(JSON.stringify(keepaFixture(ids)), { status: 200 })
  })

const parentOf = async (replayId: string) =>
  (await db.select().from(syncRun).where(eq(syncRun.id, replayId)))[0]

describe.skipIf(!url)('Keepa 历史回放', () => {
  const sent: ReplayMessage[] = []
  const queue = {
    send: async (body: ReplayMessage) => {
      sent.push(body)
    },
  }

  beforeAll(async () => {
    workspaceId = await createWorkspace(db, 'Replay')
    const s = scoped(db, workspaceId)
    const [node] = await s
      .insert(seasonalNode, {
        name: `夏季-${tag}`,
        startMonth: 8,
        startDay: 1,
        salesDays: 30,
        keywords: [],
      })
      .returning()
    const [row] = await s
      .insert(direction, {
        name: 'Amazon 回放',
        marketplaces: ['amazon-us'],
        categoryIds: [`cat-${tag}`],
        nodeIds: [node?.id as string],
      })
      .returning()
    directionId = row?.id as string
    for (const asin of asins) {
      productIds.push(
        await insertProduct(db, {
          marketplace: 'amazon-us',
          platformId: asin,
          title: `Seat organizer ${asin}`,
          categoryId: `cat-${tag}`,
          firstSeenOn: '2031-08-30',
        }),
      )
    }
    const [c] = await s
      .insert(cluster, {
        directionId,
        marketplace: 'amazon-us',
        representativeProductId: productIds[0] as string,
        name: '座椅收纳',
      })
      .returning()
    await s.insert(
      clusterMember,
      productIds.map((productId) => ({
        clusterId: c?.id as string,
        productId,
        method: 'platform-id' as const,
        confidence: 1,
      })),
    )
    await db.insert(dataSource).values({ id: keepa.id, enabled: true })
  })

  afterAll(async () => {
    if (!url) return
    const replayRuns = await db
      .select({ id: syncRun.id })
      .from(syncRun)
      .where(sql`${syncRun.scope}->>'workspaceId' = ${workspaceId}`)
    const runIds = replayRuns.map((r) => r.id)
    if (runIds.length > 0) await db.delete(rawPayload).where(inArray(rawPayload.runId, runIds))
    await db
      .delete(syncRun)
      .where(
        or(eq(syncRun.sourceId, keepa.id), sql`${syncRun.scope}->>'workspaceId' = ${workspaceId}`),
      )
    await db.delete(budgetLedger).where(eq(budgetLedger.sourceId, keepa.id))
    await db.delete(sourceBudget).where(eq(sourceBudget.sourceId, keepa.id))
    await db.delete(dataSource).where(eq(dataSource.id, keepa.id))
    await cleanup(db, workspaceId, productIds)
  })

  it('发起回放：按商品预估 token，节点后数据不足 14 天时拒绝', async () => {
    await expect(
      startReplay(db, queue, {
        workspaceId,
        directionId,
        nodeDate: '2031-08-25',
        beforeDays: 1,
        now,
      }),
    ).rejects.toThrow('至少 14 天')
    const started = await startReplay(db, queue, {
      workspaceId,
      directionId,
      nodeDate,
      beforeDays: 30,
      now,
    })
    expect(started).toMatchObject({ frozenOn, products: 2, estimatedTokens: 2 })
    expect(sent.at(-1)).toEqual({ v: 1, replayId: started.replayId, workspaceId })
    expect((await listReplays(db, workspaceId))[0]).toMatchObject({
      replayId: started.replayId,
      status: 'queued',
      estimatedTokens: 2,
    })
  })

  it('没有凭据：任务失败并记录原因，不预扣额度', async () => {
    const message = sent.at(-1) as ReplayMessage
    const other = await startReplay(db, queue, {
      workspaceId,
      directionId,
      nodeDate,
      beforeDays: 31,
      now,
    })
    const result = await runReplayStep(
      { db, connector: keepa, archive, ctx: context(now, { key: false }) },
      { v: 1, replayId: other.replayId, workspaceId },
    )
    expect(result).toEqual({ status: 'failed', code: 'KEEPA_API_KEY_MISSING' })
    expect(await parentOf(other.replayId)).toMatchObject({
      status: 'failed',
      errorCode: 'KEEPA_API_KEY_MISSING',
    })
    const ledger = await db.select().from(budgetLedger).where(eq(budgetLedger.sourceId, keepa.id))
    expect(ledger).toHaveLength(0)
    expect(message.replayId).not.toBe(other.replayId)
  })

  it('额度不足顺延到额度恢复，不超额调用；恢复后取历史、冻结 replay 推荐并用节点后的序列打标签', async () => {
    const message = sent[0] as ReplayMessage
    // 本分钟的 20 token 已被其他任务用完
    const spec = effectiveBudget(keepa, undefined)
    const held = await reserve(db, {
      sourceId: keepa.id,
      spec,
      amount: spec.hardCap,
      mode: 'manual',
      now,
    })
    expect(held.ok).toBe(true)
    const blockedFetch = fixtureFetch()
    const deferred = await runReplayStep(
      { db, connector: keepa, archive, ctx: context(now, { fetch: blockedFetch }) },
      message,
    )
    expect(deferred).toMatchObject({ status: 'deferred', reason: 'BUDGET_HARD_CAP' })
    expect(deferred.status === 'deferred' && deferred.retryAt > now).toBe(true)
    expect(blockedFetch).not.toHaveBeenCalled()
    expect(await parentOf(message.replayId)).toMatchObject({
      status: 'deferred',
      errorCode: 'BUDGET_HARD_CAP',
    })
    expect(
      (await listReplays(db, workspaceId)).find((r) => r.replayId === message.replayId),
    ).toMatchObject({
      status: 'deferred',
    })

    // 下一分钟额度恢复
    const later = new Date(now.getTime() + 61_000)
    const fetchMock = fixtureFetch()
    const done = await runReplayStep(
      { db, connector: keepa, archive, ctx: context(later, { fetch: fetchMock }) },
      message,
    )
    expect(done).toMatchObject({ status: 'done', recommendations: 1, labels: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(requested.searchParams.get('history')).toBe('1')
    expect(requested.searchParams.get('asin')?.split(',').sort()).toEqual([...asins].sort())

    const s = scoped(db, workspaceId)
    const recs = await s.select(recommendation, { where: eq(recommendation.sampleKind, 'replay') })
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      frozenOn,
      leadId: null,
      marketplace: 'amazon-us',
      settingVersion: 1,
    })
    expect(recs[0]?.inputs).toMatchObject({ replayId: message.replayId, nodeDate, beforeDays: 30 })
    const labels = await s.select(recommendationLabel, {
      where: eq(recommendationLabel.recommendationId, recs[0]?.id as string),
    })
    // 每个成员月销量 900 → 日均 30 件、簇 60 件，价格不变：三个窗口都命中；销量来源为月销量估算
    expect(labels.map((l) => [l.windowDays, l.outcome]).sort()).toEqual([
      [14, 'hit'],
      [30, 'hit'],
      [60, 'hit'],
    ])
    const t30 = labels.find((l) => l.windowDays === 30)
    expect(t30).toMatchObject({ salesDelta: 1800, priceDropRate: 0 })
    expect(t30?.sources).toMatchObject({
      salesMetrics: ['sales_estimate_monthly'],
      salesSources: [keepa.id],
    })

    // 额度：预扣 2 + 先前占用 20，分属两个分钟周期，均不超过硬上限
    const budgets = await db.select().from(sourceBudget).where(eq(sourceBudget.sourceId, keepa.id))
    for (const b of budgets) expect(b.reserved + b.settled).toBeLessThanOrEqual(spec.hardCap)

    // 重复投递幂等：已完成的回放不再请求
    const again = vi.fn()
    expect(
      await runReplayStep(
        {
          db,
          connector: keepa,
          archive,
          ctx: context(later, { fetch: again as unknown as typeof fetch }),
        },
        message,
      ),
    ).toMatchObject({ status: 'done' })
    expect(again).not.toHaveBeenCalled()

    const overview = await getValidationOverview(db, workspaceId, { now: later })
    expect(overview.replays.find((r) => r.replayId === message.replayId)).toMatchObject({
      status: 'succeeded',
      fetchedProducts: 2,
      recommendations: 1,
    })
    expect(overview.composition).toMatchObject({
      recommendations: { replay: 1 },
      labeled: { replay: 1 },
    })
    const replayChunks = await db
      .select()
      .from(syncRun)
      .where(
        and(
          eq(syncRun.sourceId, keepa.id),
          sql`${syncRun.scope}->>'replayId' = ${message.replayId}`,
        ) as SQL,
      )
    expect(replayChunks.map((r) => r.status).sort()).toEqual(['deferred', 'succeeded'])
  })
})
