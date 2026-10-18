import { dataQualityIssue } from '@product-res/db/schema'
import { like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { runQualityChecks, upsertEntities, upsertObservations } from '../src/index.ts'
import { integration, testDb, uniqueId } from './helpers.ts'

describe.skipIf(!integration)('数据质量检查', () => {
  const db = testDb()
  const marketplace = 'amazon-us' as const
  // 使用远期日期，避免与其他用例的数据混在同一天
  const day = '2031-03-02'
  const now = new Date(`${day}T12:00:00Z`)

  it('来源差异超过 50% 生成问题，重复出现合并为一条', async () => {
    const asin = uniqueId('B0')
    const key = { type: 'product' as const, marketplace, platformId: asin }
    const ids = await upsertEntities(db, [{ key }])
    const obs = (value: number, observedOn = day) => ({
      entity: key,
      metric: 'sales_estimate_monthly',
      observedOn,
      value,
      method: 'estimate' as const,
    })
    await upsertObservations(db, [obs(300)], ids, { sourceId: 'jungle-scout', fetchedAt: now })
    await upsertObservations(db, [obs(900)], ids, { sourceId: 'sellersprite', fetchedAt: now })
    await runQualityChecks(db, now, undefined, day)
    await runQualityChecks(db, new Date(now.getTime() + 3_600_000), undefined, day)
    const entityId = ids.get(`product:${marketplace}:${asin}`) as string
    const issues = await db
      .select()
      .from(dataQualityIssue)
      .where(like(dataQualityIssue.fingerprint, `divergence:${entityId}:%`))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.detail).toMatchObject({
      min: 300,
      max: 900,
      sources: ['jungle-scout', 'sellersprite'],
      values: [300, 900],
    })
    expect(issues[0]?.lastSeenAt.getTime()).toBeGreaterThan(
      issues[0]?.firstSeenAt.getTime() as number,
    )
  })

  it('同一来源相邻两日超过 3 倍的跳变生成问题', async () => {
    const asin = uniqueId('B0')
    const key = { type: 'product' as const, marketplace, platformId: asin }
    const ids = await upsertEntities(db, [{ key }])
    const obs = (value: number, observedOn: string) => ({
      entity: key,
      metric: 'price',
      observedOn,
      value,
      currency: 'USD',
      method: 'official' as const,
    })
    await upsertObservations(db, [obs(10, '2031-03-01'), obs(45, day)], ids, {
      sourceId: 'keepa',
      fetchedAt: now,
    })
    await runQualityChecks(db, now, undefined, day)
    const entityId = ids.get(`product:${marketplace}:${asin}`) as string
    const issues = await db
      .select()
      .from(dataQualityIssue)
      .where(like(dataQualityIssue.fingerprint, `spike:keepa:${entityId}:price`))
    expect(issues).toHaveLength(1)
  })
})
