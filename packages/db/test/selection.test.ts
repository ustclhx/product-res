import { env } from 'cloudflare:workers'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  brandEntry,
  cluster,
  clusterSignal,
  createDb,
  DEFAULT_US_NODES,
  direction,
  directionSeller,
  ensureSelectionDefaults,
  lead,
  leadEvent,
  organization,
  riskFinding,
  riskRule,
  scoped,
  scoringSetting,
  seasonalNode,
} from '../src/index.ts'

// tasks.md 2.1：跟卖选品的空间级表经 scoped() 访问时跨空间隔离，预置数据按空间幂等写入。
const open = () => createDb(env.HYPERDRIVE)

async function seedWorkspace(label: string) {
  const db = open()
  const wsId = newId()
  await db
    .insert(organization)
    .values({ id: wsId, name: label, slug: `sel-${wsId.slice(-12)}`, isPersonal: false })
  const s = scoped(db, wsId)
  const [node] = await s
    .insert(seasonalNode, { name: `${label} 节点`, startMonth: 7, startDay: 15, salesDays: 45 })
    .returning()
  const [dir] = await s
    .insert(direction, {
      name: `${label} 方向`,
      marketplaces: ['ebay-us'],
      nodeIds: node ? [node.id] : [],
    })
    .returning()
  if (!node || !dir) throw new Error('seed failed')
  const [seller] = await s
    .insert(directionSeller, {
      directionId: dir.id,
      marketplace: 'ebay-us',
      sellerPlatformId: `${label}-seller`,
      status: 'seed',
    })
    .returning()
  const [brand] = await s.insert(brandEntry, { name: `${label} Brand`, kind: 'brand' }).returning()
  const [rule] = await s
    .insert(riskRule, { kind: 'hazmat', level: 'high', description: `${label} 锂电池` })
    .returning()
  const [cl] = await s
    .insert(cluster, { directionId: dir.id, marketplace: 'ebay-us', name: `${label} 簇` })
    .returning()
  if (!seller || !brand || !rule || !cl) throw new Error('seed failed')
  await s.insert(clusterSignal, {
    clusterId: cl.id,
    observedOn: '2026-10-01',
    dimension: 'market-demand',
    score: null,
  })
  const [ld] = await s
    .insert(lead, {
      clusterId: cl.id,
      directionId: dir.id,
      leadOn: '2026-10-01',
      settingVersion: 1,
    })
    .returning()
  if (!ld) throw new Error('seed failed')
  await s.insert(leadEvent, { leadId: ld.id, clusterId: cl.id, kind: 'note' })
  await s.insert(riskFinding, { clusterId: cl.id, kind: 'brand', ref: brand.name, level: 'high' })
  return { wsId, nodeId: node.id, directionId: dir.id, sellerId: seller.id, clusterId: cl.id }
}

