import {
  accuracyAudit,
  cluster,
  DEFAULT_SCORING_SETTING,
  direction,
  directionSeller,
  ensureSelectionDefaults,
  isWorkspaceTransferring,
  lead,
  marketplaceProduct,
  readinessStat,
  recommendation,
  recommendationLabel,
  scoped,
  scoringSetting,
  seasonalNode,
  trackedProduct,
  trackedStore,
  transferringWorkspaceIds,
  user,
  weightSuggestion,
  workspaceTransfer,
} from '@product-res/db'
import { generateAudit, generateWeeklyAudits } from '@product-res/marketdata'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dismissPendingWeightSuggestions,
  loadCollectionTargets,
  loadStoreCollectionTargets,
  rebuildWorkspaceReadiness,
  runReadinessWeekly,
  runSelectionDaily,
  runSelectionLabels,
} from '../src/index.ts'
import { cleanup, createWorkspace, insertProduct, testDb, url } from './helpers.ts'

// 流转锁与系统入口使用同一条真实 running 记录；共享商品验证过滤不改变跨空间去重。
describe.skipIf(!url)('工作台流转锁', () => {
  const db = testDb()
  const now = new Date('2034-06-20T01:00:00Z')
  const today = '2034-06-20'
  const requester = newId()
  const transferId = newId()
  const tag = newId()
  const spaces: string[] = []
  const dirs: string[] = []
  let productId = ''

  beforeAll(async () => {
    await db
      .insert(user)
      .values({ id: requester, name: 'Transfer', email: `${requester}@test.invalid` })
    productId = await insertProduct(db, {
      marketplace: 'ebay-us',
      platformId: tag,
      title: 'Test',
      firstSeenOn: today,
    })
    for (const name of ['TransferSource', 'TransferTarget', 'Unlocked']) {
      const ws = await createWorkspace(db, name)
      spaces.push(ws)
      if (name !== 'TransferTarget') await ensureSelectionDefaults(db, ws)
      const s = scoped(db, ws)
      const [dir] = await s
        .insert(direction, { name, marketplaces: ['ebay-us'], keywords: [tag] })
        .returning()
      const directionId = dir?.id as string
      dirs.push(directionId)
      const [cl] = await s
        .insert(cluster, { directionId, marketplace: 'ebay-us', name })
        .returning()
      await s.insert(recommendation, {
        clusterId: cl?.id as string,
        directionId,
        marketplace: 'ebay-us',
        frozenOn: '2034-05-01',
        signalType: 'market-demand',
        score: 70,
        grade: 'caution',
        settingVersion: 1,
        inputs: {},
        sampleKind: 'shadow',
      })
      await s.insert(directionSeller, {
        directionId,
        marketplace: 'ebay-us',
        sellerPlatformId: name,
        status: 'seed',
      })
      await s.insert(trackedStore, [
        {
          platform: 'ebay',
          marketplace: 'ebay-us',
          sellerKey: name,
          kind: 'watch',
          keywords: [tag],
        },
        {
          platform: 'amazon',
          marketplace: 'amazon-us',
          sellerKey: name,
          kind: 'watch',
          keywords: [tag],
        },
      ])
      await s.insert(trackedProduct, { productId, tier: 'hot', origin: 'manual' })
    }
    await db.insert(workspaceTransfer).values({
      id: transferId,
      kind: 'move',
      sourceWorkspaceId: spaces[0] as string,
      targetWorkspaceId: spaces[1] as string,
      requestedBy: requester,
      idempotencyKey: tag,
      status: 'running',
    })
  })

  afterAll(async () => {
    await db.delete(workspaceTransfer).where(eq(workspaceTransfer.id, transferId))
    for (const ws of spaces) {
      const s = scoped(db, ws)
      await s.delete(accuracyAudit, undefined)
      await s.delete(trackedStore, undefined)
      await s.delete(trackedProduct, undefined)
      await cleanup(db, ws, [])
    }
    if (productId) {
      await db.delete(marketplaceProduct).where(eq(marketplaceProduct.id, productId))
    }
    await db.delete(user).where(eq(user.id, requester))
  })

  it('源与目标均锁住；进行中状态全部生效，终态恢复', async () => {
    for (const status of [
      'pending',
      'running',
      'compensating',
      'completed',
      'failed',
      'compensated',
      'cancelled',
    ] as const) {
      await db.update(workspaceTransfer).set({ status }).where(eq(workspaceTransfer.id, transferId))
      const active = ['pending', 'running', 'compensating'].includes(status)
      for (const ws of spaces.slice(0, 2))
        expect(await isWorkspaceTransferring(db, ws)).toBe(active)
      const locked = await transferringWorkspaceIds(db)
      expect(locked.has(spaces[0] as string)).toBe(active)
      expect(locked.has(spaces[1] as string)).toBe(active)
      expect(locked.has(spaces[2] as string)).toBe(false)
    }
    await db
      .update(workspaceTransfer)
      .set({ status: 'running' })
      .where(eq(workspaceTransfer.id, transferId))
  })

  it('日常、标签、准备度、抽检跳过两边；未锁空间照常处理', async () => {
    const daily = await runSelectionDaily(db, { now, asOf: today, workspaceIds: spaces })
    expect(daily.map((r) => r.workspaceId)).toEqual([spaces[2]])
    const labels = await runSelectionLabels(db, { now, today })
    const readiness = await runReadinessWeekly(db, { now, today })
    const audits = await generateWeeklyAudits(db, now)
    for (const results of [labels, readiness, audits]) {
      expect(results.some((r) => r.workspaceId === spaces[2])).toBe(true)
      for (const ws of spaces.slice(0, 2))
        expect(results.some((r) => r.workspaceId === ws)).toBe(false)
    }
    for (const ws of spaces.slice(0, 2)) {
      const s = scoped(db, ws)
      expect(await s.count(lead)).toBe(0)
      expect(await s.count(recommendationLabel)).toBe(0)
      expect(await s.count(readinessStat)).toBe(0)
      expect(await s.count(accuracyAudit)).toBe(0)
      await expect(generateAudit(db, ws, { now })).rejects.toMatchObject({
        code: 'WORKSPACE_TRANSFERRING',
        status: 403,
      })
    }
  })

  it('目标预置数据跳过，采集在去重前过滤两边空间；强制手工采集也不能绕过', async () => {
    const target = spaces[1] as string
    expect(await ensureSelectionDefaults(db, target)).toEqual({ seeded: false })
    expect(await scoped(db, target).count(scoringSetting)).toBe(0)
    expect(await scoped(db, target).count(seasonalNode)).toBe(0)
    const targets = await loadCollectionTargets(db, { asOf: today, keywords: true })
    expect(targets.sellers.filter((s) => s.keywords.includes(tag)).map((s) => s.sellerId)).toEqual([
      'Unlocked',
      'Unlocked',
    ])
    const stores = await loadStoreCollectionTargets(db, { now, day: today })
    const snapshot = stores.snapshots.find((s) => s.productId === productId)
    expect(snapshot?.workspaceIds).toEqual([spaces[2]])
    expect(stores.searches.filter((s) => s.keyword === tag)).toHaveLength(1)
    for (const ws of spaces.slice(0, 2))
      expect(
        await loadStoreCollectionTargets(db, { now, day: today, workspaceId: ws, force: true }),
      ).toEqual({ searches: [], sellers: [], snapshots: [] })
    await db
      .update(workspaceTransfer)
      .set({ status: 'completed' })
      .where(eq(workspaceTransfer.id, transferId))
    expect(await ensureSelectionDefaults(db, target)).toEqual({ seeded: true })
    const unlocked = await loadStoreCollectionTargets(db, { now, day: today })
    expect(
      [...(unlocked.snapshots.find((s) => s.productId === productId)?.workspaceIds ?? [])].sort(),
    ).toEqual([...spaces].sort())
  })

  it('重建清除失效组合并按现有样本重算；仅作废指定空间未处理建议并记录发起人', async () => {
    const ws = spaces[0] as string
    const other = spaces[1] as string
    const s = scoped(db, ws)
    await s.insert(readinessStat, {
      directionId: dirs[0] as string,
      marketplace: 'ebay-us',
      signalType: 'competition',
      computedOn: '2034-06-01',
      level: 'trusted',
      shadowCount: 999,
    })
    const [rec] = await s.select(recommendation)
    await s.insert(recommendationLabel, {
      recommendationId: rec?.id as string,
      windowDays: 30,
      outcome: 'hit',
      labeledAt: now,
    })
    const values = {
      sampleCount: 50,
      suggestedWeights: DEFAULT_SCORING_SETTING.weights,
      currentWeights: DEFAULT_SCORING_SETTING.weights,
      metrics: {},
    }
    await s.insert(weightSuggestion, [
      { ...values, status: 'proposed' },
      { ...values, status: 'accepted' },
      { ...values, status: 'dismissed' },
    ])
    await scoped(db, other).insert(weightSuggestion, values)
    expect((await rebuildWorkspaceReadiness(db, ws, { now, today })).groups).toBe(1)
    expect(await s.select(readinessStat)).toEqual([
      expect.objectContaining({
        signalType: 'market-demand',
        computedOn: today,
        shadowCount: 1,
        hitCount: 1,
      }),
    ])
    expect(await dismissPendingWeightSuggestions(db, ws, requester, now)).toBe(1)
    expect(await dismissPendingWeightSuggestions(db, ws, requester, now)).toBe(0)
    const suggestions = await s.select(weightSuggestion)
    expect(suggestions.find((r) => r.resolvedBy === requester)).toMatchObject({
      status: 'dismissed',
      resolvedAt: now,
    })
    expect(
      suggestions
        .filter((r) => r.resolvedBy === null)
        .map((r) => r.status)
        .sort(),
    ).toEqual(['accepted', 'dismissed'])
    expect((await scoped(db, other).select(weightSuggestion))[0]?.status).toBe('proposed')
    await s.delete(recommendation, undefined)
    expect((await rebuildWorkspaceReadiness(db, ws, { now, today })).groups).toBe(0)
    expect(await s.count(readinessStat)).toBe(0)
  })
})
