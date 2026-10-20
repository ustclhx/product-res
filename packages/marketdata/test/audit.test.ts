import { amazonBoughtInterval } from '@product-res/datasources'
import {
  accuracyAudit,
  organization,
  sourceQualification,
  trackedProduct,
} from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AuditSampling,
  accuracyKpis,
  auditWeekOf,
  type CollectedValue,
  computeAgreement,
  fieldAgrees,
  generateAudit,
  getAuditItems,
  listAudits,
  loadDisqualified,
  qualificationDecision,
  readMetric,
  sampleIds,
  saveAuditItem,
  submitAudit,
  trackProduct,
  upsertEntities,
  upsertObservations,
} from '../src/index.ts'
import { integration, testDb, uniqueId } from './helpers.ts'

const marketplace = 'amazon-us' as const
const point = (value: number, extra: Partial<CollectedValue> = {}): CollectedValue => ({
  value,
  low: null,
  high: null,
  currency: null,
  tier: 2,
  channel: null,
  observedOn: '2026-10-19',
  fetchedAt: '2026-10-19T08:00:00.000Z',
  ...extra,
})

describe('抽检规则（纯函数）', () => {
  it('抽检周取新加坡时间所在周的周一', () => {
    expect(auditWeekOf(new Date('2026-10-20T08:00:00Z'))).toBe('2026-10-19')
    // UTC 周日 17:00 已是新加坡周一 01:00
    expect(auditWeekOf(new Date('2026-10-25T17:00:00Z'))).toBe('2026-10-26')
    expect(auditWeekOf(new Date('2026-10-25T15:00:00Z'))).toBe('2026-10-19')
  })

  it('同一种子抽样可复现，与候选顺序无关；不足时全部抽中', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${String(i).padStart(2, '0')}`)
    const a = sampleIds(ids, 20, 'seed-1')
    expect(a).toHaveLength(20)
    expect(new Set(a).size).toBe(20)
    expect(sampleIds([...ids].reverse(), 20, 'seed-1')).toEqual(a)
    expect(sampleIds(ids, 20, 'seed-2')).not.toEqual(a)
    expect(sampleIds(ids.slice(0, 3), 20, 'seed-1').sort()).toEqual(['p00', 'p01', 'p02'])
  })

  it('价格 ≤ 1%、评论数 ≤ 2%、bought 下界一致、其余完全一致', () => {
    expect(fieldAgrees('price', point(20.2), 20)).toBe(true)
    expect(fieldAgrees('price', point(20.21), 20)).toBe(false)
    expect(fieldAgrees('review_count', point(1020), 1000)).toBe(true)
    expect(fieldAgrees('review_count', point(1021), 1000)).toBe(false)
    const bought = amazonBoughtInterval(100)
    const collected = point(bought.value, { low: bought.valueLow, high: bought.valueHigh })
    expect(fieldAgrees('bought_month', collected, 100)).toBe(true)
    expect(fieldAgrees('bought_month', collected, 200)).toBe(false)
    // 页面没有徽标（填 0）而采集到档位：不一致
    expect(fieldAgrees('bought_month', collected, 0)).toBe(false)
    expect(fieldAgrees('rating', point(4.5), 4.5)).toBe(true)
    expect(fieldAgrees('rating', point(4.4), 4.5)).toBe(false)
    expect(fieldAgrees('bsr', point(1234), 1234)).toBe(true)
    expect(fieldAgrees('bsr', point(1235), 1234)).toBe(false)
    expect(fieldAgrees('available_quantity', point(3), true)).toBe(true)
    expect(fieldAgrees('available_quantity', point(0), true)).toBe(false)
  })

  it('只比较两边都有值的字段；缺失不算不一致', () => {
    const agreement = computeAgreement(
      { a: { price: point(10), rating: point(4.1) }, b: { review_count: point(7) } },
      { price: 10, review_count: null },
    )
    expect(agreement).toEqual({ a: { price: true } })
  })

  it('样本 ≥ 20 且 < 95% 失去资格，回到 ≥ 95% 恢复；样本不足保持原状态', () => {
    const stat = (agree: number, samples: number) => ({
      sourceId: 's',
      metric: 'bought_month' as const,
      agree,
      samples,
      rate: agree / samples,
    })
    expect(qualificationDecision(stat(18, 20), false)).toBe(true)
    expect(qualificationDecision(stat(19, 20), true)).toBe(false)
    expect(qualificationDecision(stat(10, 19), false)).toBe(false)
    expect(qualificationDecision(stat(19, 19), true)).toBe(true)
  })
})

describe.skipIf(!integration)('人工抽检（真实 Postgres）', () => {
  const db = testDb()
  const workspaces: string[] = []
  const sources: string[] = []
  const now = new Date('2031-03-04T04:00:00Z')
  const userId = null as unknown as string

  afterAll(async () => {
    if (workspaces.length > 0) {
      await db.delete(accuracyAudit).where(inArray(accuracyAudit.workspaceId, workspaces))
      await db.delete(trackedProduct).where(inArray(trackedProduct.workspaceId, workspaces))
      await db.delete(organization).where(inArray(organization.id, workspaces))
    }
    if (sources.length > 0)
      await db.delete(sourceQualification).where(inArray(sourceQualification.sourceId, sources))
  })

  async function workspace() {
    const id = newId()
    await db
      .insert(organization)
      .values({ id, name: 'audit', slug: `audit-${id.slice(-10)}`, isPersonal: false })
    workspaces.push(id)
    return id
  }

  /** 建 n 个被追踪商品；good / bad 两个来源各写 bought 区间与价格 */
  async function seed(workspaceId: string, n: number, good: string, bad: string, cold = 0) {
    const keys = Array.from({ length: n + cold }, () => ({
      type: 'product' as const,
      marketplace,
      platformId: uniqueId('B0'),
    }))
    const ids = await upsertEntities(
      db,
      keys.map((key) => ({ key })),
    )
    const bought = amazonBoughtInterval(100)
    const fetchedAt = new Date(now.getTime() - 86_400_000)
    const base = { metric: 'bought_month', observedOn: '2031-03-03', method: 'import' as const }
    for (const [i, key] of keys.entries()) {
      await upsertObservations(
        db,
        [
          { ...base, entity: key, value: bought.value, valueLow: 100, valueHigh: 200, tier: 2 },
          {
            entity: key,
            metric: 'price',
            observedOn: '2031-03-03',
            method: 'import',
            value: 20,
            currency: 'USD',
          },
        ],
        ids,
        { sourceId: good, fetchedAt },
      )
      // bad 来源：每 10 个商品有 1 个 bought 档位错误
      const wrong = i % 10 === 0 ? amazonBoughtInterval(200) : bought
      await upsertObservations(
        db,
        [
          {
            ...base,
            entity: key,
            value: wrong.value,
            valueLow: wrong.valueLow,
            valueHigh: wrong.valueHigh,
            tier: 2,
          },
        ],
        ids,
        { sourceId: bad, fetchedAt },
      )
      const productId = ids.get(`product:${marketplace}:${key.platformId}`) as string
      await trackProduct(db, workspaceId, {
        productId,
        origin: 'manual',
        tier: i >= n ? 'cold' : 'normal',
      })
    }
    return keys
  }

  it('随机抽 20 个、保存种子与抽样记录、快照各来源采集值；同一周只生成一次', async () => {
    const ws = await workspace()
    const [good, bad] = [uniqueId('good'), uniqueId('bad')]
    sources.push(good, bad)
    await seed(ws, 24, good, bad, 2)
    const { audit, created } = await generateAudit(db, ws, { now, seed: 'fixed' })
    expect(created).toBe(true)
    expect(audit).toMatchObject({ weekOf: '2031-03-03', seed: 'fixed', sampleSize: 20 })
    const sampling = audit.sampling as unknown as AuditSampling
    expect(sampling).toMatchObject({ candidates: 24, excludedCold: 2, shortfall: null })
    expect(sampling.picked).toHaveLength(20)
    const items = await getAuditItems(db, ws, audit.id)
    expect(items).toHaveLength(20)
    expect(items.map((i) => i.productId).sort()).toEqual([...sampling.picked].sort())
    const first = items[0]
    expect(first?.link).toBe(`https://www.amazon.com/dp/${first?.platformId}`)
    expect(first?.collected[good]?.bought_month).toMatchObject({ low: 100, high: 200, tier: 2 })
    expect(first?.collected[good]?.price).toMatchObject({ value: 20, currency: 'USD' })
    expect(first?.collected[good]?.price?.fetchedAt).toBe('2031-03-03T04:00:00.000Z')
    const again = await generateAudit(db, ws, { now })
    expect(again).toMatchObject({ created: false, audit: { id: audit.id } })
  })

  it('被追踪商品不足 20 个时按实际数生成并记录原因', async () => {
    const ws = await workspace()
    const [good, bad] = [uniqueId('good'), uniqueId('bad')]
    sources.push(good, bad)
    await seed(ws, 3, good, bad)
    const { audit } = await generateAudit(db, ws, { now })
    expect(audit.sampleSize).toBe(3)
    expect((audit.sampling as unknown as AuditSampling).shortfall).toEqual({
      reason: 'insufficient-candidates',
      available: 3,
    })
  })

  it('一致率不达标 → 失去主值资格；之后回到 95% 以上恢复', async () => {
    const ws = await workspace()
    const [good, bad] = [uniqueId('good'), uniqueId('bad')]
    sources.push(good, bad)
    const keys = await seed(ws, 20, good, bad)
    const { audit } = await generateAudit(db, ws, { now, seed: 'q' })
    const items = await getAuditItems(db, ws, audit.id)
    await expect(submitAudit(db, ws, { auditId: audit.id, userId, now })).rejects.toMatchObject({
      code: 'AUDIT_EMPTY',
    })
    for (const item of items) {
      const saved = await saveAuditItem(db, ws, {
        itemId: item.id,
        actual: { bought_month: 100, price: 20.1, unknown: 1, rating: 'x' },
        userId,
        now,
      })
      expect(saved.actual).toEqual({ bought_month: 100, price: 20.1 })
    }
    const decisions = await submitAudit(db, ws, { auditId: audit.id, userId, now })
    const pick = (sourceId: string, metric: string) =>
      decisions.find((d) => d.sourceId === sourceId && d.metric === metric)
    // bad：20 个样本中 2 个档位错误，一致率 90%
    expect(pick(bad, 'bought_month')).toMatchObject({ samples: 20, rate: 0.9, disqualified: true })
    expect(pick(good, 'bought_month')).toMatchObject({ samples: 20, rate: 1, disqualified: false })
    expect(pick(good, 'price')).toMatchObject({ samples: 20, disqualified: false })
    expect((await loadDisqualified(db))(bad, 'bought_month')).toBe(true)
    // 读取主值时跳过失去资格的来源
    const key = keys[0] as (typeof keys)[number]
    const [entity] = await upsertEntities(db, [{ key }]).then((m) => [...m.values()])
    const read = await readMetric(db, {
      entityType: 'product',
      entityId: entity as string,
      metric: 'bought_month',
      marketplace,
      from: '2031-03-03',
      to: '2031-03-03',
    })
    expect(read[0]?.primary.sourceId).toBe(good)
    expect(read[0]?.values.find((v) => v.sourceId === bad)?.disqualified).toBe(true)
    const kpis = await accuracyKpis(db)
    expect(kpis.stats.find((s) => s.sourceId === bad)).toMatchObject({
      belowTarget: true,
      disqualified: true,
    })
    // 已提交不可再改
    await expect(
      saveAuditItem(db, ws, { itemId: items[0]?.id as string, actual: {}, userId, now }),
    ).rejects.toMatchObject({ code: 'AUDIT_SUBMITTED' })

    // 下一周：页面实际值与 bad 的采集值相同（bad 全部一致、good 有 2 个不一致）；
    // bad 近 4 次合计 38/40 = 95%，恢复
    const nextWeek = new Date(now.getTime() + 7 * 86_400_000)
    const second = await generateAudit(db, ws, { now: nextWeek, seed: 'q2' })
    expect(second.audit.weekOf).toBe('2031-03-10')
    for (const item of await getAuditItems(db, ws, second.audit.id)) {
      const collected = item.collected[bad]?.bought_month
      expect(collected).toBeDefined()
      await saveAuditItem(db, ws, {
        itemId: item.id,
        actual: { bought_month: collected?.low ?? 0 },
        userId,
        now: nextWeek,
      })
    }
    const after = await submitAudit(db, ws, { auditId: second.audit.id, userId, now: nextWeek })
    expect(after.find((d) => d.sourceId === bad && d.metric === 'bought_month')).toMatchObject({
      samples: 40,
      rate: 0.95,
      disqualified: false,
    })
    expect((await loadDisqualified(db))(bad, 'bought_month')).toBe(false)
    const history = await listAudits(db, ws)
    expect(history.map((h) => [h.weekOf, h.status, h.checked, h.rate])).toEqual([
      ['2031-03-10', 'submitted', 20, 0.95],
      ['2031-03-03', 'submitted', 20, 58 / 60],
    ])
  })

  it('空间隔离：其他空间读不到抽检', async () => {
    const [a, b] = [await workspace(), await workspace()]
    const [good, bad] = [uniqueId('good'), uniqueId('bad')]
    sources.push(good, bad)
    await seed(a, 2, good, bad)
    const { audit } = await generateAudit(db, a, { now })
    await expect(getAuditItems(db, b, audit.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await listAudits(db, b)).toEqual([])
  })
})
