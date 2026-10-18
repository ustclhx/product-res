import { buildImport, createMockConnector, suggestMapping } from '@product-res/datasources'
import { dataSource, rawPayload } from '@product-res/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  commitImport,
  createDbArchive,
  currentUsage,
  effectiveBudget,
  findDuplicateImport,
  getSource,
  productIds,
  readMetric,
  readMetrics,
  replayPayloads,
  revertImport,
  runSyncTask,
  setPriority,
  upsertEntities,
  upsertObservations,
} from '../src/index.ts'
import { context, integration, testDb, uniqueId } from './helpers.ts'

const now = new Date('2026-10-18T12:00:00Z')

describe.skipIf(!integration)('同步编排（模拟数据源，真实 Postgres）', () => {
  const db = testDb()
  const archive = createDbArchive(db)

  async function enabledMock(options: Parameters<typeof createMockConnector>[0] = {}) {
    const connector = createMockConnector({ id: uniqueId('mock'), ...options })
    await db.insert(dataSource).values({ id: connector.id, enabled: true })
    return connector
  }

  it('同步 → 存档 → 观测值 → 可追溯到原始响应', async () => {
    const connector = await enabledMock()
    const ids = [uniqueId('item'), uniqueId('item')]
    const task = {
      kind: 'product-snapshot' as const,
      marketplace: 'ebay-us' as const,
      scope: { ids },
    }
    const outcome = await runSyncTask({ db, archive, ctx: context(now) }, connector, task, {
      mode: 'scheduled',
      trigger: 'scheduled',
    })
    expect(outcome).toMatchObject({ status: 'succeeded', observations: 4 })
    const productId = (await productIds(db, 'ebay-us', ids)).get(ids[0] as string) as string
    const [point] = await readMetric(db, {
      entityType: 'product',
      entityId: productId,
      metric: 'price',
      marketplace: 'ebay-us',
    })
    expect(point?.primary).toMatchObject({
      sourceId: connector.id,
      value: 9.99,
      method: 'official',
    })
    // 批量读取与逐个读取一致；没有观测的指标不出现在结果中
    const batch = await readMetrics(db, {
      entityType: 'product',
      entityIds: [productId],
      metrics: ['price', 'available_quantity', 'bsr'],
      marketplace: 'ebay-us',
    })
    expect(batch.get(productId)?.get('price')).toEqual([point])
    expect(batch.get(productId)?.get('available_quantity')).toHaveLength(1)
    expect(batch.get(productId)?.has('bsr')).toBe(false)
    const stored = await archive.get(point?.primary.rawPayloadId as string)
    expect(new TextDecoder().decode(stored?.body)).toContain(ids[0])
    const spec = effectiveBudget(connector, undefined)
    expect((await currentUsage(db, connector.id, spec, now)).used).toBe(1)
  })

  it('停用的数据源不发出调用', async () => {
    const connector = createMockConnector({ id: uniqueId('mock') })
    await db.insert(dataSource).values({ id: connector.id, enabled: false })
    const outcome = await runSyncTask(
      { db, archive, ctx: context(now) },
      connector,
      { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids: ['x'] } },
      { mode: 'scheduled', trigger: 'scheduled' },
    )
    expect(outcome.status).toBe('skipped')
    expect(connector.calls()).toBe(0)
  })

  it('额度不足时延迟任务，不调用外部接口', async () => {
    const connector = await enabledMock({ hardCap: 1 })
    // 硬上限 1、安全线 0：定时任务一次都不能调用
    const outcome = await runSyncTask(
      { db, archive, ctx: context(now) },
      connector,
      { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids: ['x'] } },
      { mode: 'scheduled', trigger: 'scheduled' },
    )
    expect(outcome).toMatchObject({ status: 'deferred', reason: 'safety-line' })
    expect(connector.calls()).toBe(0)
  })

  it('凭据失效时暂停数据源，其他数据源不受影响', async () => {
    const broken = await enabledMock({ failOn: { 1: 'auth' } })
    const healthy = await enabledMock()
    const task = {
      kind: 'product-snapshot' as const,
      marketplace: 'ebay-us' as const,
      scope: { ids: [uniqueId('i')] },
    }
    const deps = { db, archive, ctx: context(now) }
    expect(
      (await runSyncTask(deps, broken, task, { mode: 'scheduled', trigger: 'scheduled' })).status,
    ).toBe('failed')
    expect((await getSource(db, broken.id))?.pausedReason).toBe('auth')
    const second = await runSyncTask(deps, broken, task, {
      mode: 'scheduled',
      trigger: 'scheduled',
    })
    expect(second).toMatchObject({ status: 'deferred', reason: 'paused' })
    expect(broken.calls()).toBe(1)
    expect(
      (await runSyncTask(deps, healthy, task, { mode: 'scheduled', trigger: 'scheduled' })).status,
    ).toBe('succeeded')
  })

  it('回放存档不消耗额度；超过保留期后观测值保留', async () => {
    const connector = await enabledMock()
    const ids = [uniqueId('item')]
    const deps = { db, archive, ctx: context(now) }
    const outcome = await runSyncTask(
      deps,
      connector,
      { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids } },
      {
        mode: 'scheduled',
        trigger: 'scheduled',
      },
    )
    if (outcome.status !== 'succeeded') throw new Error('sync failed')
    const payloads = await db
      .select({ id: rawPayload.id })
      .from(rawPayload)
      .where(eq(rawPayload.runId, outcome.runId))
    const spec = effectiveBudget(connector, undefined)
    const before = (await currentUsage(db, connector.id, spec, now)).used
    expect(
      await replayPayloads(
        deps,
        connector,
        payloads.map((p) => p.id),
      ),
    ).toEqual({ replayed: 2, expired: 0 })
    expect((await currentUsage(db, connector.id, spec, now)).used).toBe(before)
    // 过期清理
    await db
      .update(rawPayload)
      .set({ expiresAt: new Date('2000-01-01') })
      .where(eq(rawPayload.runId, outcome.runId))
    expect(await archive.purgeExpired(new Date())).toBeGreaterThanOrEqual(1)
    expect(
      await replayPayloads(
        deps,
        connector,
        payloads.map((p) => p.id),
      ),
    ).toEqual({ replayed: 0, expired: 1 })
    const productId = (await productIds(db, 'ebay-us', ids)).get(ids[0] as string) as string
    expect(
      await readMetric(db, {
        entityType: 'product',
        entityId: productId,
        metric: 'price',
        marketplace: 'ebay-us',
      }),
    ).toHaveLength(1)
  })
})

