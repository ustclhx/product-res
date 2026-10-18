import {
  direction,
  directionSeller,
  lead,
  readinessStat,
  recommendation,
  recommendationLabel,
  scoped,
  seasonalNode,
} from '@product-res/db'
import { addDays } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { and, eq, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  labelDueRecommendations,
  recomputeReadiness,
  runSelectionForWorkspace,
} from '../src/index.ts'
import {
  cleanup,
  createWorkspace,
  insertProduct,
  type Obs,
  observe,
  testDb,
  url,
} from './helpers.ts'

// add-shadow-validation tasks 5.1 验收：全部由流水线产生样本（不手工插入推荐），
// 用推进的“当前日期”参数（asOf / today）代替等待真实时间：
// 20 天每日流水线冻结影子推荐 → 到期（T+14 / T+30）打标签 → 准备度 19 → 20 样本从冷启动进入观察期
// → 之后的线索显示等级、置信度历史命中率 = Wilson 下界。
const db = testDb()
const D = '2033-03-01'
const DAYS = 20
const tag = newId().slice(-10)
const productIds: string[] = []
let workspaceId = ''
let directionId = ''

const at = (day: string) => new Date(`${day}T00:00:00+08:00`)

describe.skipIf(!url)('影子验证验收：冻结 → 到期打标签 → 准备度流转', () => {
  beforeAll(async () => {
    workspaceId = await createWorkspace(db, 'ShadowAcceptance')
    const s = scoped(db, workspaceId)
    const [node] = await s
      .insert(seasonalNode, {
        // 节点足够远：整个验收期内时间余量都超过提前期，主导信号类型保持不变
        name: `秋季节点-${tag}`,
        startMonth: 9,
        startDay: 30,
        salesDays: 45,
        keywords: [],
      })
      .returning()
    const [row] = await s
      .insert(direction, {
        name: '验收方向',
        marketplaces: ['ebay-us'],
        categoryIds: [`shadow-${tag}`],
        nodeIds: [node?.id as string],
      })
      .returning()
    directionId = row?.id as string
    await s.insert(directionSeller, {
      directionId,
      marketplace: 'ebay-us',
      sellerPlatformId: `seed-${tag}`,
      status: 'seed',
    })
    const id = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `shadow-${tag}`,
      title: 'Bamboo Spice Rack Organizer 3 Tier',
      categoryId: `shadow-${tag}`,
      sellerId: `seed-${tag}`,
      listedOn: addDays(D, -5),
      firstSeenOn: addDays(D, -40),
    })
    productIds.push(id)
    // 冻结前 30 天到最后一个冻结日后 30 天的每日观测：每天卖 2 件（30 天 60 件 ≥ 30），价格稳定
    const rows: Obs[] = []
    for (let k = -30; k <= DAYS + 31; k += 1) {
      const observedOn = addDays(D, k)
      rows.push(
        { entityId: id, metric: 'sold_quantity_total', observedOn, value: 500 + 2 * (k + 30) },
        { entityId: id, metric: 'price', observedOn, value: 20 },
        { entityId: id, metric: 'review_count', observedOn, value: 40 },
      )
    }
    await observe(db, rows)
  })

  afterAll(async () => {
    if (!url) return
    await cleanup(db, workspaceId, productIds)
  })

  const recs = () =>
    scoped(db, workspaceId).select(recommendation, {
      where: eq(recommendation.sampleKind, 'shadow'),
    })
  const statOn = async (day: string) => {
    const rows = await scoped(db, workspaceId).select(readinessStat, {
      where: and(
        eq(readinessStat.directionId, directionId),
        eq(readinessStat.computedOn, day),
      ) as SQL,
    })
    return rows.find((r) => r.effectiveSamples > 0) ?? rows[0]
  }

  it('每日流水线冻结影子推荐；同日重跑不重复、冻结值不变', async () => {
    for (let i = 0; i < DAYS; i += 1) {
      const day = addDays(D, i)
      const run = await runSelectionForWorkspace(db, workspaceId, { now: at(day), asOf: day })
      expect(run.failures).toEqual([])
    }
    const frozen = await recs()
    expect(frozen).toHaveLength(DAYS)
    expect(new Set(frozen.map((r) => r.signalType)).size).toBe(1)
    const before = frozen.map((r) => `${r.id}|${r.score}|${r.settingVersion}`).sort()
    await runSelectionForWorkspace(db, workspaceId, { now: at(D), asOf: D })
    expect((await recs()).map((r) => `${r.id}|${r.score}|${r.settingVersion}`).sort()).toEqual(
      before,
    )
    // 冷启动：线索保存等级但界面显示“未验证”
    const [first] = await scoped(db, workspaceId).select(lead, { where: eq(lead.leadOn, D) })
    expect(first?.confidenceDetail).toMatchObject({
      readiness: 'cold-start',
      displayGrade: 'unverified',
    })
  })

  it('推进日期到期打标签：T+14 先到期，T+30 逐日到期；重复运行幂等', async () => {
    const s = scoped(db, workspaceId)
    // 第一个冻结日 + 14：只有 D 的 14 天窗口到期
    const t14 = await labelDueRecommendations(db, workspaceId, {
      now: at(addDays(D, 14)),
      today: addDays(D, 14),
    })
    expect(t14).toMatchObject({ labeled: 1, failures: 0 })
    const [l14] = await s.select(recommendationLabel)
    expect(l14).toMatchObject({ windowDays: 14, outcome: 'miss', salesDelta: 28 })

    // 最后一个冻结日 + 29：前 19 条的 T+30 到期
    const day19 = addDays(D, DAYS - 1 + 29)
    await labelDueRecommendations(db, workspaceId, { now: at(day19), today: day19 })
    const t30 = (await s.select(recommendationLabel)).filter((l) => l.windowDays === 30)
    expect(t30).toHaveLength(DAYS - 1)
    expect(t30.every((l) => l.outcome === 'hit' && l.salesDelta === 60)).toBe(true)
    const total = await s.count(recommendationLabel)
    expect(
      (await labelDueRecommendations(db, workspaceId, { now: at(day19), today: day19 })).labeled,
    ).toBe(0)
    expect(await s.count(recommendationLabel)).toBe(total)
  })

  it('准备度：有效样本 19 仍为冷启动；推进一天第 20 条到期后进入观察期，线索显示等级', async () => {
    const day19 = addDays(D, DAYS - 1 + 29)
    await recomputeReadiness(db, workspaceId, { now: at(day19), today: day19 })
    expect(await statOn(day19)).toMatchObject({
      effectiveSamples: DAYS - 1,
      hitCount: DAYS - 1,
      level: 'cold-start',
    })
    await runSelectionForWorkspace(db, workspaceId, { now: at(day19), asOf: day19 })
    const [cold] = await scoped(db, workspaceId).select(lead, { where: eq(lead.leadOn, day19) })
    expect(cold?.confidenceDetail).toMatchObject({
      readiness: 'cold-start',
      displayGrade: 'unverified',
    })

    const day20 = addDays(day19, 1)
    const labeled = await labelDueRecommendations(db, workspaceId, { now: at(day20), today: day20 })
    expect(labeled.labeled).toBeGreaterThanOrEqual(1)
    await recomputeReadiness(db, workspaceId, { now: at(day20), today: day20 })
    const stat = await statOn(day20)
    expect(stat).toMatchObject({
      effectiveSamples: DAYS,
      shadowCount: DAYS,
      hitCount: DAYS,
      level: 'observation',
    })
    expect(stat?.wilsonLower).toBeGreaterThan(0.8)

    await runSelectionForWorkspace(db, workspaceId, { now: at(day20), asOf: day20 })
    const [shown] = await scoped(db, workspaceId).select(lead, { where: eq(lead.leadOn, day20) })
    const detail = shown?.confidenceDetail as {
      readiness: string
      displayGrade: string
      level: string
      items: { id: string; value: number | null }[]
    }
    expect(detail.readiness).toBe('observation')
    expect(detail.displayGrade).not.toBe('unverified')
    expect(detail.level).not.toBe('high')
    expect(detail.items.find((i) => i.id === 'history-hit-rate')?.value).toBe(stat?.wilsonLower)
  })
})
