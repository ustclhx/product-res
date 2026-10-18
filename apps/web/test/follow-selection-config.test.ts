import { env } from 'cloudflare:workers'
import {
  brandEntry,
  cluster,
  createDb,
  DEFAULT_US_NODES,
  direction,
  directionSeller,
  organization,
  riskRule,
  scoped,
  scoringSetting,
  seasonalNode,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  configPage,
  deleteBrand,
  deleteNode,
  deleteRule,
  saveBrand,
  saveNode,
  saveRule,
} from '../src/features/config/config.server.ts'
import {
  addSeedSeller,
  createDirection,
  deleteDirection,
  directionsPage,
  removeSeller,
  reviewSuggestedSeller,
  setDirectionEnabled,
  updateDirection,
} from '../src/features/follow/directions.server.ts'
import type { WorkbenchActor } from '../src/features/workbench/actor.ts'

// tasks.md 2.2 / 2.3：选品方向、店铺池、节点日历、品牌库、风险规则的增删改与写权限。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []

async function space(): Promise<WorkbenchActor> {
  const id = newId()
  spaces.push(id)
  await db()
    .insert(organization)
    .values({ id, name: 'Follow test', slug: `follow-${id.slice(-12)}`, isPersonal: false })
  return { db: db(), workspaceId: id, workspaceReadOnly: false, member: { role: 'owner' } }
}

const asMember = (a: WorkbenchActor): WorkbenchActor => ({ ...a, member: { role: 'member' } })
const asReadOnly = (a: WorkbenchActor): WorkbenchActor => ({ ...a, workspaceReadOnly: true })
const forbidden = { code: 'FORBIDDEN', status: 403 }
const readOnly = { code: 'WORKSPACE_READ_ONLY', status: 403 }

const baseDirection = {
  name: '厨房收纳',
  marketplaces: ['ebay-us', 'amazon-us'] as ('ebay-us' | 'amazon-us')[],
  categoryIds: ['20625'],
  keywords: ['spice rack', 'drawer organizer'],
  nodeIds: [] as string[],
}

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(cluster, undefined)
    await s.delete(directionSeller, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(brandEntry, undefined)
    await s.delete(riskRule, undefined)
    await s.delete(scoringSetting, undefined)
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
})