describe.skipIf(!integration)('统一数据模型', () => {
  const db = testDb()
  const marketplace = 'amazon-us' as const

  it('两个来源的同一 ASIN 归到同一商品，多来源并存并按优先级取主值', async () => {
    const asin = uniqueId('B0')
    const key = { type: 'product' as const, marketplace, platformId: asin }
    const ids = await upsertEntities(db, [{ key, facts: { title: 'Cup' } }])
    await upsertEntities(db, [{ key, facts: { brand: 'Acme' } }])
    const metric = uniqueId('m').replace(/-/g, '_')
    const row = (sourceId: string, value: number) => ({
      entity: key,
      metric,
      observedOn: '2026-10-18',
      value,
      method: 'estimate' as const,
    })
    await upsertObservations(db, [row('src-b', 300)], ids, { sourceId: 'src-b', fetchedAt: now })
    await upsertObservations(db, [row('src-a', 900)], ids, { sourceId: 'src-a', fetchedAt: now })
    // 同一来源同日重复写入以最新为准
    await upsertObservations(db, [row('src-a', 600)], ids, { sourceId: 'src-a', fetchedAt: now })
    await setPriority(db, marketplace, metric, ['src-a', 'src-b'])
    const entityId = ids.get(`product:${marketplace}:${asin}`) as string
    const [point] = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(point?.primary).toMatchObject({ sourceId: 'src-a', value: 600 })
    expect(point?.values.map((v) => v.sourceId)).toEqual(['src-a', 'src-b'])
    expect(point?.dispersion).toBeCloseTo(1)
    // 修改优先级后主值随之改变，已存储的值不变
    await setPriority(db, marketplace, metric, ['src-b', 'src-a'])
    const [after] = await readMetric(db, { entityType: 'product', entityId, metric, marketplace })
    expect(after?.primary).toMatchObject({ sourceId: 'src-b', value: 300 })
    expect((await productIds(db, marketplace, [asin])).size).toBe(1)
  })

  it('没有来源提供的指标是“无数据”，不是 0', async () => {
    const asin = uniqueId('B0')
    const ids = await upsertEntities(db, [
      { key: { type: 'product', marketplace, platformId: asin } },
    ])
    const entityId = ids.get(`product:${marketplace}:${asin}`) as string
    expect(
      await readMetric(db, {
        entityType: 'product',
        entityId,
        metric: 'sales_estimate_monthly',
        marketplace,
      }),
    ).toEqual([])
  })
})

describe.skipIf(!integration)('文件导入', () => {
  const db = testDb()
  const archive = createDbArchive(db)

  it('导入、重复确认与整批撤销', async () => {
    const asin = uniqueId('B0')
    const csv = `ASIN,Price,ASIN Sales\n${asin},$12.00,\n`
    const headers = ['ASIN', 'Price', 'ASIN Sales']
    const context = {
      sourceId: 'helium10',
      marketplace: 'amazon-us' as const,
      entityType: 'product' as const,
      observedOn: '2026-10-18',
    }
    const preview = buildImport(
      headers,
      [[asin, '$12.00', '']],
      suggestMapping(headers).mapping,
      context,
    )
    const file = new TextEncoder().encode(csv)
    const input = {
      fileName: 'blackbox.csv',
      file,
      contentType: 'text/csv',
      context,
      preview,
      skipErrorRows: false,
      confirmDuplicate: false,
      now,
    }
    const first = await commitImport(db, archive, input)
    expect(first.imported).toBe(1)
    expect(await findDuplicateImport(db, file)).toBeDefined()
    await expect(commitImport(db, archive, input)).rejects.toMatchObject({
      code: 'IMPORT_DUPLICATE',
    })
    const entityId = (await productIds(db, 'amazon-us', [asin])).get(asin) as string
    const [point] = await readMetric(db, {
      entityType: 'product',
      entityId,
      metric: 'price',
      marketplace: 'amazon-us',
    })
    expect(point?.primary).toMatchObject({ method: 'import', importId: first.importId })
    expect(await revertImport(db, first.importId, now)).toBe(1)
    expect(
      await readMetric(db, {
        entityType: 'product',
        entityId,
        metric: 'price',
        marketplace: 'amazon-us',
      }),
    ).toEqual([])
    expect(await findDuplicateImport(db, file)).toBeUndefined()
  })
})
