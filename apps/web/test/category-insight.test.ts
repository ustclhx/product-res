import { env } from 'cloudflare:workers'
import { grant } from '@product-res/credits'
import {
  aiMessage,
  aiModel,
  categoryStudy,
  categoryStudySnapshot,
  cluster,
  clusterMember,
  createDb,
  direction,
  lead,
  leadEvent,
  marketplaceKeyword,
  marketplaceProduct,
  marketplaceReview,
  member,
  observation,
  organization,
  scoped,
  user,
} from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiPrompt, InsightAi } from '../src/features/category/ai.ts'
import { createInsightAi } from '../src/features/category/ai-runtime.server.ts'
import {
  type CategoryActor,
  convertToLead,
  createStudy,
  listArchivedStudies,
  refreshStudy,
  reportPage,
  setStudyArchived,
} from '../src/features/category/category.server.ts'
import { categoryFixture } from './fixtures/category-insight-data.ts'

// add-category-insight tasks 3.1 / 3.3 / 3.4：快照生成与刷新（真实 PG）、AI 引用校验与用量、转线索与归档。
const db = () => createDb(env.HYPERDRIVE)
const NOW = new Date('2026-10-19T08:00:00Z')
const suffix = newId().slice(-8)
const fx = categoryFixture(NOW, suffix)
const spaces: string[] = []
const users: string[] = []
const productIds: string[] = []
let keywordId = ''
let modelId = ''

async function seedMarket() {
  const products = await db()
    .insert(marketplaceProduct)
    .values(
      fx.products.map((p) => ({
        marketplace: 'amazon-us',
        platformId: p.platformId,
        title: p.title,
        brand: p.brand,
        categoryId: fx.categoryId,
        listedAt: p.listedAt ? new Date(p.listedAt) : null,
        firstSeenAt: new Date('2025-01-01T00:00:00Z'),
      })),
    )
    .returning({ id: marketplaceProduct.id, platformId: marketplaceProduct.platformId })
  const ids = new Map(products.map((p) => [p.platformId, p.id]))
  productIds.push(...products.map((p) => p.id))
  const [kw] = await db()
    .insert(marketplaceKeyword)
    .values({ marketplace: 'amazon-us', phrase: fx.keyword })
    .returning({ id: marketplaceKeyword.id })
  keywordId = kw?.id as string
  await db()
    .insert(observation)
    .values(
      fx.observations.map((o) => ({
        entityType: o.entityType,
        entityId: o.platformId ? (ids.get(o.platformId) as string) : keywordId,
        metric: o.metric,
        observedOn: o.observedOn,
        sourceId: o.sourceId,
        value: o.value,
        currency: o.currency,
        method: o.method,
        fetchedAt: NOW,
      })),
    )
  await db()
    .insert(marketplaceReview)
    .values(
      fx.reviews.map((r) => ({
        productId: ids.get(r.platformId) as string,
        reviewId: r.reviewId,
        rating: r.rating,
        title: r.title,
        body: r.body,
        reviewedOn: r.reviewedOn,
        sourceId: 'import',
      })),
    )
}

async function space(role = 'owner'): Promise<CategoryActor> {
  const id = newId()
  spaces.push(id)
  users.push(id)
  await db()
    .insert(user)
    .values({ id, name: 'Category test', email: `category-${id}@category-test.example` })
  await db()
    .insert(organization)
    .values({ id, name: 'Category test', slug: `cat-${id.slice(-12)}`, isPersonal: false })
  return { db: db(), workspaceId: id, userId: id, workspaceReadOnly: false, member: { role } }
}

/** 模拟 AI：记录调用次数，返回给定 JSON */
function fakeAi(output: unknown): InsightAi & { calls: AiPrompt[]; resolves: number } {
  const ai = {
    calls: [] as AiPrompt[],
    resolves: 0,
    async resolve() {
      ai.resolves++
      return {
        ok: true as const,
        modelKey: 'fake-model',
        generate: async (prompt: AiPrompt) => {
          ai.calls.push(prompt)
          return JSON.stringify(output)
        },
      }
    },
  }
  return ai
}
const notConfigured = (): InsightAi & { generate: ReturnType<typeof vi.fn> } => {
  const generate = vi.fn()
  return {
    generate,
    resolve: async () => ({ ok: false, reason: 'AI 未配置：测试' }),
  }
}