async function cleanup(wsIds: string[]) {
  const db = open()
  for (const wsId of wsIds) {
    const s = scoped(db, wsId)
    // 外键顺序：线索 → 簇 → 方向；其余表无相互引用
    await s.delete(leadEvent, undefined)
    await s.delete(riskFinding, undefined)
    await s.delete(clusterSignal, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(directionSeller, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(brandEntry, undefined)
    await s.delete(riskRule, undefined)
    await s.delete(scoringSetting, undefined)
  }
  await db.delete(organization).where(inArray(organization.id, wsIds))
}

describe('跟卖选品表的空间隔离', () => {
  let a: Awaited<ReturnType<typeof seedWorkspace>>
  let b: Awaited<ReturnType<typeof seedWorkspace>>

  beforeAll(async () => {
    a = await seedWorkspace('A')
    b = await seedWorkspace('B')
  })
  afterAll(async () => {
    await cleanup([a.wsId, b.wsId])
  })

  it('select 只返回本空间的行', async () => {
    const s = scoped(open(), a.wsId)
    expect((await s.select(direction)).map((d) => d.id)).toEqual([a.directionId])
    expect((await s.select(seasonalNode)).map((n) => n.id)).toEqual([a.nodeId])
    expect((await s.select(directionSeller)).map((r) => r.id)).toEqual([a.sellerId])
    expect((await s.select(cluster)).map((c) => c.id)).toEqual([a.clusterId])
    for (const table of [brandEntry, riskRule, lead, leadEvent, riskFinding, clusterSignal]) {
      expect(await s.count(table)).toBe(1)
    }
  })

  it('用其他空间的 id 读写与不存在的记录一样返回 404', async () => {
    const s = scoped(open(), a.wsId)
    await expect(s.findById(direction, b.directionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.updateById(direction, b.directionId, { enabled: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(s.deleteById(seasonalNode, b.nodeId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.deleteById(directionSeller, b.sellerId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const untouched = await scoped(open(), b.wsId).findById(direction, b.directionId)
    expect(untouched.enabled).toBe(true)
  })

  it('批量更新与删除不影响其他空间', async () => {
    const s = scoped(open(), a.wsId)
    await s.update(direction, { enabled: false }, undefined)
    expect((await s.findById(direction, a.directionId)).enabled).toBe(false)
    expect((await scoped(open(), b.wsId).findById(direction, b.directionId)).enabled).toBe(true)
    await s.update(direction, { enabled: true }, undefined)
  })

  it('插入时带入其他空间的 id 被拒绝', () => {
    const s = scoped(open(), a.wsId)
    expect(() =>
      s.insert(brandEntry, { workspaceId: b.wsId, name: 'X', kind: 'vero' } as never),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('有簇的方向不能删除（只能停用，历史线索保留）', async () => {
    const s = scoped(open(), a.wsId)
    await expect(s.deleteById(direction, a.directionId)).rejects.toThrow()
    expect((await s.findById(direction, a.directionId)).id).toBe(a.directionId)
  })
})

describe('ensureSelectionDefaults', () => {
  const created: string[] = []
  afterAll(async () => {
    await cleanup(created)
  })

  it('首次写入美国节点与评分设置版本 1；并发和重复调用不重复写入', async () => {
    const db = open()
    const wsId = newId()
    created.push(wsId)
    await db
      .insert(organization)
      .values({ id: wsId, name: 'Defaults', slug: `def-${wsId.slice(-12)}`, isPersonal: false })
    const results = await Promise.all([
      ensureSelectionDefaults(db, wsId),
      ensureSelectionDefaults(open(), wsId),
    ])
    expect(results.filter((r) => r.seeded)).toHaveLength(1)
    expect((await ensureSelectionDefaults(db, wsId)).seeded).toBe(false)

    const s = scoped(db, wsId)
    const nodes = await s.select(seasonalNode)
    expect(nodes.map((n) => n.name).sort()).toEqual(DEFAULT_US_NODES.map((n) => n.name).sort())
    expect(nodes.every((n) => n.preset)).toBe(true)
    const settings = await s.select(scoringSetting)
    expect(settings).toHaveLength(1)
    expect(settings[0]).toMatchObject({ version: 1, vetoThreshold: 30, marginFloorBp: 1500 })

    // 团队删光预置节点后不会被重新加回
    await s.delete(seasonalNode, undefined)
    await ensureSelectionDefaults(db, wsId)
    expect(await s.count(seasonalNode)).toBe(0)
  })

  it('只写入调用方空间', async () => {
    const db = open()
    const [x, y] = [newId(), newId()]
    created.push(x, y)
    await db.insert(organization).values([
      { id: x, name: 'X', slug: `defx-${x.slice(-12)}`, isPersonal: false },
      { id: y, name: 'Y', slug: `defy-${y.slice(-12)}`, isPersonal: false },
    ])
    await ensureSelectionDefaults(db, x)
    expect(await scoped(db, y).count(seasonalNode)).toBe(0)
    expect(await scoped(db, x).count(seasonalNode, eq(seasonalNode.name, '返校季'))).toBe(1)
  })
})
