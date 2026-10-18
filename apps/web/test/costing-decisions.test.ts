import { env } from 'cloudflare:workers'
import {
  cluster,
  clusterSignal,
  costingScenario,
  costParam,
  createDb,
  decision,
  direction,
  followOutcome,
  lead,
  leadEvent,
  logisticsProfile,
  member,
  organization,
  scoped,
  supplier,
  supplierQuote,
  user,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  archivePage,
  decisionDetail,
  recordOutcome,
} from '../src/features/costing/archive.server.ts'
import {
  assertCostingEditable,
  type DecisionActor,
  decideLead,
  workbenchHome,
} from '../src/features/costing/decisions.server.ts'
import {
  costingSettings,
  deleteCostParam,
  deleteLogisticsProfile,
  effectiveCostParams,
  saveCostParam,
  saveLogisticsProfile,
} from '../src/features/costing/settings.server.ts'

// add-costing-decisions 2.2 / 3.2 / 4.1：物流方案与成本参数、待决定队列与决定、选品档案库快照。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []
const users: string[] = []

async function space(): Promise<DecisionActor> {
  const id = newId()
  const userId = newId()
  spaces.push(id)
  users.push(userId)
  await db()
    .insert(organization)
    .values({ id, name: 'Costing test', slug: `costing-${id.slice(-12)}`, isPersonal: false })
  await db()
    .insert(user)
    .values({ id: userId, name: 'Decider', email: `${userId}@costing.test` })
  await scoped(db(), id).insert(member, { id: newId(), userId, role: 'owner' })
  return {
    db: db(),
    workspaceId: id,
    workspaceReadOnly: false,
    member: { role: 'owner' },
    userId,
  }
}
const asMember = (a: DecisionActor): DecisionActor => ({ ...a, member: { role: 'member' } })

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(followOutcome, undefined)
    await s.delete(decision, undefined)
    await s.delete(leadEvent, undefined)
    await s.delete(costingScenario, undefined)
    await s.delete(supplierQuote, undefined)
    await s.delete(supplier, undefined)
    await s.delete(logisticsProfile, undefined)
    await s.delete(costParam, undefined)
    await s.delete(clusterSignal, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(member, undefined)
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
  await db().delete(user).where(inArray(user.id, users))
})

const ebayDirect = {
  name: 'eBay 直发 · 云途',
  platform: 'ebay' as const,
  type: 'ebay-direct' as const,
  transitDays: 12,
  lastMile: {
    kind: 'first-additional' as const,
    currency: 'cny',
    firstWeightG: 500,
    firstPriceMinor: 3000,
    stepWeightG: 500,
    stepPriceMinor: 1500,
    volumetricDivisor: 6000,
  },
  bannedAttributes: ['Battery', 'liquid', 'battery'],
}

