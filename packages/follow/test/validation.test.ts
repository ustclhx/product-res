import {
  cluster,
  direction,
  directionSeller,
  lead,
  readinessStat,
  recommendation,
  recommendationLabel,
  scoped,
  seasonalNode,
  weightSuggestion,
} from '@product-res/db'
import { addDays, DIMENSIONS } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { and, eq, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptSuggestion,
  currentScoringSetting,
  directionBaseline,
  dismissSuggestion,
  getValidationOverview,
  labelDueRecommendations,
  proposeWeights,
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

// tasks 2.2 / 2.3 / 3.2：真实 PG 上的冻结 → 到期打标签 → 准备度 → 等级显示，以及权重建议的采用 / 忽略
const db = testDb()
const D = '2032-03-01'
const now = new Date(`${D}T00:00:00+08:00`)
const tag = newId().slice(-10)
let workspaceId = ''
let weightsWorkspace = ''
const productIds: string[] = []
let dirA = ''
let dirB = ''

const pipelineData = (id: string): Obs[] => [
  ...[
    [-30, 100],
    [-7, 160],
    [0, 220],
  ].flatMap(([offset, sold]) => [
    {
      entityId: id,
      metric: 'sold_quantity_total',
      observedOn: addDays(D, offset as number),
      value: sold as number,
    },
    { entityId: id, metric: 'price', observedOn: addDays(D, offset as number), value: 20 },
    { entityId: id, metric: 'review_count', observedOn: addDays(D, offset as number), value: 50 },
  ]),
]

const leadOf = async (directionId: string, day: string) => {
  const [row] = await scoped(db, workspaceId).select(lead, {
    where: and(eq(lead.directionId, directionId), eq(lead.leadOn, day)) as SQL,
  })
  return row
}

const recOf = async (directionId: string, day: string) => {
  const [row] = await scoped(db, workspaceId).select(recommendation, {
    where: and(
      eq(recommendation.directionId, directionId),
      eq(recommendation.frozenOn, day),
      eq(recommendation.sampleKind, 'shadow'),
    ) as SQL,
  })
  return row
}

describe.skipIf(!url)('影子验证：冻结、打标签与准备度', () => {
  beforeAll(async () => {
    workspaceId = await createWorkspace(db, 'Validation')
    const s = scoped(db, workspaceId)
    const [node] = await s
      .insert(seasonalNode, {
        name: `返校季-${tag}`,
        startMonth: 7,
        startDay: 15,
        salesDays: 45,
        keywords: [],
      })
      .returning()
    const nodeIds = [node?.id as string]
    const [a] = await s
      .insert(direction, {
        name: '方向 A',
        marketplaces: ['ebay-us'],
        categoryIds: [`catA-${tag}`],
        nodeIds,
      })
      .returning()
    const [b] = await s
      .insert(direction, {
        name: '方向 B',
        marketplaces: ['ebay-us'],
        categoryIds: [`catB-${tag}`],
        nodeIds,
      })
      .returning()
    dirA = a?.id as string
    dirB = b?.id as string
    await s.insert(directionSeller, [
      { directionId: dirA, marketplace: 'ebay-us', sellerPlatformId: `s1-${tag}`, status: 'seed' },
      { directionId: dirB, marketplace: 'ebay-us', sellerPlatformId: `s3-${tag}`, status: 'seed' },
    ])
    const p1 = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `p1-${tag}`,
      title: 'Bamboo Spice Rack Organizer',
      categoryId: `catA-${tag}`,
      sellerId: `s1-${tag}`,
      gtin: `9${tag.replace(/\D/g, '').padEnd(11, '1').slice(0, 11)}`,
      listedOn: addDays(D, -5),
      firstSeenOn: addDays(D, -20),
    })
    const p2 = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `p2-${tag}`,
      title: 'Bamboo Spice Rack Organizer Shelf',
      categoryId: `catA-${tag}`,
      sellerId: `s2-${tag}`,
      listedOn: addDays(D, -10),
      firstSeenOn: addDays(D, -20),
    })
    const q1 = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: `q1-${tag}`,
      title: 'Silicone Baking Mat Non Stick',
      categoryId: `catB-${tag}`,
      sellerId: `s3-${tag}`,
      listedOn: addDays(D, -100),
      firstSeenOn: addDays(D, -100),
    })
    productIds.push(p1, p2, q1)
    // 冻结后 30 天：每天卖 1.5 件（T+30 共 45 件），价格匀速跌到 18.4（跌 8%）
    const after: Obs[] = []
    for (let k = 1; k <= 30; k += 1) {
      after.push(
        {
          entityId: p1,
          metric: 'sold_quantity_total',
          observedOn: addDays(D, k),
          value: 220 + 1.5 * k,
        },
        { entityId: p1, metric: 'price', observedOn: addDays(D, k), value: 20 - (1.6 * k) / 30 },
      )
    }
    await observe(db, [
      ...pipelineData(p1),
      { entityId: p2, metric: 'price', observedOn: D, value: 20 },
      ...pipelineData(q1),
      ...after,
    ])
    const run = await runSelectionForWorkspace(db, workspaceId, { now, asOf: D })
    expect(run.failures).toEqual([])
  })

  afterAll(async () => {
    if (!url) return
    await cleanup(db, workspaceId, productIds)
  })

  it('每条有分数的当日线索冻结为影子推荐，记录信号类型、权重版本与输入快照', async () => {
    const recA = await recOf(dirA, D)
    const leadA = await leadOf(dirA, D)
    expect(recA).toMatchObject({
      leadId: leadA?.id,
      sampleKind: 'shadow',
      settingVersion: 1,
      score: leadA?.score,
      marketplace: 'ebay-us',
    })
    const leadDetail = leadA?.confidenceDetail as { signalType: string } | undefined
    expect(recA?.signalType).toBe(leadDetail?.signalType)
    const inputs = recA?.inputs as { members: string[]; dimensions: Record<string, unknown> }
    expect(inputs.members.sort()).toEqual([productIds[0], productIds[1]].sort())
    expect(Object.keys(inputs.dimensions).sort()).toEqual([...DIMENSIONS].sort())
  })

  it('到期打标签：T+14 未命中、T+30 命中（45 件、跌 8%），记录来源；重复运行幂等', async () => {
    const today = addDays(D, 30)
    const first = await labelDueRecommendations(db, workspaceId, { now, today })
    expect(first.failures).toBe(0)
    const recA = await recOf(dirA, D)
    const s = scoped(db, workspaceId)
    const labels = await s.select(recommendationLabel, {
      where: eq(recommendationLabel.recommendationId, recA?.id as string),
    })
    const byWindow = new Map(labels.map((l) => [l.windowDays, l]))
    expect(byWindow.get(14)).toMatchObject({ outcome: 'miss', salesDelta: 21 })
    expect(byWindow.get(30)).toMatchObject({ outcome: 'hit', salesDelta: 45, priceDropRate: 0.08 })
    expect(byWindow.get(30)?.sources).toMatchObject({
      salesMetrics: ['sold_quantity_total'],
      salesSources: ['ebay-browse'],
    })
    expect(byWindow.has(60)).toBe(false)
    // 方向 B 冻结后没有观测：数据不足
    const recB = await recOf(dirB, D)
    const [labelB] = await s.select(recommendationLabel, {
      where: and(
        eq(recommendationLabel.recommendationId, recB?.id as string),
        eq(recommendationLabel.windowDays, 30),
      ) as SQL,
    })
    expect(labelB?.outcome).toBe('insufficient')

    const total = await s.count(recommendationLabel)
    const again = await labelDueRecommendations(db, workspaceId, { now, today })
    expect(again.labeled).toBe(0)
    expect(await s.count(recommendationLabel)).toBe(total)
  })

  it('基线：抽取同方向新品按同标准打标签，样本不写入推荐表', async () => {
    const s = scoped(db, workspaceId)
    const before = await s.count(recommendation)
    const baseline = await directionBaseline(db, workspaceId, {
      directionId: dirA,
      marketplace: 'ebay-us',
      asOf: addDays(D, 30),
    })
    // p1、p2 都在冻结日前 30 天内上架；p2 冻结后无观测为数据不足；有效样本 < 5 时基线未知
    expect(baseline).toMatchObject({ sampled: 2, labeled: 1, hits: 1, hitRate: null, frozenOn: D })
    expect(await s.count(recommendation)).toBe(before)
  })

  it('有效样本 19 → 20：准备度从冷启动进入观察期，线索开始显示等级，置信度上限为中', async () => {
    const day = addDays(D, 1)
    const s = scoped(db, workspaceId)
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: day })
    const cold = await leadOf(dirB, day)
    const detail = cold?.confidenceDetail as {
      signalType: string
      readiness: string
      displayGrade: string
    }
    expect(detail.readiness).toBe('cold-start')
    expect(detail.displayGrade).toBe('unverified')
    const signalType = detail.signalType as (typeof DIMENSIONS)[number]
    const clusterId = cold?.clusterId as string

    const addSamples = async (from: number, count: number) => {
      for (let i = from; i < from + count; i += 1) {
        const [rec] = await s
          .insert(recommendation, {
            clusterId,
            directionId: dirB,
            frozenOn: addDays('2031-01-01', i),
            marketplace: 'ebay-us',
            signalType,
            score: 70,
            grade: 'caution',
            confidence: 0.5,
            settingVersion: 1,
            inputs: {},
            sampleKind: 'shadow',
          })
          .returning()
        await s.insert(recommendationLabel, {
          recommendationId: rec?.id as string,
          windowDays: 30,
          outcome: 'hit',
          labeledAt: new Date(`${addDays('2031-02-01', i)}T00:00:00Z`),
        })
      }
    }
    const statOf = async () => {
      const [row] = await s.select(readinessStat, {
        where: and(
          eq(readinessStat.directionId, dirB),
          eq(readinessStat.signalType, signalType),
          eq(readinessStat.computedOn, day),
        ) as SQL,
      })
      return row
    }

    await addSamples(0, 19)
    await recomputeReadiness(db, workspaceId, { now, today: day })
    expect(await statOf()).toMatchObject({ effectiveSamples: 19, level: 'cold-start' })
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: day })
    const still = (await leadOf(dirB, day))?.confidenceDetail as {
      displayGrade: string
      items: { id: string; value: number | null }[]
    }
    expect(still.displayGrade).toBe('unverified')
    expect(still.items.find((i) => i.id === 'history-hit-rate')?.value).toBeNull()

    await addSamples(19, 1)
    await recomputeReadiness(db, workspaceId, { now, today: day })
    const stat = await statOf()
    expect(stat).toMatchObject({
      effectiveSamples: 20,
      shadowCount: 20,
      hitCount: 20,
      level: 'observation',
    })
    expect(stat?.wilsonLower).toBeGreaterThan(0.8)
    await runSelectionForWorkspace(db, workspaceId, { now, asOf: day })
    const shown = await leadOf(dirB, day)
    const shownDetail = shown?.confidenceDetail as {
      readiness: string
      displayGrade: string
      level: string
      items: { id: string; value: number | null }[]
    }
    expect(shownDetail.readiness).toBe('observation')
    expect(shownDetail.displayGrade).not.toBe('unverified')
    expect(shownDetail.displayGrade).not.toBeNull()
    expect(shownDetail.level).not.toBe('high')
    expect(shownDetail.items.find((i) => i.id === 'history-hit-rate')?.value).toBe(
      stat?.wilsonLower,
    )

    const overview = await getValidationOverview(db, workspaceId, {
      now: new Date(`${day}T12:00:00+08:00`),
    })
    const cell = overview.readiness.find(
      (c) => c.directionId === dirB && c.signalType === signalType,
    )
    expect(cell).toMatchObject({
      level: 'observation',
      samplesToObservation: 0,
      directionName: '方向 B',
    })
    expect(overview.coldStart.allColdStart).toBe(false)
    expect(overview.composition.labeled.shadow).toBeGreaterThanOrEqual(21)
  })
})

