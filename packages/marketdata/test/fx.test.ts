import { describe, expect, it } from 'vitest'
import { latestValue, setManualRate, upsertEntities, upsertObservations } from '../src/index.ts'
import { integration, testDb, uniqueId } from './helpers.ts'

describe.skipIf(!integration)('汇率读取（specs/connector-fx）', () => {
  const db = testDb()

  it('当日缺失时沿用最近一日并返回所用日期；手填值优先且公开值保留', async () => {
    const pair = `${uniqueId('X')}/CNY`
    const entity = { type: 'currency' as const, marketplace: 'global' as const, platformId: pair }
    const ids = await upsertEntities(db, [{ key: entity }])
    await upsertObservations(
      db,
      [{ entity, metric: 'fx_rate', observedOn: '2026-10-16', value: 7.1, method: 'official' }],
      ids,
      { sourceId: 'fx-ecb', fetchedAt: new Date() },
    )
    expect(
      await latestValue(db, { entity, metric: 'fx_rate', onOrBefore: '2026-10-18' }),
    ).toMatchObject({
      observedOn: '2026-10-16',
      value: 7.1,
      sourceId: 'fx-ecb',
    })
    await setManualRate(db, { pair, observedOn: '2026-10-16', value: 7.25, now: new Date() })
    const manual = await latestValue(db, { entity, metric: 'fx_rate', onOrBefore: '2026-10-18' })
    expect(manual).toMatchObject({ value: 7.25, sourceId: 'manual', method: 'import' })
    expect(
      await latestValue(db, { entity, metric: 'fx_rate', onOrBefore: '2026-10-15' }),
    ).toBeNull()
  })
})