const studyInput = (name: string) => ({
  name,
  marketplace: 'amazon-us',
  categoryIds: [fx.categoryId],
  keywords: [fx.keyword],
  topN: 10,
})

beforeAll(seedMarket)

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(leadEvent, undefined)
    await s.delete(lead, undefined)
    await s.delete(clusterMember, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(categoryStudySnapshot, undefined)
    await s.delete(categoryStudy, undefined)
  }
  await db().delete(marketplaceReview).where(inArray(marketplaceReview.productId, productIds))
  await db()
    .delete(observation)
    .where(inArray(observation.entityId, [...productIds, keywordId]))
  await db().delete(marketplaceProduct).where(inArray(marketplaceProduct.id, productIds))
  await db().delete(marketplaceKeyword).where(eq(marketplaceKeyword.id, keywordId))
  if (modelId) await db().update(aiModel).set({ enabled: false }).where(eq(aiModel.id, modelId))
})

describe('研究快照', () => {
  it('新建生成第一份快照，刷新新增快照且旧快照保留可选（只读观测值）', async () => {
    const owner = await space()
    const ai = notConfigured()
    const created = await createStudy(owner, studyInput('慢食碗'), { ai, now: NOW })
    const refreshed = await refreshStudy(owner, created.id, {
      ai,
      now: new Date(NOW.getTime() + 60_000),
    })

    const latest = await reportPage(owner, created.id)
    expect(latest.snapshots.map((s) => s.id)).toEqual([refreshed.id, created.snapshotId])
    expect(latest.snapshot?.id).toBe(refreshed.id)
    const old = await reportPage(owner, created.id, created.snapshotId)
    expect(old.snapshot?.id).toBe(created.snapshotId)

    const m = latest.snapshot?.modules
    if (!m) throw new Error('snapshot missing')
    expect(m.scope.productCount).toBe(12)
    expect(m.overview.yoy).toMatchObject({ status: 'ok', coveredMonths: 9 })
    expect(m.overview.newProducts).toMatchObject({ status: 'ok', count: 8, excluded: 0 })
    expect(m.overview.concentration).toMatchObject({ status: 'ok', crossValidated: true })
    expect(m.overview.priceBands).toMatchObject({ status: 'ok', currency: 'USD' })
    expect(m.trend.status).toBe('ok')
    // 退货率没有任何来源
    expect(m.returnRate).toMatchObject({ status: 'no-source' })
    // 竞品矩阵：头部 10，按销量估算降序，数值带来源
    if (m.competitors.status !== 'ok') throw new Error('competitors missing')
    expect(m.competitors.rows).toHaveLength(10)
    expect(m.competitors.rows[0]).toMatchObject({
      brand: 'Outward Hound',
      price: { value: 13.99, sourceId: 'keepa', method: 'official', currency: 'USD' },
      salesMonthly: { sourceId: 'jungle-scout', alternatives: [{ sourceId: 'sellersprite' }] },
    })
    // 有差评：词云可用；未配置 AI 时主题与建议给出原因，不调用
    expect(m.painPoints.terms.status).toBe('ok')
    expect(m.painPoints.themes).toMatchObject({ status: 'ai-not-configured' })
    expect(m.suggestions).toMatchObject({ status: 'ai-not-configured' })
    expect(ai.generate).not.toHaveBeenCalled()
    expect(latest.snapshot?.dataAsOf).toBe('2026-10-19')
  })

  it('没有匹配商品与评论时各模块显示无数据来源，不调用 AI', async () => {
    const owner = await space()
    const ai = fakeAi({})
    const { id } = await createStudy(
      owner,
      { ...studyInput('空品类'), categoryIds: [`none-${suffix}`], keywords: [`none ${suffix}`] },
      { ai, now: NOW },
    )
    const m = (await reportPage(owner, id)).snapshot?.modules
    expect(m?.overview.yoy.status).toBe('no-source')
    expect(m?.competitors.status).toBe('no-source')
    expect(m?.painPoints.themes.status).toBe('no-source')
    expect(m?.suggestions.status).toBe('no-source')
    expect(ai.resolves).toBe(0)
  })

  it('AI 建议：引用缺失的被丢弃；差评与竞品不变时刷新沿用结果不重复调用', async () => {
    const owner = await space()
    const ai = fakeAi({
      themes: [
        { label: '底部打滑', reviewIds: ['R1', 'R7', 'R13'] },
        { label: '材质易裂', reviewIds: ['R2', 'R9'] },
      ],
      suggestions: [
        { title: '底部防滑硅胶圈', detail: '解决打滑', citations: ['R1', 'P1'] },
        { title: '没有引用', detail: '', citations: [] },
        { title: '引用不存在的评论', detail: '', citations: ['R999'] },
      ],
    })
    const { id } = await createStudy(owner, studyInput('AI 建议'), { ai, now: NOW })
    await refreshStudy(owner, id, { ai, now: new Date(NOW.getTime() + 60_000) })
    expect(ai.calls).toHaveLength(1)
    const m = (await reportPage(owner, id)).snapshot?.modules
    if (m?.suggestions.status !== 'ok' || m.painPoints.themes.status !== 'ok')
      throw new Error('ai modules missing')
    expect(m.suggestions.items.map((s) => s.title)).toEqual(['底部防滑硅胶圈'])
    expect(m.suggestions.dropped).toBe(2)
    expect(m.suggestions.ai.reusedFrom).not.toBeNull()
    const cited = m.suggestions.items[0]?.citations ?? []
    expect(cited.map((c) => c.kind)).toEqual(['review', 'product'])
    // 引用的评论原文随快照保存，可展开查看
    expect(m.reviews[cited[0]?.id as string]?.body).toBeTruthy()
    expect(m.painPoints.themes.themes[0]).toMatchObject({ label: '底部打滑', reviewCount: 3 })
  })

  it('成员只读：不能新建或刷新', async () => {
    const owner = await space()
    const { id } = await createStudy(owner, studyInput('只读'), { ai: notConfigured(), now: NOW })
    const member = { ...owner, member: { role: 'member' } }
    await expect(refreshStudy(member, id, { ai: notConfigured() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const other = await space()
    await expect(reportPage(other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('转线索与归档', () => {
  it('转线索：建单成员簇与线索，跟卖方式为同款微改良；再次转换复用；无方向时提示', async () => {
    const owner = await space()
    const { id, snapshotId } = await createStudy(owner, studyInput('转线索'), {
      ai: notConfigured(),
      now: NOW,
    })
    const m = (await reportPage(owner, id)).snapshot?.modules
    if (m?.competitors.status !== 'ok') throw new Error('competitors missing')
    const productId = m.competitors.rows[0]?.id as string

    await expect(
      convertToLead(owner, { studyId: id, snapshotId, productId, improvement: '防滑' }, NOW),
    ).rejects.toMatchObject({ code: 'DIRECTION_REQUIRED' })

    const s = scoped(db(), owner.workspaceId)
    await s.insert(direction, { name: 'eBay 方向', marketplaces: ['ebay-us'] })
    const [dir] = await s
      .insert(direction, { name: '宠物用品', marketplaces: ['amazon-us'] })
      .returning()
    const converted = await convertToLead(
      owner,
      { studyId: id, snapshotId, productId, improvement: '底部加防滑硅胶圈' },
      NOW,
    )
    expect(converted).toMatchObject({ directionId: dir?.id, reusedCluster: false })

    // 跟卖候选按方向读取线索：线索存在且属于该方向
    const leads = await s.select(lead, { where: eq(lead.directionId, dir?.id as string) })
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({
      id: converted.leadId,
      status: 'new',
      leadOn: '2026-10-19',
      followMode: 'improved',
      improvement: { note: '底部加防滑硅胶圈' },
    })
    const members = await s.select(clusterMember, {
      where: eq(clusterMember.clusterId, converted.clusterId),
    })
    expect(members).toMatchObject([{ productId, method: 'manual', locked: true }])
    const [event] = await s.select(leadEvent, { where: eq(leadEvent.leadId, converted.leadId) })
    expect(event).toMatchObject({
      kind: 'note',
      payload: {
        source: 'category-insight',
        followMode: 'improved',
        improvement: '底部加防滑硅胶圈',
        studyId: id,
        productId,
      },
    })
    expect((await reportPage(owner, id)).converted).toEqual({ [productId]: converted.leadId })

    const again = await convertToLead(
      owner,
      { studyId: id, snapshotId, productId, improvement: '改陶瓷' },
      NOW,
    )
    expect(again).toMatchObject({
      leadId: converted.leadId,
      reusedCluster: true,
      reusedLead: true,
    })
    // 复用未决定的线索时改良点说明更新到线索列
    expect((await s.findById(lead, converted.leadId)).improvement).toEqual({ note: '改陶瓷' })
    // 不在矩阵中的商品不能转
    await expect(
      convertToLead(owner, { studyId: id, snapshotId, productId: newId(), improvement: '' }, NOW),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('归档：listArchivedStudies 可查到，已归档的研究不能刷新', async () => {
    const owner = await space()
    const { id } = await createStudy(owner, studyInput('归档'), { ai: notConfigured(), now: NOW })
    await setStudyArchived(owner, id, true)
    const archived = await listArchivedStudies(owner)
    expect(archived).toMatchObject([{ id, status: 'archived', snapshotCount: 1 }])
    await expect(refreshStudy(owner, id, { ai: notConfigured() })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await setStudyArchived(owner, id, false)
    expect(await listArchivedStudies(owner)).toEqual([])
  })
})

describe('AI 用量', () => {
  it('经 packages/ai 计费链路调用：写入 ai_message 并按用量扣积分', async () => {
    const owner = await space()
    // 预扣要求调用者是空间成员
    await db().insert(member).values({
      id: newId(),
      organizationId: owner.workspaceId,
      userId: owner.userId,
      role: 'owner',
    })
    await grant(db(), {
      workspaceId: owner.workspaceId,
      source: 'admin',
      sourceRef: newId(),
      amount: 100_000,
    })
    modelId = newId()
    await db()
      .insert(aiModel)
      .values({
        id: modelId,
        key: `category-test-${modelId}`,
        kind: 'text',
        provider: 'mock',
        providerModelId: 'mock-model',
        pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 2, minCharge: 1 },
        sort: -100_000,
      })
    const text = JSON.stringify({ themes: [], suggestions: [] })
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 't1' },
            { type: 'text-delta' as const, id: 't1', delta: text },
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: {
                inputTokens: {
                  total: 1200,
                  noCache: 1200,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 300, text: 300, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    })
    const pending: Promise<unknown>[] = []
    const ai = createInsightAi({
      db: db(),
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      slug: 'cat',
      title: '品类洞察 · 用量测试',
      env: {},
      workersAi: false,
      waitUntil: (p) => {
        pending.push(p)
      },
      languageModelFactory: () => mock,
      entitlements: async () => ({
        key: 'test',
        sort: 0,
        features: { ...DEFAULT_FREE_FEATURES, models: ['*'] },
      }),
      overage: { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 },
    })
    const resolved = await ai.resolve()
    if (!resolved.ok) throw new Error(resolved.reason)
    expect(resolved.modelKey).toBe(`category-test-${modelId}`)
    expect(await resolved.generate({ system: 's', user: 'u' })).toBe(text)
    await Promise.all(pending)
    const [message] = await scoped(db(), owner.workspaceId).select(aiMessage, {
      where: and(eq(aiMessage.role, 'assistant'), eq(aiMessage.modelKey, resolved.modelKey)) as SQL,
    })
    // 1200 × 1/1k + 300 × 2/1k = 1.8 → 向上取整 2
    expect(message).toMatchObject({ status: 'completed', inputTokens: 1200, outputTokens: 300 })
    expect(message?.credits).toBeGreaterThan(0)
  })
})
