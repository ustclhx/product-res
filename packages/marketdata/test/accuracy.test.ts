import { amazonBoughtInterval } from '@product-res/datasources'
import { organization, sourceQualification, trackedProduct } from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  listTrackedProducts,
  loadDisqualified,
  rankValues,
  readMetric,
  readMetrics,
  setPriority,
  setSourceQualification,
  setTrackedProductTier,
  trackProduct,
  upsertEntities,
  upsertObservations,
} from '../src/index.ts'
import { integration, testDb, uniqueId } from './helpers.ts'

const now = new Date('2026-10-20T08:00:00Z')
const marketplace = 'amazon-us' as const

describe('主值规则（纯函数）', () => {
  const at = (iso: string) => new Date(iso)
  it('先比层级，同层级按优先级，再按获取时间；失去资格的排最后', () => {
    const values = [
      { sourceId: 'b', method: 'official' as const, tier: 2, fetchedAt: at('2026-10-20T02:00Z') },
      { sourceId: 'a', method: 'official' as const, tier: 2, fetchedAt: at('2026-10-20T01:00Z') },
      { sourceId: 'c', method: 'estimate' as const, fetchedAt: at('2026-10-20T03:00Z') },
      { sourceId: 'd', method: 'official' as const, tier: 1, fetchedAt: at('2026-10-20T00:00Z') },
      {
        sourceId: 'e',
        method: 'official' as const,
        tier: 0,
        disqualified: true,
        fetchedAt: at('2026-10-20T00:00Z'),
      },
    ]
    expect(rankValues(values, ['a', 'b']).map((v) => v.sourceId)).toEqual(['d', 'a', 'b', 'c', 'e'])
  })

  it('未给层级时按获取方式推出（import 为 T2，排在官方 T1 之后）', () => {
    const values = [
      { sourceId: 'imp', method: 'import' as const, fetchedAt: now },
      { sourceId: 'off', method: 'official' as const, fetchedAt: now },
    ]
    expect(rankValues(values, ['imp', 'off'])[0]?.sourceId).toBe('off')
  })
})

describe.skipIf(!integration)('观测分级、区间与主值（真实 Postgres）', () => {
  const db = testDb()
  const metric = uniqueId('m').replace(/-/g, '_')
  const touchedSources: string[] = []

  afterAll(async () => {
    if (touchedSources.length > 0)
      await db
        .delete(sourceQualification)
        .where(inArray(sourceQualification.sourceId, touchedSources))
  })

  async function product() {
    const key = { type: 'product' as const, marketplace, platformId: uniqueId('B0') }
    const ids = await upsertEntities(db, [{ key }])
    return { key, ids, entityId: ids.get(`product:${marketplace}:${key.platformId}`) as string }
  }

  it('官方值与页面展示值并存：主值取 T1，T2 并列返回（含层级与渠道）', async () => {
    const { key, ids, entityId } = await product()
    const official = uniqueId('official')
    const page = uniqueId('page')
    const base = { entity: key, metric, observedOn: '2026-10-20', currency: 'USD' }
    // 页面展示值的来源优先级更高，但层级低于官方值
    await setPriority(db, marketplace, metric, [page, official])
    await upsertObservations(
      db,
      [{ ...base, value: 19.5, method: 'official', tier: 2, channel: 'aisa' }],
      ids,
      { sourceId: page, fetchedAt: now },
    )
    await upsertObservations(db, [{ ...base, value: 19.99, method: 'official' }], ids, {
      sourceId: official,
      fetchedAt: now,
    })
    const [point] = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(point?.primary).toMatchObject({ sourceId: official, value: 19.99, tier: 1 })
    expect(point?.values.map((v) => [v.sourceId, v.tier, v.channel])).toEqual([
      [official, 1, null],
      [page, 2, 'aisa'],
    ])
  })

  it('区间值：保存下界、上界与对数中点，读取时一并返回；缺失不写', async () => {
    const { key, ids, entityId } = await product()
    const source = uniqueId('dfs')
    const interval = amazonBoughtInterval(100)
    await upsertObservations(
      db,
      [
        {
          entity: key,
          metric,
          observedOn: '2026-10-20',
          method: 'official',
          tier: 2,
          ...interval,
        },
      ],
      ids,
      { sourceId: source, fetchedAt: now },
    )
    const [point] = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(point?.primary).toMatchObject({ valueLow: 100, valueHigh: 200, tier: 2 })
    expect(point?.primary.value).toBeCloseTo(Math.sqrt(100 * 200), 4)
    expect(
      await readMetric(db, {
        entityType: 'product',
        entityId,
        metric: 'bought_month',
        marketplace,
      }),
    ).toEqual([])
  })

  it('失去主值资格的来源被跳过；只有它有值时仍返回并标记', async () => {
    const { key, ids, entityId } = await product()
    const good = uniqueId('good')
    const bad = uniqueId('bad')
    touchedSources.push(bad)
    const base = { entity: key, metric, method: 'official' as const, tier: 2 as const }
    await setPriority(db, marketplace, metric, [bad, good])
    await upsertObservations(
      db,
      [
        { ...base, observedOn: '2026-10-19', value: 300 },
        { ...base, observedOn: '2026-10-20', value: 310 },
      ],
      ids,
      { sourceId: bad, fetchedAt: now },
    )
    await upsertObservations(db, [{ ...base, observedOn: '2026-10-20', value: 280 }], ids, {
      sourceId: good,
      fetchedAt: now,
    })
    await setSourceQualification(db, {
      sourceId: bad,
      metric,
      disqualified: true,
      agreementRate: 0.9,
      samples: 20,
      evaluatedAt: now,
    })
    expect((await loadDisqualified(db))(bad, metric)).toBe(true)
    const points = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(points.map((p) => [p.observedOn, p.primary.sourceId, p.primary.disqualified])).toEqual([
      ['2026-10-19', bad, true],
      ['2026-10-20', good, false],
    ])
    expect(points[1]?.values.map((v) => v.sourceId)).toEqual([good, bad])
    // 批量读取同口径
    const batch = await readMetrics(db, {
      entityType: 'product',
      entityIds: [entityId],
      metrics: [metric],
      marketplace,
    })
    expect(batch.get(entityId)?.get(metric)?.[1]?.primary.sourceId).toBe(good)
    // 抽检恢复后重新取得资格
    await setSourceQualification(db, {
      sourceId: bad,
      metric,
      disqualified: false,
      agreementRate: 0.97,
      samples: 20,
      evaluatedAt: now,
    })
    const [, after] = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(after?.primary.sourceId).toBe(bad)
  })
})

