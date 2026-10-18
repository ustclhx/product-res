import { env } from 'cloudflare:workers'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cluster,
  costingScenario,
  costParam,
  createDb,
  decision,
  direction,
  followOutcome,
  lead,
  logisticsProfile,
  organization,
  scoped,
  supplier,
  supplierQuote,
} from '../src/index.ts'
import { seedLead } from './support.ts'

// add-costing-decisions 2.1：核算 / 决策表经 scoped() 访问时跨空间隔离，关键唯一约束生效。
const open = () => createDb(env.HYPERDRIVE)

async function seed(label: string) {
  const base = await seedLead(env.HYPERDRIVE, label)
  const s = scoped(open(), base.wsId)
  const [sup] = await s.insert(supplier, { name: `${label} 供应商` }).returning()
  if (!sup) throw new Error('seed failed')
  const [quote] = await s
    .insert(supplierQuote, {
      supplierId: sup.id,
      clusterId: base.clusterId,
      tiers: [{ minQty: 1, unitPriceMinor: 500 }],
      currency: 'CNY',
      confidence: 'public',
      quotedOn: '2026-10-01',
    })
    .returning()
  const [profile] = await s
    .insert(logisticsProfile, {
      name: `${label} 直发`,
      platform: 'ebay',
      type: 'ebay-direct',
      transitDays: 10,
    })
    .returning()
  if (!quote || !profile) throw new Error('seed failed')
  await s.insert(costParam, { platform: 'ebay', commissionRate: 0.13 })
  await s.insert(costingScenario, {
    leadId: base.leadId,
    quoteId: quote.id,
    profileId: profile.id,
    mode: 'same-source',
    plannedQty: 100,
    result: { status: 'missing', missing: ['salePrice'] },
  })
  const [dec] = await s
    .insert(decision, { leadId: base.leadId, kind: 'follow', snapshot: {} })
    .returning()
  if (!dec) throw new Error('seed failed')
  await s.insert(followOutcome, { decisionId: dec.id, actualUnits: 12 })
  return {
    ...base,
    supplierId: sup.id,
    quoteId: quote.id,
    profileId: profile.id,
    decisionId: dec.id,
  }
}

async function cleanup(wsIds: string[]) {
  const db = open()
  for (const wsId of wsIds) {
    const s = scoped(db, wsId)
    // 外键顺序：回看 → 决定 → 方案 → 报价 → 供应商 / 物流 → 线索 → 簇 → 方向
    await s.delete(followOutcome, undefined)
    await s.delete(decision, undefined)
    await s.delete(costingScenario, undefined)
    await s.delete(supplierQuote, undefined)
    await s.delete(supplier, undefined)
    await s.delete(logisticsProfile, undefined)
    await s.delete(costParam, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
  }
  await db.delete(organization).where(inArray(organization.id, wsIds))
}

describe('核算与决策表', () => {
  let a: Awaited<ReturnType<typeof seed>>
  let b: Awaited<ReturnType<typeof seed>>
  beforeAll(async () => {
    a = await seed('CA')
    b = await seed('CB')
  })
  afterAll(async () => {
    await cleanup([a.wsId, b.wsId])
  })

  it('scoped() 只返回本空间的行，其他空间的 id 返回 404', async () => {
    const s = scoped(open(), a.wsId)
    for (const table of [
      supplier,
      supplierQuote,
      logisticsProfile,
      costParam,
      costingScenario,
      decision,
      followOutcome,
    ]) {
      expect(await s.count(table)).toBe(1)
    }
    await expect(s.findById(supplier, b.supplierId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.findById(decision, b.decisionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('每条线索只能有一个决定；每个平台只有一份默认成本参数', async () => {
    const s = scoped(open(), a.wsId)
    await expect(
      s.insert(decision, { leadId: a.leadId, kind: 'follow', snapshot: {} }),
    ).rejects.toThrow()
    await expect(s.insert(costParam, { platform: 'ebay' })).rejects.toThrow()
    // 带类目的参数不与默认值冲突
    await s.insert(costParam, { platform: 'ebay', categoryId: '1234' })
  })

  it('放弃决定必须有原因；核算组合唯一', async () => {
    const s = scoped(open(), a.wsId)
    const other = await seedLead(env.HYPERDRIVE, 'CA2')
    try {
      await expect(
        scoped(open(), other.wsId).insert(decision, {
          leadId: other.leadId,
          kind: 'drop',
          snapshot: {},
        }),
      ).rejects.toThrow()
      await expect(
        s.insert(costingScenario, {
          leadId: a.leadId,
          quoteId: a.quoteId,
          profileId: a.profileId,
          mode: 'same-source',
          plannedQty: 50,
          result: {},
        }),
      ).rejects.toThrow()
    } finally {
      const os = scoped(open(), other.wsId)
      await os.delete(lead, undefined)
      await os.delete(cluster, undefined)
      await os.delete(direction, undefined)
      await open()
        .delete(organization)
        .where(inArray(organization.id, [other.wsId]))
    }
  })
})