describe.skipIf(!url)('权重拟合建议', () => {
  let clusterId = ''
  let directionId = ''

  beforeAll(async () => {
    weightsWorkspace = await createWorkspace(db, 'Weights')
    const s = scoped(db, weightsWorkspace)
    const [row] = await s.insert(direction, { name: '拟合', marketplaces: ['ebay-us'] }).returning()
    directionId = row?.id as string
    const [c] = await s
      .insert(cluster, { directionId, marketplace: 'ebay-us', name: '拟合簇' })
      .returning()
    clusterId = c?.id as string
  })

  afterAll(async () => {
    if (!url) return
    await cleanup(db, weightsWorkspace, [])
  })

  /** 需求分高（≥ 55）即命中，其他维度与结果无关 */
  const addSamples = async (from: number, count: number) => {
    const s = scoped(db, weightsWorkspace)
    for (let i = from; i < from + count; i += 1) {
      const demand = 20 + ((i * 37) % 71)
      const other = 30 + ((i * 53) % 41)
      const [rec] = await s
        .insert(recommendation, {
          clusterId,
          directionId,
          frozenOn: addDays('2031-01-01', i),
          marketplace: 'ebay-us',
          signalType: 'market-demand',
          score: 60,
          grade: 'caution',
          confidence: 0.5,
          settingVersion: 1,
          inputs: {
            dimensions: {
              'market-demand': { score: demand },
              'peer-spread': { score: other },
              competition: { score: 100 - other },
              compliance: { score: 40 },
            },
          },
          sampleKind: 'shadow',
        })
        .returning()
      await s.insert(recommendationLabel, {
        recommendationId: rec?.id as string,
        windowDays: 30,
        outcome: demand >= 55 ? 'hit' : 'miss',
      })
    }
  }

  it('有效样本不足时返回原因，不写建议', async () => {
    await addSamples(0, 30)
    const result = await proposeWeights(db, weightsWorkspace)
    expect(result).toMatchObject({ ok: false, effectiveSamples: 30 })
    expect(result.ok ? '' : result.reason).toContain('少于拟合下限')
    expect(await scoped(db, weightsWorkspace).count(weightSuggestion)).toBe(0)
  })

  it('采用生成新评分设置版本；忽略不改设置', async () => {
    await addSamples(30, 40)
    const proposed = await proposeWeights(db, weightsWorkspace)
    if (!proposed.ok) throw new Error(proposed.reason)
    const weights = proposed.suggestion.suggestedWeights
    expect(proposed.suggestion.status).toBe('proposed')
    expect(Math.max(...Object.values(weights))).toBe(weights['market-demand'])
    expect(proposed.suggestion.metrics).toMatchObject({ baseVersion: 1 })

    const accepted = await acceptSuggestion(db, weightsWorkspace, proposed.suggestion.id)
    expect(accepted.version).toBe(2)
    expect(accepted.suggestion).toMatchObject({
      status: 'accepted',
      metrics: expect.objectContaining({ acceptedVersion: 2 }),
    })
    const current = await currentScoringSetting(db, weightsWorkspace)
    expect(current.version).toBe(2)
    expect(current.weights).toEqual(weights)
    await expect(acceptSuggestion(db, weightsWorkspace, proposed.suggestion.id)).rejects.toThrow()

    const second = await proposeWeights(db, weightsWorkspace)
    if (!second.ok) throw new Error(second.reason)
    const dismissed = await dismissSuggestion(db, weightsWorkspace, second.suggestion.id)
    expect(dismissed.status).toBe('dismissed')
    expect((await currentScoringSetting(db, weightsWorkspace)).version).toBe(2)
    await expect(dismissSuggestion(db, weightsWorkspace, second.suggestion.id)).rejects.toThrow(
      '已被采用或忽略',
    )

    const overview = await getValidationOverview(db, weightsWorkspace, { now })
    expect(overview.latestSuggestion).toMatchObject({
      id: second.suggestion.id,
      status: 'dismissed',
    })
    expect(overview.composition).toMatchObject({
      recommendations: { shadow: 70, replay: 0, import: 0 },
      labeled: { shadow: 70, replay: 0, import: 0 },
    })
    expect(overview.readiness).toEqual([])
    expect(overview.coldStart).toMatchObject({ allColdStart: true, samplesNeeded: 20 })
    const ids = (await scoped(db, weightsWorkspace).select(weightSuggestion)).map((w) => w.id)
    expect(ids).toEqual(expect.arrayContaining([proposed.suggestion.id, second.suggestion.id]))
  })
})
