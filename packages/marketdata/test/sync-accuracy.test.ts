import {
  ConnectorError,
  type NormalizedBatch,
  type SourceConnector,
} from '@product-res/datasources'
import { dataSource, marketplaceReview } from '@product-res/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  createDbArchive,
  credentialStatus,
  getSource,
  productIds,
  readMetric,
  runSyncTask,
} from '../src/index.ts'
import { context, integration, testDb, uniqueId } from './helpers.ts'

const now = new Date('2026-10-20T08:00:00Z')

/** 模拟一个经 AIsa 的月度预算数据源：归一化结果固定，可指定抛出的错误 */
function fakeConnector(
  id: string,
  batch: (asin: string) => NormalizedBatch,
  fail?: ConnectorError,
): SourceConnector {
  return {
    id,
    label: id,
    access: 'api',
    marketplaces: ['amazon-us'],
    capabilities: ['amazon-asin'],
    budget: {
      unit: 'usd-micro',
      period: 'month',
      hardCap: 1_000_000,
      safetyLine: 900_000,
      timeZone: 'UTC',
      monthlyAllocation: 'first-come',
    },
    secrets: ['AISA_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    credentialSets: [['AISA_API_KEY'], ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']],
    queue: { concurrency: 1 },
    probe: async () => ({
      sourceId: id,
      checkedAt: now.toISOString(),
      credentials: 'valid',
      checks: [],
    }),
    plan: () => 6_000,
    async fetch(task, ctx) {
      if (fail) throw fail
      const asin = String((task.scope.ids as string[])[0])
      return {
        payloads: [
          {
            sourceId: id,
            task,
            request: { method: 'POST', url: 'https://api.aisa.one/apis/v1/dataforseo/x' },
            status: 200,
            body: JSON.stringify({ asin }),
            fetchedAt: ctx.now().toISOString(),
          },
        ],
        cost: 5_000,
      }
    },
    normalize: (payload) => batch(JSON.parse(payload.body).asin),
  }
}

describe('凭据组合', () => {
  const connector = fakeConnector('x', () => ({ entities: [], observations: [] }))
  it('任一组凭据齐全即不是“未配置”', () => {
    const only = (names: string[]) => (n: string) => (names.includes(n) ? 'v' : undefined)
    expect(credentialStatus(connector, only(['AISA_API_KEY']), undefined)).toBe('unverified')
    expect(
      credentialStatus(connector, only(['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']), undefined),
    ).toBe('unverified')
    expect(credentialStatus(connector, only(['DATAFORSEO_LOGIN']), undefined)).toBe('missing')
  })
})

describe.skipIf(!integration)('同步写入层级、渠道与评论（真实 Postgres）', () => {
  const db = testDb()
  const archive = createDbArchive(db)

  it('经 AIsa 写入 Amazon 价格观测：层级 T2、渠道 aisa；评论正文写入评论表', async () => {
    const id = uniqueId('dfs')
    const asin = uniqueId('B0')
    const key = { type: 'product' as const, marketplace: 'amazon-us' as const, platformId: asin }
    const connector = fakeConnector(id, () => ({
      entities: [{ key }],
      observations: [
        {
          entity: key,
          metric: 'price',
          observedOn: '2026-10-20',
          value: 31.48,
          currency: 'USD',
          method: 'official',
          tier: 2,
          channel: 'aisa',
        },
      ],
      reviews: [{ product: key, reviewId: 'R1', rating: 2, body: 'Broke after a week.' }],
    }))
    await db.insert(dataSource).values({ id, enabled: true })
    const outcome = await runSyncTask(
      { db, archive, ctx: context(now) },
      connector,
      { kind: 'amazon-asin', marketplace: 'amazon-us', scope: { ids: [asin] } },
      { mode: 'scheduled', trigger: 'scheduled' },
    )
    expect(outcome).toMatchObject({ status: 'succeeded', observations: 1 })
    const productId = (await productIds(db, 'amazon-us', [asin])).get(asin) as string
    const [point] = await readMetric(db, {
      entityType: 'product',
      entityId: productId,
      metric: 'price',
      marketplace: 'amazon-us',
    })
    expect(point?.primary).toMatchObject({ sourceId: id, tier: 2, channel: 'aisa', value: 31.48 })
    const reviews = await db
      .select()
      .from(marketplaceReview)
      .where(eq(marketplaceReview.productId, productId))
    expect(reviews).toEqual([expect.objectContaining({ reviewId: 'R1', rating: 2, sourceId: id })])
  })

  it('AIsa 余额不足（402）：月度预算的来源也只停到次日，不重试', async () => {
    const id = uniqueId('dfs')
    const connector = fakeConnector(
      id,
      () => ({ entities: [], observations: [] }),
      new ConnectorError('quota', 'AISA_402_BALANCE', { status: 402 }),
    )
    await db.insert(dataSource).values({ id, enabled: true })
    const outcome = await runSyncTask(
      { db, archive, ctx: context(now) },
      connector,
      { kind: 'amazon-asin', marketplace: 'amazon-us', scope: { ids: ['B0X'] } },
      { mode: 'scheduled', trigger: 'scheduled' },
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.error.retryable).toBe(false)
    const source = await getSource(db, id)
    expect(source?.pausedReason).toBe('quota')
    expect(source?.pausedUntil?.toISOString()).toBe('2026-10-21T00:00:00.000Z')
  })
})