describe('物流方案', () => {
  it('增改删；类型与平台、公式必填校验；同名冲突；成员只读', async () => {
    const owner = await space()
    const created = await saveLogisticsProfile(owner, undefined, ebayDirect)
    expect(created).toMatchObject({
      platform: 'ebay',
      headFreight: null,
      lastMile: { kind: 'first-additional', currency: 'CNY', volumetricDivisor: 6000 },
      bannedAttributes: ['battery', 'liquid'],
    })
    await expect(saveLogisticsProfile(owner, undefined, ebayDirect)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      saveLogisticsProfile(owner, undefined, { ...ebayDirect, name: 'x', platform: 'amazon' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      saveLogisticsProfile(owner, undefined, {
        ...ebayDirect,
        name: 'FBA 海运',
        platform: 'amazon',
        type: 'amazon-fba',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const fba = await saveLogisticsProfile(owner, undefined, {
      name: 'FBA 海运',
      platform: 'amazon',
      type: 'amazon-fba',
      transitDays: 35,
      headFreight: { kind: 'volume', currency: 'CNY', pricePerCbmMinor: 120_000, minCbm: 1 },
      // FBA 不需要尾程，传入也不保存
      lastMile: ebayDirect.lastMile,
      bannedAttributes: [],
    })
    expect(fba).toMatchObject({ headFreight: { kind: 'volume' }, lastMile: null })

    const updated = await saveLogisticsProfile(owner, created.id, {
      ...ebayDirect,
      type: 'ebay-overseas',
      headFreight: { kind: 'volume', currency: 'CNY', pricePerCbmMinor: 90_000 },
    })
    expect(updated).toMatchObject({ type: 'ebay-overseas', headFreight: { kind: 'volume' } })

    await expect(deleteLogisticsProfile(asMember(owner), fba.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await deleteLogisticsProfile(owner, fba.id)
    expect((await costingSettings(owner)).profiles.map((p) => p.id)).toEqual([created.id])
  })
})

describe('成本参数', () => {
  it('类目未填的项回退到平台默认并标注来源；默认值唯一；删除', async () => {
    const owner = await space()
    await saveCostParam(owner, undefined, {
      platform: 'amazon',
      commissionRate: 0.15,
      adRate: 0.08,
      returnRate: 0.03,
      fixedFeeMinor: 0,
    })
    await expect(
      saveCostParam(owner, undefined, { platform: 'amazon', commissionRate: 0.1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      saveCostParam(owner, undefined, { platform: 'amazon', categoryId: '123' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const params = await saveCostParam(owner, undefined, {
      platform: 'amazon',
      categoryId: ' 3760911 ',
      commissionRate: 0.08,
    })
    const category = params.find((p) => p.categoryId === '3760911')
    expect(category?.effective).toMatchObject({
      commissionRate: 0.08,
      adRate: 0.08,
      fixedFeeMinor: 0,
    })
    expect(category?.sources).toMatchObject({
      commissionRate: 'category',
      adRate: 'platform-default',
      returnRate: 'platform-default',
      storageMonthlyMinor: 'missing',
    })

    // 核算取值：未配置的类目整体回退到平台默认
    const other = await effectiveCostParams(owner, 'amazon', '999')
    expect(other.params.commissionRate).toBe(0.15)
    expect(other.sources.commissionRate).toBe('platform-default')
    expect((await effectiveCostParams(owner, 'amazon', '3760911')).params.commissionRate).toBe(0.08)

    // 修改平台默认后，类目回退值随之变化
    const fallback = params.find((p) => p.categoryId == null)
    await saveCostParam(owner, fallback?.id, {
      platform: 'amazon',
      commissionRate: 0.15,
      adRate: 0.1,
    })
    expect((await effectiveCostParams(owner, 'amazon', '3760911')).params.adRate).toBe(0.1)

    await deleteCostParam(owner, category?.id as string)
    expect((await costingSettings(owner)).params).toHaveLength(1)
    await expect(
      saveCostParam(asMember(owner), undefined, { platform: 'ebay', commissionRate: 0.13 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

// ---- 决定与档案库 ----

const NOW = new Date('2026-10-19T04:00:00Z') // 新加坡 10-19 12:00

async function seedLeads(actor: DecisionActor) {
  const s = scoped(actor.db, actor.workspaceId)
  const [dir] = await s
    .insert(direction, { name: '厨房收纳', marketplaces: ['ebay-us', 'amazon-us'] })
    .returning()
  if (!dir) throw new Error('seed failed')
  const profile = await saveLogisticsProfile(actor, undefined, ebayDirect)
  const [sup] = await s.insert(supplier, { name: '义乌工厂' }).returning()
  if (!sup) throw new Error('seed failed')

  async function makeLead(
    name: string,
    opts: {
      status: 'new' | 'costing' | 'pending'
      latest: string | null
      marketplace?: string
      selected?: Record<string, unknown>
    },
  ) {
    const [c] = await s
      .insert(cluster, {
        directionId: dir?.id as string,
        marketplace: opts.marketplace ?? 'ebay-us',
        name,
      })
      .returning()
    if (!c) throw new Error('seed failed')
    const [l] = await s
      .insert(lead, {
        clusterId: c.id,
        directionId: dir?.id as string,
        leadOn: '2026-10-15',
        score: 78,
        grade: 'recommend',
        confidence: 0.72,
        settingVersion: 3,
        latestDecisionOn: opts.latest,
        status: opts.status,
      })
      .returning()
    if (!l) throw new Error('seed failed')
    await s.insert(clusterSignal, {
      clusterId: c.id,
      observedOn: '2026-10-15',
      dimension: 'market-demand',
      score: 80,
      inputs: { observationIds: ['obs-1'], source: 'ebay-browse' },
    })
    let scenarioId: string | null = null
    if (opts.selected) {
      const [q] = await s
        .insert(supplierQuote, {
          supplierId: sup?.id as string,
          clusterId: c.id,
          tiers: [{ minQty: 1, unitPriceMinor: 1200 }],
          currency: 'CNY',
          confidence: 'confirmed',
          quotedOn: '2026-10-10',
          weightG: 400,
        })
        .returning()
      const [sc] = await s
        .insert(costingScenario, {
          leadId: l.id,
          quoteId: q?.id as string,
          profileId: profile.id,
          mode: 'same-source',
          plannedQty: 200,
          salePriceMinor: 1999,
          currency: 'USD',
          result: opts.selected,
          selected: true,
        })
        .returning()
      scenarioId = sc?.id ?? null
    }
    return { leadId: l.id, clusterId: c.id, scenarioId }
  }

  const result = (margin: number, deadline?: string) => ({
    ...(deadline ? { deadline } : {}),
    result: {
      status: 'ok',
      currency: 'USD',
      salePriceMinor: 1999,
      landedCostMinor: 820,
      netProfitMinor: Math.round(1999 * margin),
      grossMargin: margin,
      breakEvenMinor: 1078,
    },
  })
  return {
    directionId: dir.id,
    // 5 天后 → 橙
    soon: await makeLead('硅胶折叠水杯', {
      status: 'pending',
      latest: '2026-12-01',
      selected: result(0.31, '2026-10-24'),
    }),
    // 已过期 → 红（组合没有日期时用线索的估算）
    overdue: await makeLead('磁吸调料架', {
      status: 'pending',
      latest: '2026-10-10',
      marketplace: 'amazon-us',
      selected: result(0.18).result,
    }),
    later: await makeLead('抽屉分隔板', {
      status: 'pending',
      latest: '2026-12-20',
      selected: result(0.25),
    }),
    fresh: await makeLead('沥水篮', { status: 'new', latest: null }),
    costing: await makeLead('保鲜盒', { status: 'costing', latest: null }),
  }
}

describe('待决定队列与决定', () => {
  let owner: DecisionActor
  let seeded: Awaited<ReturnType<typeof seedLeads>>
  beforeAll(async () => {
    owner = await space()
    seeded = await seedLeads(owner)
  })

  it('首页 KPI 与队列：按最晚决定日升序，5 天内标橙、过期标红，显示所选组合毛利率', async () => {
    const home = await workbenchHome(owner, NOW)
    expect(home.today).toBe('2026-10-19')
    expect(home.kpi).toMatchObject({ candidates: 2, pending: 3, decidedThisWeek: 0 })
    expect(home.queue.map((r) => [r.clusterName, r.deadline, r.tone])).toEqual([
      ['磁吸调料架', '2026-10-10', 'overdue'],
      ['硅胶折叠水杯', '2026-10-24', 'soon'],
      ['抽屉分隔板', '2026-12-20', 'normal'],
    ])
    expect(home.queue[1]?.scenario).toMatchObject({
      grossMargin: 0.31,
      landedCostMinor: 820,
      currency: 'USD',
    })
  })

  it('跟卖：写决定快照与 lead_event，线索变为 followed，之后不能再决定或改核算', async () => {
    await expect(
      decideLead(asMember(owner), seeded.soon.leadId, { kind: 'drop', reason: 'timing' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const done = await decideLead(owner, seeded.soon.leadId, {
      kind: 'follow',
      firstBatchQty: 200,
      targetPriceMinor: 1999,
      currency: 'usd',
      plannedListingOn: '2026-08-01',
    })
    expect(done.status).toBe('followed')
    const s = scoped(owner.db, owner.workspaceId)
    expect((await s.findById(lead, seeded.soon.leadId)).status).toBe('followed')
    const row = await s.findById(decision, done.decisionId)
    expect(row).toMatchObject({
      kind: 'follow',
      currency: 'USD',
      scenarioId: seeded.soon.scenarioId,
      decidedBy: owner.userId,
    })
    expect(row.snapshot).toMatchObject({
      lead: { score: 78, grade: 'recommend', confidence: 0.72, settingVersion: 3 },
      cluster: { name: '硅胶折叠水杯', marketplace: 'ebay-us' },
      direction: { name: '厨房收纳' },
      scenario: { id: seeded.soon.scenarioId, result: { result: { grossMargin: 0.31 } } },
      signals: [{ dimension: 'market-demand', inputs: { observationIds: ['obs-1'] } }],
    })
    const events = await s.select(leadEvent, { where: eq(leadEvent.leadId, seeded.soon.leadId) })
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'status',
        actorUserId: owner.userId,
        payload: { from: 'pending', to: 'followed', decisionId: done.decisionId },
      }),
    ])

    await expect(
      decideLead(owner, seeded.soon.leadId, { kind: 'drop', reason: 'timing' }),
    ).rejects.toMatchObject({ code: 'LEAD_DECIDED' })
    await expect(assertCostingEditable(owner, seeded.soon.leadId)).rejects.toMatchObject({
      code: 'LEAD_DECIDED',
      status: 409,
    })
    await expect(assertCostingEditable(owner, seeded.later.leadId)).resolves.toMatchObject({
      status: 'pending',
    })
  })

  it('放弃：原因必填说明“其他”；无选定组合不能跟卖但可以放弃', async () => {
    await expect(
      decideLead(owner, seeded.fresh.leadId, {
        kind: 'follow',
        firstBatchQty: 1,
        targetPriceMinor: 100,
        currency: 'USD',
        plannedListingOn: '2026-11-01',
      }),
    ).rejects.toMatchObject({ code: 'NO_SELECTED_SCENARIO' })
    await expect(
      decideLead(owner, seeded.overdue.leadId, { kind: 'drop', reason: 'other' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const dropped = await decideLead(owner, seeded.overdue.leadId, {
      kind: 'drop',
      reason: 'competition',
      note: '头部卖家降价',
    })
    expect(dropped.status).toBe('dropped')
    await decideLead(owner, seeded.fresh.leadId, { kind: 'drop', reason: 'low-margin' })

    const home = await workbenchHome(owner, NOW)
    expect(home.kpi).toMatchObject({ candidates: 1, pending: 1, decidedThisWeek: 3 })
    expect(home.queue.map((r) => r.clusterName)).toEqual(['抽屉分隔板'])
  })

  it('档案库：显示快照而不是重算值；筛选；到期待回看；录入回看后与预测对比', async () => {
    const s = scoped(owner.db, owner.workspaceId)
    // 决定之后线索重算、组合结果变化，档案库仍显示决定时的值
    await s.updateById(lead, seeded.soon.leadId, { score: 41, settingVersion: 9 })
    await s.update(
      costingScenario,
      { result: { status: 'ok', grossMargin: 0.02 } },
      eq(costingScenario.leadId, seeded.soon.leadId),
    )

    const page = await archivePage(owner, {}, NOW)
    expect(page.rows).toHaveLength(3)
    const follow = page.rows.find((r) => r.kind === 'follow')
    expect(follow).toMatchObject({
      clusterName: '硅胶折叠水杯',
      score: 78,
      settingVersion: 3,
      scenario: { grossMargin: 0.31 },
      // 计划上架日 08-01 + 30 天 = 08-31，已到期
      review: { status: 'due', dueOn: '2026-08-31', notified: false },
    })
    expect(page.pendingReviews).toBe(1)
    const dropped = page.rows.find((r) => r.clusterName === '磁吸调料架')
    expect(dropped).toMatchObject({
      kind: 'drop',
      dropReason: 'competition',
      review: { status: 'n/a' },
    })

    expect((await archivePage(owner, { kind: 'drop' }, NOW)).rows).toHaveLength(2)
    expect(
      (await archivePage(owner, { platform: 'amazon' }, NOW)).rows.map((r) => r.clusterName),
    ).toEqual(['磁吸调料架'])
    expect((await archivePage(owner, { directionId: seeded.directionId }, NOW)).rows).toHaveLength(
      3,
    )
    expect(
      (await archivePage(owner, { from: '2026-01-01', to: '2026-01-31' }, NOW)).rows,
    ).toHaveLength(0)

    const detail = await decisionDetail(owner, follow?.id as string, NOW)
    expect(detail.snapshot.lead.score).toBe(78)

    const reviewed = await recordOutcome(owner, follow?.id as string, {
      actualUnits: 150,
      actualPriceMinor: 1899,
    })
    expect(reviewed.review).toMatchObject({
      status: 'reviewed',
      outcome: {
        actualUnits: 150,
        comparison: { firstBatchQty: 200, sellThrough: 0.75, predictedMargin: 0.31 },
      },
    })
    if (reviewed.review.status !== 'reviewed') throw new Error('unreachable')
    expect(reviewed.review.outcome.comparison.priceDeltaRate).toBeCloseTo(-0.05, 3)
    // 再次录入视为更正
    await recordOutcome(owner, follow?.id as string, { actualUnits: 160 })
    expect(await s.count(followOutcome)).toBe(1)
    await expect(
      recordOutcome(owner, dropped?.id as string, { actualUnits: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await archivePage(owner, {}, NOW)).pendingReviews).toBe(0)

    // 其他空间看不到
    const other = await space()
    expect((await archivePage(other, {}, NOW)).rows).toEqual([])
    await expect(decisionDetail(other, follow?.id as string)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
