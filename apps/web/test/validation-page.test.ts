import { env } from 'cloudflare:workers'
import {
  cluster,
  clusterMember,
  createDb,
  direction,
  marketplaceProduct,
  organization,
  readinessStat,
  recommendation,
  recommendationLabel,
  scoped,
  scoringSetting,
  seasonalNode,
  syncRun,
  weightSuggestion,
} from '@product-res/db'
import type { ReplayMessage } from '@product-res/follow'
import { addDays } from '@product-res/selection'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { scoringPage } from '../src/features/data-center/scoring.server.ts'
import {
  previewReplay,
  proposeSuggestion,
  resolveSuggestion,
  startKeepaReplay,
  validationPage,
} from '../src/features/validation/validation.server.ts'
import type { WorkbenchActor } from '../src/features/workbench/actor.ts'

// add-shadow-validation 4.1：算法验证页的 service（server function 的实现）在真实 PG 上的行为。
const db = () => createDb(env.HYPERDRIVE)
const spaces: string[] = []
const products: string[] = []
const runs: string[] = []
const now = new Date('2032-03-01T00:00:00+08:00')

async function space(): Promise<WorkbenchActor> {
  const id = newId()
  spaces.push(id)
  await db()
    .insert(organization)
    .values({ id, name: 'Validation test', slug: `validation-${id.slice(-12)}`, isPersonal: false })
  return { db: db(), workspaceId: id, workspaceReadOnly: false, member: { role: 'owner' } }
}

afterAll(async () => {
  if (runs.length) await db().delete(syncRun).where(inArray(syncRun.id, runs))
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(weightSuggestion, undefined)
    await s.delete(recommendationLabel, undefined)
    await s.delete(recommendation, undefined)
    await s.delete(readinessStat, undefined)
    await s.delete(clusterMember, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(seasonalNode, undefined)
    await s.delete(scoringSetting, undefined)
  }
  if (products.length)
    await db().delete(marketplaceProduct).where(inArray(marketplaceProduct.id, products))
  await db().delete(organization).where(inArray(organization.id, spaces))
})

async function directionWithCluster(actor: WorkbenchActor, marketplace: string) {
  const s = scoped(actor.db, actor.workspaceId)
  const [dir] = await s
    .insert(direction, { name: `方向 ${marketplace}`, marketplaces: [marketplace] })
    .returning()
  const [c] = await s
    .insert(cluster, { directionId: dir?.id as string, marketplace, name: '簇' })
    .returning()
  return { directionId: dir?.id as string, clusterId: c?.id as string }
}

/** 需求分 ≥ 55 即命中的可分样本（与 packages/follow 的拟合测试同一构造） */
async function addSamples(
  actor: WorkbenchActor,
  target: { directionId: string; clusterId: string },
  from: number,
  count: number,
) {
  const s = scoped(actor.db, actor.workspaceId)
  for (let i = from; i < from + count; i += 1) {
    const demand = 20 + ((i * 37) % 71)
    const other = 30 + ((i * 53) % 41)
    const [rec] = await s
      .insert(recommendation, {
        ...target,
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
      labeledAt: new Date('2032-02-10T00:00:00Z'),
    })
  }
}

const fakeQueue = () => {
  const sent: ReplayMessage[] = []
  return { sent, queue: { send: async (body: ReplayMessage) => void sent.push(body) } }
}

