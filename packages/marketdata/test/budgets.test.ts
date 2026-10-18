import type { BudgetSpec } from '@product-res/datasources'
import { budgetLedger, dataSource, sourceBudget } from '@product-res/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  currentUsage,
  expireStaleReservations,
  reconcileExternalRemaining,
  release,
  reserve,
  settle,
} from '../src/index.ts'
import { integration, testDb, uniqueId } from './helpers.ts'

const spec: BudgetSpec = {
  unit: 'call',
  period: 'day',
  hardCap: 5000,
  safetyLine: 4500,
  timeZone: 'America/Los_Angeles',
}
const now = new Date('2026-10-18T12:00:00Z')

describe.skipIf(!integration)('额度账本（真实 Postgres）', () => {
  const db = testDb()

  async function seed(sourceId: string, used: number) {
    await db.insert(sourceBudget).values({
      sourceId,
      periodKey: '2026-10-18',
      unit: 'call',
      hardCap: spec.hardCap,
      safetyLine: spec.safetyLine,
      settled: used,
    })
  }

  it('定时任务到安全线即停，人工刷新可用到硬上限', async () => {
    const sourceId = uniqueId('budget')
    await seed(sourceId, 4490)
    expect(await reserve(db, { sourceId, spec, amount: 20, mode: 'scheduled', now })).toMatchObject(
      {
        ok: false,
        reason: 'safety-line',
      },
    )
    const manual = await reserve(db, { sourceId, spec, amount: 20, mode: 'manual', now })
    expect(manual.ok).toBe(true)
    expect((await currentUsage(db, sourceId, spec, now)).used).toBe(4510)
  })

  it('两个并发预扣在余量只够一个时只有一个成功', async () => {
    const sourceId = uniqueId('budget')
    await seed(sourceId, 4400)
    const results = await Promise.all([
      reserve(db, { sourceId, spec, amount: 60, mode: 'scheduled', now }),
      reserve(db, { sourceId, spec, amount: 60, mode: 'scheduled', now }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect((await currentUsage(db, sourceId, spec, now)).used).toBe(4460)
  })

  it('结算按实际花费、释放归还预扣，且只处理一次', async () => {
    const sourceId = uniqueId('budget')
    const a = await reserve(db, { sourceId, spec, amount: 10, mode: 'scheduled', now })
    const b = await reserve(db, { sourceId, spec, amount: 5, mode: 'scheduled', now })
    if (!a.ok || !b.ok) throw new Error('reserve failed')
    expect(await settle(db, a.reservationId, 7)).toBe(true)
    expect(await settle(db, a.reservationId, 7)).toBe(false)
    expect(await release(db, b.reservationId)).toBe(true)
    expect((await currentUsage(db, sourceId, spec, now)).used).toBe(7)
  })

  it('悬挂预扣超过时限视为已花费，不归还额度', async () => {
    const sourceId = uniqueId('budget')
    const r = await reserve(db, { sourceId, spec, amount: 12, mode: 'scheduled', now })
    if (!r.ok) throw new Error('reserve failed')
    // 把预扣时间改到 1 小时前，模拟崩溃后无人结算
    await db
      .update(budgetLedger)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(budgetLedger.reservationId, r.reservationId))
    expect(await expireStaleReservations(db, new Date(), 30)).toBeGreaterThanOrEqual(1)
    const [row] = await db
      .select()
      .from(sourceBudget)
      .where(and(eq(sourceBudget.sourceId, sourceId), eq(sourceBudget.periodKey, r.periodKey)))
    expect(row).toMatchObject({ reserved: 0, settled: 12 })
  })

  it('外部剩余额度远少于账本时暂停该数据源的定时任务', async () => {
    const sourceId = uniqueId('budget')
    await db.insert(dataSource).values({ id: sourceId, enabled: true })
    await seed(sourceId, 4000)
    expect(await reconcileExternalRemaining(db, sourceId, spec, 100, now)).toBe(true)
    const paused = await reserve(db, { sourceId, spec, amount: 1, mode: 'scheduled', now })
    expect(paused).toMatchObject({ ok: false, reason: 'paused' })
  })
})
