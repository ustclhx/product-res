import { env } from 'cloudflare:workers'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cluster,
  createDb,
  direction,
  lead,
  organization,
  readinessStat,
  recommendation,
  recommendationLabel,
  scoped,
  weightSuggestion,
} from '../src/index.ts'
import { seedLead } from './support.ts'

// add-shadow-validation 2.1：推荐 / 标签 / 准备度 / 权重建议跨空间隔离，唯一约束生效。
const open = () => createDb(env.HYPERDRIVE)
const weights = {
  'market-demand': 1,
  'growth-season': 1,
  'peer-spread': 1,
  profit: 1,
  competition: 1,
  'supply-timing': 1,
  compliance: 1,
}

async function seed(label: string) {
  const base = await seedLead(env.HYPERDRIVE, label)
  const s = scoped(open(), base.wsId)
  const [rec] = await s
    .insert(recommendation, {
      leadId: base.leadId,
      clusterId: base.clusterId,
      directionId: base.directionId,
      frozenOn: '2026-10-01',
      marketplace: 'ebay-us',
      signalType: 'market-demand',
      score: 72,
      grade: 'recommend',
      settingVersion: 1,
      inputs: {},
      sampleKind: 'shadow',
    })
    .returning()
  if (!rec) throw new Error('seed failed')
  await s.insert(recommendationLabel, {
    recommendationId: rec.id,
    windowDays: 30,
    outcome: 'insufficient',
  })
  await s.insert(readinessStat, {
    marketplace: 'ebay-us',
    directionId: base.directionId,
    signalType: 'market-demand',
    computedOn: '2026-10-02',
    level: 'cold-start',
  })
  await s.insert(weightSuggestion, {
    sampleCount: 50,
    suggestedWeights: weights,
    currentWeights: weights,
    metrics: {},
  })
  return { ...base, recId: rec.id }
}

describe('影子验证表', () => {
  let a: Awaited<ReturnType<typeof seed>>
  let b: Awaited<ReturnType<typeof seed>>
  beforeAll(async () => {
    a = await seed('VA')
    b = await seed('VB')
  })
  afterAll(async () => {
    const db = open()
    for (const ws of [a.wsId, b.wsId]) {
      const s = scoped(db, ws)
      await s.delete(recommendationLabel, undefined)
      await s.delete(readinessStat, undefined)
      await s.delete(weightSuggestion, undefined)
      await s.delete(recommendation, undefined)
      await s.delete(lead, undefined)
      await s.delete(cluster, undefined)
      await s.delete(direction, undefined)
    }
    await db.delete(organization).where(inArray(organization.id, [a.wsId, b.wsId]))
  })

  it('scoped() 只返回本空间的行，其他空间的 id 返回 404', async () => {
    const s = scoped(open(), a.wsId)
    for (const t of [recommendation, recommendationLabel, readinessStat, weightSuggestion]) {
      expect(await s.count(t)).toBe(1)
    }
    await expect(s.findById(recommendation, b.recId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('线索 × 冻结日、推荐 × 窗口唯一；窗口只允许 14 / 30 / 60', async () => {
    const s = scoped(open(), a.wsId)
    await expect(
      s.insert(recommendation, {
        leadId: a.leadId,
        clusterId: a.clusterId,
        directionId: a.directionId,
        frozenOn: '2026-10-01',
        marketplace: 'ebay-us',
        signalType: 'profit',
        score: 50,
        grade: 'caution',
        settingVersion: 1,
        inputs: {},
        sampleKind: 'shadow',
      }),
    ).rejects.toThrow()
    await expect(
      s.insert(recommendationLabel, { recommendationId: a.recId, windowDays: 30, outcome: 'hit' }),
    ).rejects.toThrow()
    await expect(
      s.insert(recommendationLabel, { recommendationId: a.recId, windowDays: 45, outcome: 'hit' }),
    ).rejects.toThrow()
  })
})