describe('选品方向', () => {
  let owner: WorkbenchActor
  beforeAll(async () => {
    owner = await space()
  })

  it('首次打开页面写入预置节点，空状态下没有方向和店铺', async () => {
    const page = await directionsPage(owner)
    expect(page.directions).toEqual([])
    expect(page.sellers).toEqual([])
    expect(page.nodes.map((n) => n.name).sort()).toEqual(DEFAULT_US_NODES.map((n) => n.name).sort())
  })

  it('增改停用删除；节点只接受本空间的 id；同名冲突', async () => {
    const { nodes } = await directionsPage(owner)
    const other = await space()
    const [otherNode] = (await directionsPage(other)).nodes
    const backToSchool = nodes.find((n) => n.name === '返校季')?.id as string
    const created = await createDirection(owner, {
      ...baseDirection,
      nodeIds: [backToSchool, otherNode?.id as string],
      note: '  第一批  ',
    })
    expect(created).toMatchObject({ enabled: true, note: '第一批', nodeIds: [backToSchool] })
    expect(typeof created.updatedAt).toBe('string')

    await expect(createDirection(owner, baseDirection)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const updated = await updateDirection(owner, created.id, {
      ...baseDirection,
      name: '厨房收纳 · 改',
      marketplaces: ['ebay-us'],
    })
    expect(updated).toMatchObject({ name: '厨房收纳 · 改', marketplaces: ['ebay-us'], nodeIds: [] })
    expect((await setDirectionEnabled(owner, created.id, false)).enabled).toBe(false)

    // 其他空间看不到也改不了
    await expect(setDirectionEnabled(other, created.id, true)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect((await directionsPage(other)).directions).toEqual([])

    await deleteDirection(owner, created.id)
    expect((await directionsPage(owner)).directions).toEqual([])
  })

  it('已有商品簇的方向只能停用', async () => {
    const d = await createDirection(owner, { ...baseDirection, name: '有簇方向' })
    await scoped(db(), owner.workspaceId).insert(cluster, {
      directionId: d.id,
      marketplace: 'ebay-us',
      name: '簇',
    })
    await expect(deleteDirection(owner, d.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await setDirectionEnabled(owner, d.id, false)).enabled).toBe(false)
  })

  it('member 与只读空间不能写入', async () => {
    const d = await createDirection(owner, { ...baseDirection, name: '权限方向' })
    for (const [actor, error] of [
      [asMember(owner), forbidden],
      [asReadOnly(owner), readOnly],
    ] as const) {
      await expect(
        createDirection(actor, { ...baseDirection, name: '越权' }),
      ).rejects.toMatchObject(error)
      await expect(setDirectionEnabled(actor, d.id, false)).rejects.toMatchObject(error)
      await expect(deleteDirection(actor, d.id)).rejects.toMatchObject(error)
      await expect(
        addSeedSeller(actor, { directionId: d.id, marketplace: 'ebay-us', sellerPlatformId: 'x' }),
      ).rejects.toMatchObject(error)
    }
    // 读取不受限
    const page = await directionsPage(asMember(owner))
    expect(page.directions.find((x) => x.id === d.id)?.enabled).toBe(true)
  })
})

describe('对标店铺池', () => {
  it('种子添加、推荐接受 / 拒绝、拒绝后重新添加为种子', async () => {
    const owner = await space()
    const d = await createDirection(owner, baseDirection)
    const seed = await addSeedSeller(owner, {
      directionId: d.id,
      marketplace: 'ebay-us',
      sellerPlatformId: ' kitchen_pro ',
      sellerName: 'Kitchen Pro',
    })
    expect(seed).toMatchObject({ status: 'seed', sellerPlatformId: 'kitchen_pro' })
    await expect(
      addSeedSeller(owner, {
        directionId: d.id,
        marketplace: 'ebay-us',
        sellerPlatformId: 'kitchen_pro',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      addSeedSeller(owner, {
        directionId: d.id,
        marketplace: 'amazon-uk',
        sellerPlatformId: 'A1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MARKETPLACE' })

    // 推荐由流水线写入；这里直接插入 suggested 行模拟
    const [a, b] = await scoped(db(), owner.workspaceId)
      .insert(directionSeller, [
        {
          directionId: d.id,
          marketplace: 'ebay-us',
          sellerPlatformId: 'suggest_a',
          status: 'suggested',
          reason: { summary: '与种子店铺 6 个同款重合' },
        },
        {
          directionId: d.id,
          marketplace: 'ebay-us',
          sellerPlatformId: 'suggest_b',
          status: 'suggested',
        },
      ])
      .returning()
    if (!a || !b) throw new Error('seed failed')
    const page = await directionsPage(owner)
    expect(page.sellers.find((s) => s.id === a.id)?.reason).toBe('与种子店铺 6 个同款重合')

    expect((await reviewSuggestedSeller(owner, a.id, 'accept')).status).toBe('accepted')
    expect((await reviewSuggestedSeller(owner, b.id, 'reject')).status).toBe('rejected')
    await expect(reviewSuggestedSeller(owner, b.id, 'accept')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    await expect(reviewSuggestedSeller(asMember(owner), a.id, 'reject')).rejects.toMatchObject(
      forbidden,
    )
    // 拒绝的店铺不能“移出”（保留记录以免再次推荐），但可以重新添加为种子
    await expect(removeSeller(owner, b.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    const restored = await addSeedSeller(owner, {
      directionId: d.id,
      marketplace: 'ebay-us',
      sellerPlatformId: 'suggest_b',
    })
    expect(restored).toMatchObject({ id: b.id, status: 'seed' })

    await removeSeller(owner, seed.id)
    const statuses = (await directionsPage(owner)).sellers.map((s) => s.status).sort()
    expect(statuses).toEqual(['accepted', 'seed'])

    // 删除方向时店铺池一并删除
    await deleteDirection(owner, d.id)
    expect(await scoped(db(), owner.workspaceId).count(directionSeller)).toBe(0)
  })
})

describe('设置：节点日历、品牌库、风险规则', () => {
  it('节点增删改；删除节点时从方向中移除关联；非法日期被拒绝', async () => {
    const owner = await space()
    await configPage(owner)
    const node = await saveNode(owner, undefined, {
      name: '感恩节',
      startMonth: 10,
      startDay: 20,
      salesDays: 38,
      keywords: ['thanksgiving decor', 'thanksgiving decor'],
    })
    expect(node).toMatchObject({ preset: false, keywords: ['thanksgiving decor'] })
    await expect(
      saveNode(owner, undefined, {
        name: '感恩节',
        startMonth: 11,
        startDay: 1,
        salesDays: 10,
        keywords: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      saveNode(owner, undefined, {
        name: '不存在',
        startMonth: 2,
        startDay: 30,
        salesDays: 10,
        keywords: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' })
    const edited = await saveNode(owner, node.id, { ...node, salesDays: 40 })
    expect(edited.salesDays).toBe(40)

    const d = await createDirection(owner, { ...baseDirection, nodeIds: [node.id] })
    await deleteNode(owner, node.id)
    const page = await directionsPage(owner)
    expect(page.directions.find((x) => x.id === d.id)?.nodeIds).toEqual([])
    expect(page.nodes.some((n) => n.id === node.id)).toBe(false)
    await expect(
      saveNode(asMember(owner), undefined, {
        name: 'x',
        startMonth: 1,
        startDay: 1,
        salesDays: 1,
        keywords: [],
      }),
    ).rejects.toMatchObject(forbidden)
  })

  it('品牌库增删改，同类型同平台不区分大小写去重', async () => {
    const owner = await space()
    const acme = await saveBrand(owner, undefined, { name: 'Acme', kind: 'brand' })
    expect(acme.marketplace).toBeNull()
    await expect(
      saveBrand(owner, undefined, { name: 'ACME', kind: 'brand' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // 不同类型或平台可以并存
    await saveBrand(owner, undefined, { name: 'Acme', kind: 'vero' })
    await saveBrand(owner, undefined, { name: 'Acme', kind: 'brand', marketplace: 'amazon-us' })
    const edited = await saveBrand(owner, acme.id, { name: 'Acme Inc', kind: 'brand', note: 'TM' })
    expect(edited).toMatchObject({ name: 'Acme Inc', note: 'TM' })
    await deleteBrand(owner, acme.id)
    expect((await configPage(owner)).brands.map((b) => b.name)).toEqual(['Acme', 'Acme'])
    await expect(deleteBrand(asReadOnly(owner), edited.id)).rejects.toMatchObject(readOnly)
    const other = await space()
    expect((await configPage(other)).brands).toEqual([])
  })

  it('风险规则增删改，需要类目或关键词', async () => {
    const owner = await space()
    await expect(
      saveRule(owner, undefined, {
        kind: 'hazmat',
        level: 'high',
        description: '无条件',
        enabled: true,
        match: { categoryIds: [], keywords: [], marketplaces: ['ebay-us'] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RULE' })
    const rule = await saveRule(owner, undefined, {
      kind: 'hazmat',
      level: 'high',
      description: '锂电池需危险品申报',
      enabled: true,
      match: { categoryIds: [], keywords: ['lithium battery'], marketplaces: [] },
    })
    expect(rule.match).toEqual({ categoryIds: [], keywords: ['lithium battery'], marketplaces: [] })
    const edited = await saveRule(owner, rule.id, {
      kind: 'shipping-ban',
      level: 'medium',
      description: '海运禁运',
      enabled: false,
      match: { categoryIds: ['177'], keywords: [], marketplaces: ['amazon-us'] },
    })
    expect(edited).toMatchObject({ kind: 'shipping-ban', level: 'medium', enabled: false })
    await expect(deleteRule(asMember(owner), rule.id)).rejects.toMatchObject(forbidden)
    await deleteRule(owner, rule.id)
    expect((await configPage(owner)).rules).toEqual([])
  })
})
