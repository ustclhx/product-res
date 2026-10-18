import { env } from 'cloudflare:workers'
import {
  cluster,
  createDb,
  direction,
  lead,
  organization,
  scoped,
  scoringSetting,
  seasonalNode,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { saveScoring, scoringPage } from '../src/features/data-center/scoring.server.ts'
import type { WorkbenchActor } from '../src/features/workbench/actor.ts'

// tasks.md 3.2：评分维度管理——保存生成新版本（只追加），已有线索不变。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []

async function space(): Promise<WorkbenchActor> {
  const id = newId()
  spaces.push(id)
  await db()
    .insert(organization)
    .values({ id, name: 'Scoring test', slug: `scoring-${id.slice(-12)}`, isPersonal: false })
  return { db: db(), workspaceId: id, workspaceReadOnly: false, member: { role: 'owner' } }
}

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(scoringSetting, undefined)
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
})

const input = (page: Awaited<ReturnType<typeof scoringPage>>) => ({
  weights: page.current.weights,
  reverseDimensions: page.current.reverseDimensions,
  vetoThreshold: page.current.vetoThreshold,
  minDimensions: page.current.minDimensions,
  hardGates: page.current.hardGates,
  marginFloorBp: page.current.marginFloorBp,
})

describe('评分维度管理', () => {
  it('首次打开显示默认版本 1：等权、两个反向维度、否决阈值 30、毛利底线 15%', async () => {
    const owner = await space()
    const page = await scoringPage(owner)
    expect(page.current).toMatchObject({
      version: 1,
      reverseDimensions: ['competition', 'supply-timing'],
      vetoThreshold: 30,
      minDimensions: 4,
      marginFloorBp: 1500,
      hardGates: { compliance: true, timing: true, margin: true },
    })
    expect(Object.values(page.current.weights)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(page.dimensions.map((d) => d.label)).toContain('市场需求')
    expect(page.canWrite).toBe(true)
  })

  it('修改权重生成新版本，旧版本与已有线索不变', async () => {
    const owner = await space()
    const s = scoped(owner.db, owner.workspaceId)
    const before = await scoringPage(owner)
    const [dir] = await s.insert(direction, { name: '厨房', marketplaces: ['ebay-us'] }).returning()
    const [c] = await s
      .insert(cluster, { directionId: dir?.id as string, marketplace: 'ebay-us', name: '簇' })
      .returning()
    const [old] = await s
      .insert(lead, {
        clusterId: c?.id as string,
        directionId: dir?.id as string,
        leadOn: '2031-05-01',
        score: 62.5,
        grade: 'caution',
        settingVersion: 1,
      })
      .returning()

    const saved = await saveScoring(
      owner,
      {
        ...input(before),
        weights: { ...before.current.weights, 'market-demand': 2 },
        marginFloorBp: 2000,
      },
      null,
    )
    expect(saved).toMatchObject({ version: 2, marginFloorBp: 2000 })

    const after = await scoringPage(owner)
    expect(after.current.version).toBe(2)
    expect(after.current.weights['market-demand']).toBe(2)
    expect(after.history.map((h) => h.version)).toEqual([2, 1])
    const [v1] = await s.select(scoringSetting, { where: eq(scoringSetting.version, 1) })
    expect(v1?.weights['market-demand']).toBe(1)
    expect(v1?.marginFloorBp).toBe(1500)
    const [kept] = await s.select(lead, { where: eq(lead.id, old?.id as string) })
    expect(kept).toMatchObject({ score: 62.5, grade: 'caution', settingVersion: 1 })

    // 再改一次继续追加
    expect((await saveScoring(owner, input(after), null)).version).toBe(3)
    expect(await s.count(scoringSetting)).toBe(3)
  })

  it('member 与只读空间不能保存；全部权重为 0 被拒绝', async () => {
    const owner = await space()
    const page = await scoringPage(owner)
    await expect(
      saveScoring({ ...owner, member: { role: 'member' } }, input(page)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await expect(
      saveScoring({ ...owner, workspaceReadOnly: true }, input(page)),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY', status: 403 })
    expect((await scoringPage({ ...owner, member: { role: 'member' } })).canWrite).toBe(false)
    const zero = Object.fromEntries(
      Object.keys(page.current.weights).map((k) => [k, 0]),
    ) as typeof page.current.weights
    await expect(saveScoring(owner, { ...input(page), weights: zero })).rejects.toMatchObject({
      code: 'INVALID_SCORING_SETTING',
      status: 400,
    })
    expect((await scoringPage(owner)).current.version).toBe(1)
  })
})