describe.skipIf(!integration)('被追踪商品（空间隔离）', () => {
  const db = testDb()
  const workspaces: string[] = []

  afterAll(async () => {
    if (workspaces.length === 0) return
    await db.delete(trackedProduct).where(inArray(trackedProduct.workspaceId, workspaces))
    await db.delete(organization).where(inArray(organization.id, workspaces))
  })

  async function workspace() {
    const id = newId()
    await db
      .insert(organization)
      .values({ id, name: 'tracking', slug: `tracking-${id.slice(-10)}`, isPersonal: false })
    workspaces.push(id)
    return id
  }

  it('同一空间同一商品一行；档位变更记录原因；其他空间不可见', async () => {
    const [a, b] = [await workspace(), await workspace()]
    const key = { type: 'product' as const, marketplace, platformId: uniqueId('B0') }
    const productId = (await upsertEntities(db, [{ key }])).get(
      `product:${marketplace}:${key.platformId}`,
    ) as string
    const first = await trackProduct(db, a, { productId, origin: 'store' })
    expect(first).toMatchObject({ created: true, row: { tier: 'normal', origin: 'store' } })
    const again = await trackProduct(db, a, { productId, origin: 'lead', tier: 'hot' })
    expect(again).toMatchObject({ created: false, row: { tier: 'normal', origin: 'store' } })
    const changed = await setTrackedProductTier(db, a, {
      productId,
      tier: 'hot',
      reason: 'bought-up',
      now,
    })
    expect(changed).toMatchObject({ tier: 'hot', tierReason: 'bought-up' })
    // 档位未变化不改动
    expect(
      await setTrackedProductTier(db, a, { productId, tier: 'hot', reason: 'noop', now }),
    ).toBeUndefined()
    expect((await listTrackedProducts(db, a, { tiers: ['hot'] })).map((r) => r.productId)).toEqual([
      productId,
    ])
    expect(await listTrackedProducts(db, b)).toEqual([])
    const [row] = await db.select().from(trackedProduct).where(eq(trackedProduct.workspaceId, a))
    expect(row?.tierReason).toBe('bought-up')
  })
})