describe('算法验证页', () => {
  it('冷启动空间：无统计、全部冷启动、无曲线数据，评分维度显示无样本', async () => {
    const owner = await space()
    const page = await validationPage(owner, { now })
    expect(page.readiness).toEqual([])
    expect(page.coldStart).toMatchObject({ allColdStart: true, samplesNeeded: 20 })
    expect(page.monthly.every((m) => m.hitRate === null && m.effectiveSamples === 0)).toBe(true)
    expect(page.latestSuggestion).toBeNull()
    expect(page.replays).toEqual([])
    expect(page.canWrite).toBe(true)
    const scoring = await scoringPage(owner)
    expect(scoring.dimensions.every((d) => d.backtest === null)).toBe(true)
  })

  it('样本不足时“生成建议”返回原因且不写库', async () => {
    const owner = await space()
    const target = await directionWithCluster(owner, 'ebay-us')
    await addSamples(owner, target, 0, 30)
    const result = await proposeSuggestion(owner)
    expect(result).toMatchObject({ ok: false, effectiveSamples: 30 })
    expect(result.ok ? '' : result.reason).toContain('少于拟合下限 50')
    expect(await scoped(owner.db, owner.workspaceId).count(weightSuggestion)).toBe(0)
  })

  it('采用建议生成新评分设置版本；忽略后版本不变；member 不能处理', async () => {
    const owner = await space()
    const target = await directionWithCluster(owner, 'ebay-us')
    await addSamples(owner, target, 0, 70)

    const first = await proposeSuggestion(owner)
    if (!first.ok) throw new Error(first.reason)
    const shown = (await validationPage(owner, { now })).latestSuggestion
    expect(shown).toMatchObject({ id: first.suggestionId, status: 'proposed', baseVersion: 1 })
    expect(shown?.crossValidation?.auc).toBeGreaterThan(0.5)

    await expect(
      resolveSuggestion({ ...owner, member: { role: 'member' } }, first.suggestionId, 'accept'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await expect(proposeSuggestion({ ...owner, workspaceReadOnly: true })).rejects.toMatchObject({
      code: 'WORKSPACE_READ_ONLY',
    })

    const accepted = await resolveSuggestion(owner, first.suggestionId, 'accept')
    expect(accepted).toEqual({ status: 'accepted', version: 2 })
    const scoring = await scoringPage(owner)
    expect(scoring.current.version).toBe(2)
    expect(scoring.current.weights['market-demand']).toBe(shown?.suggestedWeights['market-demand'])
    await expect(resolveSuggestion(owner, first.suggestionId, 'dismiss')).rejects.toMatchObject({
      code: 'SUGGESTION_RESOLVED',
      status: 409,
    })

    const second = await proposeSuggestion(owner)
    if (!second.ok) throw new Error(second.reason)
    expect(await resolveSuggestion(owner, second.suggestionId, 'dismiss')).toEqual({
      status: 'dismissed',
      version: null,
    })
    expect((await scoringPage(owner)).current.version).toBe(2)
    expect((await validationPage(owner, { now })).latestSuggestion).toMatchObject({
      id: second.suggestionId,
      status: 'dismissed',
    })

    // 评分维度管理旁的回测命中率：按主导维度汇总，带 Wilson 下界
    const demand = scoring.dimensions.find((d) => d.id === 'market-demand')
    expect(demand?.backtest).toMatchObject({ effectiveSamples: 70, replaySamples: 0 })
    expect(demand?.backtest?.wilsonLower).toBeLessThan(demand?.backtest?.hitRate as number)
    expect(scoring.dimensions.find((d) => d.id === 'profit')?.backtest).toBeNull()
  })

  it('准备度矩阵与按月命中率来自已落库的统计和标签', async () => {
    const owner = await space()
    const target = await directionWithCluster(owner, 'ebay-us')
    await addSamples(owner, target, 0, 24)
    await scoped(owner.db, owner.workspaceId).insert(readinessStat, {
      marketplace: 'ebay-us',
      directionId: target.directionId,
      signalType: 'market-demand',
      computedOn: '2032-02-23',
      shadowCount: 24,
      hitCount: 10,
      effectiveSamples: 24,
      wilsonLower: 0.24,
      baseline: 0.2,
      level: 'observation',
    })
    const page = await validationPage(owner, { now })
    expect(page.coldStart.allColdStart).toBe(false)
    expect(page.readiness).toHaveLength(1)
    expect(page.readiness[0]).toMatchObject({
      platform: 'ebay',
      level: 'observation',
      effectiveSamples: 24,
      samplesToObservation: 0,
    })
    const feb = page.monthly.find((m) => m.month === '2032-02')
    expect(feb).toMatchObject({ effectiveSamples: 24 })
    expect(feb?.byKind.shadow.labeled).toBe(24)
  })

  it('回放：参数校验错误带错误码；Amazon 方向预估商品与 token 后排队', async () => {
    const owner = await space()
    const ebay = await directionWithCluster(owner, 'ebay-us')
    const amazon = await directionWithCluster(owner, 'amazon-us')
    const { sent, queue } = fakeQueue()
    const input = { directionId: amazon.directionId, nodeDate: '2031-11-27', beforeDays: 30 }

    await expect(
      startKeepaReplay(owner, { ...input, nodeDate: '2031-13-01' }, queue, now),
    ).rejects.toMatchObject({ code: 'REPLAY_INVALID_DATE', status: 400 })
    await expect(
      startKeepaReplay(owner, { ...input, beforeDays: 0 }, queue, now),
    ).rejects.toMatchObject({ code: 'REPLAY_INVALID_OFFSET', status: 400 })
    await expect(
      startKeepaReplay(owner, { ...input, nodeDate: '2032-02-25', beforeDays: 1 }, queue, now),
    ).rejects.toMatchObject({ code: 'REPLAY_TOO_RECENT' })
    await expect(
      startKeepaReplay(owner, { ...input, directionId: ebay.directionId }, queue, now),
    ).rejects.toMatchObject({ code: 'REPLAY_NOT_AMAZON' })
    await expect(previewReplay(owner, ebay.directionId)).rejects.toMatchObject({
      code: 'REPLAY_NOT_AMAZON',
    })
    await expect(startKeepaReplay(owner, input, queue, now)).rejects.toMatchObject({
      code: 'REPLAY_NO_PRODUCTS',
    })
    await expect(startKeepaReplay(owner, input, { available: false }, now)).rejects.toMatchObject({
      code: 'REPLAY_QUEUE_UNAVAILABLE',
      status: 503,
    })
    await expect(
      startKeepaReplay({ ...owner, member: { role: 'member' } }, input, queue, now),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sent).toEqual([])

    const s = scoped(owner.db, owner.workspaceId)
    for (const asin of ['B0VAL00001', 'B0VAL00002']) {
      const [p] = await owner.db
        .insert(marketplaceProduct)
        .values({
          marketplace: 'amazon-us',
          platformId: `${asin}${owner.workspaceId.slice(-4)}`,
          title: asin,
        })
        .returning({ id: marketplaceProduct.id })
      products.push(p?.id as string)
      await s.insert(clusterMember, {
        clusterId: amazon.clusterId,
        productId: p?.id as string,
        method: 'manual',
        confidence: 1,
      })
    }
    expect(await previewReplay(owner, amazon.directionId)).toEqual({
      marketplaces: ['amazon-us'],
      clusters: 1,
      products: 2,
      estimatedTokens: 2,
    })
    const started = await startKeepaReplay(owner, input, queue, now)
    runs.push(started.replayId)
    expect(started).toMatchObject({ frozenOn: '2031-10-28', products: 2, estimatedTokens: 2 })
    expect(sent).toEqual([{ v: 1, replayId: started.replayId, workspaceId: owner.workspaceId }])
    const [row] = (await validationPage(owner, { now })).replays
    expect(row).toMatchObject({
      replayId: started.replayId,
      status: 'queued',
      directionName: '方向 amazon-us',
      products: 2,
    })
    // 失败原因的错误码原样返回，由页面映射文案
    await owner.db
      .update(syncRun)
      .set({ status: 'failed', errorCode: 'KEEPA_API_KEY_MISSING' })
      .where(eq(syncRun.id, started.replayId))
    expect((await validationPage(owner, { now })).replays[0]).toMatchObject({
      status: 'failed',
      errorCode: 'KEEPA_API_KEY_MISSING',
    })
  })
})
