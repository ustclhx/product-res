import { createConnectors } from '@product-res/connectors'
import type { SourceConnector } from '@product-res/datasources'
import {
  categoryStudy,
  cluster,
  clusterSignal,
  costParam,
  direction,
  directionSeller,
  lead,
  logisticsProfile,
  riskFinding,
  riskRule,
  trackedProduct,
  trackedStore,
  workspaceTransfer,
  workspaceTransferIdMap,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadCollectionTargets, planCollections, type SourceAllowance } from '../src/collect.ts'
import { EBAY_ACCOUNT_DELETION_LOCK } from '../src/ebay-account-deletion.ts'
import { loadStoreCollectionTargets, planStoreTasks } from '../src/stores/collect.ts'
import {
  compensateTransfer,
  finalizeTransfer,
  listTransferBatches,
  planTransfer,
  runBatch,
  startCopy,
  type TransferPlan,
} from '../src/transfer/index.ts'
import { insertProduct, testDb, url } from './helpers.ts'
import {
  type Created,
  cleanupCreated,
  config,
  createTeam,
  createUser,
  seedWorkspace,
  snapshotRows,
  tableCounts,
} from './transfer-helpers.ts'

// add-workspace-data-transfer tasks 3.4：选择性复制在真实 PG 上的行为。
describe.skipIf(!url)('数据流转：复制', () => {
  const db = testDb()
  const created: Created = { users: [], workspaces: [], products: [] }
  afterAll(() => cleanupCreated(db, created))

  const key = () => `k-${newId()}`
  const tag = () => newId().slice(-8)

  async function runAll(transferId: string) {
    const plan = await planTransfer(db, transferId, config)
    for (const batch of await listTransferBatches(db, transferId))
      await runBatch(db, transferId, batch.key, config)
    return plan
  }

  async function idMap(transferId: string, table: string, sourceId: string) {
    const [row] = await db
      .select()
      .from(workspaceTransferIdMap)
      .where(
        and(
          eq(workspaceTransferIdMap.transferId, transferId),
          eq(workspaceTransferIdMap.tableName, table),
          eq(workspaceTransferIdMap.sourceId, sourceId),
        ),
      )
    return row
  }

  async function teams(label: string) {
    const t = tag()
    const owner = await createUser(db, created, `${label}${t}`)
    const a = await createTeam(db, created, `${label}A${t}`, [{ userId: owner, role: 'owner' }])
    const b = await createTeam(db, created, `${label}B${t}`, [{ userId: owner, role: 'admin' }])
    return { t, owner, a, b }
  }

  const copy = (userId: string, a: string, b: string, selection: unknown) =>
    startCopy(
      db,
      { userId, sourceWorkspaceId: a, targetWorkspaceId: b, selection, idempotencyKey: key() },
      config,
    )

  it('方向默认重命名并复制整棵闭包：新 id、引用按映射重写、不带样本与抽检、源空间不变', async () => {
    const { t, owner, a, b } = await teams('cp')
    // 源空间带只在升级时流转的表（评分设置、权重建议、抽检），复制都不应带上
    const src = await seedWorkspace(db, created, a, { tag: t, upgradeOnly: true })
    const dst = await seedWorkspace(db, created, b, { tag: `${t}b` })
    // 方向引用了不存在的节点：复制时从 node_ids 删除并记入报告
    const dangling = newId()
    await db
      .update(direction)
      .set({ nodeIds: [src.node, dangling] })
      .where(eq(direction.id, src.direction))
    // 目标没有的风险规则：发现的 ref 改指复制出的规则
    const [rule2] = await db
      .insert(riskRule)
      .values({
        workspaceId: a,
        kind: 'certification',
        match: { attributes: ['ce'] },
        level: 'medium',
        description: 'ce',
      })
      .returning()
    await db.insert(riskFinding).values({
      workspaceId: a,
      clusterId: src.cluster,
      kind: 'certification',
      ref: rule2?.id as string,
      level: 'medium',
    })
    const sourceBefore = await snapshotRows(db, [a])
    const targetBefore = await tableCounts(db, b)

    const started = await copy(owner, a, b, { roots: { direction: [src.direction] } })
    const plan = await runAll(started.transferId)
    await finalizeTransfer(db, started.transferId)

    expect(plan.kind).toBe('copy')
    expect(plan.conflicts.find((c) => c.table === 'direction')).toMatchObject({
      action: 'rename',
      newName: `万圣节装饰（来自 cpA${t}）`,
    })
    // 不带影子验证样本、准备度、评分设置与抽检（D4.5–D4.7）
    for (const table of [
      'recommendation',
      'recommendation_label',
      'readiness_stat',
      'weight_suggestion',
      'scoring_setting',
      'accuracy_audit',
      'accuracy_audit_item',
    ])
      expect(plan.tables[table], table).toBeUndefined()
    expect(plan.scoringVersions).toMatchObject([{ version: 1 }])
    const after = await tableCounts(db, b)
    expect(after).toMatchObject({
      recommendation: targetBefore.recommendation,
      recommendation_label: targetBefore.recommendation_label,
      readiness_stat: targetBefore.readiness_stat,
      accuracy_audit: 0,
      scoring_setting: 0,
      weight_suggestion: 0,
      direction: (targetBefore.direction ?? 0) + 1,
      cluster: (targetBefore.cluster ?? 0) + 2,
      lead: (targetBefore.lead ?? 0) + 1,
      lead_event: (targetBefore.lead_event ?? 0) + 1,
      cluster_signal: (targetBefore.cluster_signal ?? 0) + 1,
      decision: (targetBefore.decision ?? 0) + 1,
      follow_outcome: (targetBefore.follow_outcome ?? 0) + 1,
      // 节点、物流方案、供应商、规则（同自然键）合并；新规则复制
      seasonal_node: targetBefore.seasonal_node,
      logistics_profile: targetBefore.logistics_profile,
      supplier: targetBefore.supplier,
      risk_rule: (targetBefore.risk_rule ?? 0) + 1,
    })

    // 源空间逐行不变
    expect(await snapshotRows(db, [a])).toEqual(sourceBefore)

    const dirMap = await idMap(started.transferId, 'direction', src.direction)
    expect(dirMap?.action).toBe('copied')
    expect(dirMap?.targetId).not.toBe(src.direction)
    expect(dirMap?.sourceRow).toEqual({ unmapped: { node_ids: [dangling] } })
    const [newDir] = await db
      .select()
      .from(direction)
      .where(eq(direction.id, dirMap?.targetId as string))
    expect(newDir).toMatchObject({
      workspaceId: b,
      name: `万圣节装饰（来自 cpA${t}）`,
      nodeIds: [dst.node],
      categoryIds: [`cat-${t}`],
    })
    // 簇：新 id，merged_into_id 改指复制出的簇
    const c1 = (await idMap(started.transferId, 'cluster', src.cluster))?.targetId as string
    const c2 = (await idMap(started.transferId, 'cluster', src.mergedCluster))?.targetId as string
    const copiedClusters = await db
      .select()
      .from(cluster)
      .where(inArray(cluster.id, [c1, c2]))
    expect(Object.fromEntries(copiedClusters.map((c) => [c.id, c]))).toMatchObject({
      [c1]: { workspaceId: b, directionId: newDir?.id, mergedIntoId: null },
      [c2]: { workspaceId: b, directionId: newDir?.id, mergedIntoId: c1 },
    })
    // 复合主键：拼接键映射
    const signalKey = `${src.cluster}|2031-01-02|market-demand`
    expect((await idMap(started.transferId, 'cluster_signal', signalKey))?.targetId).toBe(
      `${c1}|2031-01-02|market-demand`,
    )
    expect(
      await db.select().from(clusterSignal).where(eq(clusterSignal.clusterId, c1)),
    ).toHaveLength(1)
    // 线索保留 setting_version；方案改指合并的物流方案与复制的报价；决定改指复制的方案
    const newLead = (await idMap(started.transferId, 'lead', src.lead))?.targetId as string
    const [leadRow] = await db.select().from(lead).where(eq(lead.id, newLead))
    expect(leadRow).toMatchObject({
      workspaceId: b,
      clusterId: c1,
      directionId: newDir?.id,
      settingVersion: 1,
    })
    const newQuote = (await idMap(started.transferId, 'supplier_quote', src.quote))?.targetId
    const newScenario = (await idMap(started.transferId, 'costing_scenario', src.scenario))
      ?.targetId
    const [scenario] = (await db.execute(
      sql`select lead_id, quote_id, profile_id from costing_scenario where id = ${newScenario}`,
    )) as unknown as { lead_id: string; quote_id: string; profile_id: string }[]
    expect(scenario).toEqual({ lead_id: newLead, quote_id: newQuote, profile_id: dst.profile })
    const [quote] = (await db.execute(
      sql`select supplier_id, cluster_id from supplier_quote where id = ${newQuote}`,
    )) as unknown as { supplier_id: string; cluster_id: string }[]
    expect(quote).toEqual({ supplier_id: dst.supplier, cluster_id: c1 })
    const [dec] = (await db.execute(
      sql`select scenario_id, snapshot from decision where lead_id = ${newLead}`,
    )) as unknown as { scenario_id: string; snapshot: unknown }[]
    expect(dec).toEqual({ scenario_id: newScenario, snapshot: { score: 50 } })
    // risk_finding.ref：合并的规则改指目标规则，复制的规则改指新规则
    const newRule = (await idMap(started.transferId, 'risk_rule', rule2?.id as string))?.targetId
    expect(await idMap(started.transferId, 'risk_rule', src.rule)).toMatchObject({
      action: 'merged',
      targetId: dst.rule,
    })
    const findings = await db.select().from(riskFinding).where(eq(riskFinding.clusterId, c1))
    expect(findings.map((f) => f.ref).sort()).toEqual([dst.rule, newRule].sort())
    // 对标店铺随方向复制
    const sellers = await db
      .select()
      .from(directionSeller)
      .where(eq(directionSeller.directionId, newDir?.id as string))
    expect(sellers.map((s) => [s.sellerPlatformId, s.status])).toEqual([
      [`seller_${t}`, 'accepted'],
    ])

    const [transfer] = await db
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, started.transferId))
    expect(transfer?.status).toBe('completed')
    expect(transfer?.counts.direction).toEqual({ copied: 1, 'unmapped:node_ids': 1 })
    expect(transfer?.counts.seasonal_node).toEqual({ merged: 1 })
  })

  it('店铺、追踪商品、物流方案与成本参数：合并跳过 / 升档 / 相位保留 / merge-if-equal / 保留目标', async () => {
    const { t, owner, a, b } = await teams('cs')
    const src = await seedWorkspace(db, created, a, { tag: t, tier: 'hot' })
    const dst = await seedWorkspace(db, created, b, {
      tag: `${t}b`,
      sellerKey: `seller_${t}`,
      product: src.product,
      tier: 'cold',
    })
    await db.update(costParam).set({ commissionRate: 0.2 }).where(eq(costParam.workspaceId, b))
    // 同名不同计费的物流方案：重命名复制；同名同计费的 Air 合并
    await db.insert(logisticsProfile).values([
      { workspaceId: a, name: 'Sea', platform: 'ebay', type: 'ebay-direct', transitDays: 30 },
      { workspaceId: b, name: 'Sea', platform: 'ebay', type: 'ebay-direct', transitDays: 40 },
    ])
    // 目标没有的店铺：direction_ids 中只有本次流转的方向保留
    const [extraDirection] = await db
      .insert(direction)
      .values({ workspaceId: a, name: `other-${t}` })
      .returning()
    const [store2] = await db
      .insert(trackedStore)
      .values({
        workspaceId: a,
        platform: 'ebay',
        marketplace: 'ebay-us',
        sellerKey: `extra_${t}`,
        kind: 'watch',
        directionIds: [src.direction, extraDirection?.id as string],
      })
      .returning()
    // 目标没有的追踪商品：快照相位原样保留；origin_ref 分别指向合并的店铺、复制的线索、闭包外的店铺
    const products = await Promise.all(
      ['p2', 'p3', 'p4'].map((p) =>
        insertProduct(db, {
          marketplace: 'ebay-us',
          platformId: `v1|${t}${p}|0`,
          title: `Lamp ${p}`,
          firstSeenOn: '2031-01-01',
        }),
      ),
    )
    created.products.push(...products)
    const tierChangedAt = new Date('2031-01-01T08:00:00Z')
    const [outside] = await db
      .insert(trackedStore)
      .values({
        workspaceId: a,
        platform: 'ebay',
        marketplace: 'ebay-us',
        sellerKey: `outside_${t}`,
        kind: 'watch',
      })
      .returning()
    const extras = await db
      .insert(trackedProduct)
      .values(
        [src.store, src.lead, outside?.id as string].map((originRef, i) => ({
          workspaceId: a,
          productId: products[i] as string,
          tier: 'normal' as const,
          tierReason: 'sale-signal',
          tierChangedAt,
          origin: i === 1 ? ('lead' as const) : ('store' as const),
          originRef,
          lastSnapshotOn: '2031-01-03',
        })),
      )
      .returning()
    const sourceBefore = await snapshotRows(db, [a])

    const started = await copy(owner, a, b, {
      roots: {
        direction: [src.direction],
        store: [src.store, store2?.id as string],
        trackedProduct: [src.trackedProduct, ...extras.map((e) => e.id)],
        configPack: true,
      },
    })
    const plan = (await runAll(started.transferId)) as TransferPlan
    await finalizeTransfer(db, started.transferId)
    const decisions = (table: string) => plan.conflicts.filter((c) => c.table === table)
    expect(decisions('tracked_store')).toMatchObject([{ action: 'merge', targetId: dst.store }])
    expect(decisions('tracked_product')).toMatchObject([
      { action: 'merge', targetId: dst.trackedProduct },
    ])
    expect(decisions('cost_param')).toMatchObject([{ action: 'keep-target' }])
    expect(
      Object.fromEntries(decisions('logistics_profile').map((d) => [d.label, d.action])),
    ).toEqual({ Air: 'merge', Sea: 'rename' })
    expect(await snapshotRows(db, [a])).toEqual(sourceBefore)

    const newDir = (await idMap(started.transferId, 'direction', src.direction))?.targetId
    // 店铺：目标保留并并入复制出的方向；源店铺仍在
    expect(await idMap(started.transferId, 'tracked_store', src.store)).toMatchObject({
      action: 'merged',
      targetId: dst.store,
    })
    const [store] = await db.select().from(trackedStore).where(eq(trackedStore.id, dst.store))
    expect(store?.directionIds).toEqual([dst.direction, newDir])
    const store2Map = await idMap(started.transferId, 'tracked_store', store2?.id as string)
    expect(store2Map?.sourceRow).toEqual({ unmapped: { direction_ids: [extraDirection?.id] } })
    const [copiedStore] = await db
      .select()
      .from(trackedStore)
      .where(eq(trackedStore.id, store2Map?.targetId as string))
    expect(copiedStore).toMatchObject({ workspaceId: b, directionIds: [newDir] })
    // 追踪商品：目标取更热档位；复制的行快照相位原样保留，origin_ref 按映射重写
    const [merged] = await db
      .select()
      .from(trackedProduct)
      .where(eq(trackedProduct.id, dst.trackedProduct))
    expect(merged).toMatchObject({ tier: 'hot', tierReason: 'transfer' })
    const newLead = (await idMap(started.transferId, 'lead', src.lead))?.targetId
    const copiedProducts = await db
      .select()
      .from(trackedProduct)
      .where(and(eq(trackedProduct.workspaceId, b), inArray(trackedProduct.productId, products)))
    expect(
      copiedProducts
        .sort((x, y) => products.indexOf(x.productId) - products.indexOf(y.productId))
        .map((p) => [p.originRef, p.tier, p.tierReason, p.tierChangedAt, p.lastSnapshotOn]),
    ).toEqual([
      [dst.store, 'normal', 'sale-signal', tierChangedAt, '2031-01-03'],
      [newLead, 'normal', 'sale-signal', tierChangedAt, '2031-01-03'],
      [null, 'normal', 'sale-signal', tierChangedAt, '2031-01-03'],
    ])
    expect(
      (await idMap(started.transferId, 'tracked_product', extras[2]?.id as string))?.sourceRow,
    ).toEqual({ unmapped: { origin_ref: outside?.id } })
    // 物流方案：Air 合并，Sea 计费不同按新名称复制；成本参数保留目标
    const profiles = await db
      .select()
      .from(logisticsProfile)
      .where(eq(logisticsProfile.workspaceId, b))
    expect(profiles.map((p) => [p.name, p.transitDays]).sort()).toEqual(
      [
        ['Air', 10],
        ['Sea', 40],
        [`Sea（来自 csA${t}）`, 30],
      ].sort(),
    )
    const params = await db.select().from(costParam).where(eq(costParam.workspaceId, b))
    expect(params.map((p) => p.commissionRate)).toEqual([0.2])
    const [transfer] = await db
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, started.transferId))
    expect(transfer?.counts.cost_param).toEqual({ skipped: 1 })
    expect(transfer?.counts.tracked_product).toMatchObject({
      merged: 1,
      copied: 3,
      'unmapped:origin_ref': 1,
    })
  })

  it('方向合并：簇挂到目标方向、对标店铺去重、数组并集；补偿后目标逐行恢复', async () => {
    const { t, owner, a, b } = await teams('cm')
    const src = await seedWorkspace(db, created, a, { tag: t })
    const dst = await seedWorkspace(db, created, b, { tag: `${t}b`, sellerKey: `seller_${t}` })
    await db
      .update(directionSeller)
      .set({ status: 'rejected' })
      .where(eq(directionSeller.id, dst.seller))
    await db.insert(directionSeller).values({
      workspaceId: a,
      directionId: src.direction,
      marketplace: 'ebay-us',
      sellerPlatformId: `other_${t}`,
      status: 'seed',
    })
    const before = await snapshotRows(db, [a, b])
    const started = await copy(owner, a, b, {
      roots: { direction: [src.direction], store: [src.store] },
      conflicts: { directions: { [src.direction]: 'merge' } },
    })
    const plan = await runAll(started.transferId)
    expect(plan.conflicts.find((c) => c.table === 'direction')).toMatchObject({
      action: 'merge',
      targetId: dst.direction,
    })
    const [target] = await db.select().from(direction).where(eq(direction.id, dst.direction))
    expect(target?.categoryIds).toEqual([`cat-${t}b`, `cat-${t}`])
    const c1 = (await idMap(started.transferId, 'cluster', src.cluster))?.targetId as string
    const [copied] = await db.select().from(cluster).where(eq(cluster.id, c1))
    expect(copied).toMatchObject({ workspaceId: b, directionId: dst.direction })
    const sellers = await db
      .select()
      .from(directionSeller)
      .where(eq(directionSeller.directionId, dst.direction))
    expect(sellers.map((s) => [s.sellerPlatformId, s.status]).sort()).toEqual(
      [
        [`other_${t}`, 'seed'],
        [`seller_${t}`, 'rejected'],
      ].sort(),
    )
    expect(await idMap(started.transferId, 'direction_seller', src.seller)).toMatchObject({
      action: 'merged',
      targetId: dst.seller,
    })
    // 店铺合并时 direction_ids 中的源方向映射到目标方向，已存在则不变
    const [store] = await db.select().from(trackedStore).where(eq(trackedStore.id, dst.store))
    expect(store?.directionIds).toEqual([dst.direction])

    // 完成前回滚：删除复制的行，恢复被合并修改的目标方向；源空间始终不变
    await compensateTransfer(db, started.transferId, 'TEST_ROLLBACK')
    expect(await snapshotRows(db, [a, b])).toEqual(before)
  })

  it('批次失败后续跑幂等；补偿后目标不残留', async () => {
    const { t, owner, a, b } = await teams('cr')
    const src = await seedWorkspace(db, created, a, { tag: t })
    const before = await snapshotRows(db, [a, b])
    const started = await copy(owner, a, b, {
      roots: { direction: [src.direction], store: [src.store], categoryStudy: [src.study] },
    })
    await planTransfer(db, started.transferId, config)
    const batches = await listTransferBatches(db, started.transferId)
    expect(batches.map((x) => x.key.split(':')[0])).toEqual([
      'config',
      'direction',
      'store-pool',
      'category-study',
    ])
    // 计划之后目标出现同名品类研究：复制批次撞唯一键失败（事务回滚，不留半批）
    const [blocker] = await db
      .insert(categoryStudy)
      .values({ workspaceId: b, name: 'Lamps', marketplace: 'ebay-us' })
      .returning()
    for (const batch of batches.slice(0, -1))
      expect((await runBatch(db, started.transferId, batch.key, config)).status).toBe('done')
    await expect(runBatch(db, started.transferId, 'category-study', config)).rejects.toThrow()
    expect((await tableCounts(db, b)).category_study_snapshot, '失败批次不留下子行').toBe(0)
    // 已完成的批次重试跳过，不重复复制
    expect(
      (await runBatch(db, started.transferId, `direction:${src.direction}`, config)).status,
    ).toBe('skipped')
    await db.delete(categoryStudy).where(eq(categoryStudy.id, blocker?.id as string))
    expect((await runBatch(db, started.transferId, 'category-study', config)).status).toBe('done')
    const counts = await tableCounts(db, b)
    expect(counts).toMatchObject({ direction: 1, cluster: 2, category_study: 1, tracked_store: 1 })

    await compensateTransfer(db, started.transferId, 'TEST_ROLLBACK')
    expect(await snapshotRows(db, [a, b])).toEqual(before)
    expect(Object.values(await tableCounts(db, b)).every((n) => n === 0)).toBe(true)
  })

  it('复制前后 eBay 采集任务键集合不变（「决定」：采集已跨空间去重）', async () => {
    const { t, owner, a, b } = await teams('cq')
    const src = await seedWorkspace(db, created, a, { tag: t, tier: 'hot' })
    const connectors = new Map(createConnectors().map((c) => [c.id, c]))
    const allowance = (id: string): SourceAllowance => ({
      connector: connectors.get(id) as SourceConnector,
      headroom: 10_000_000,
    })
    const day = '2031-01-05'
    const keys = async () => {
      const targets = await loadCollectionTargets(db, { asOf: day, keywords: false })
      const collect = planCollections(
        targets,
        new Map([['ebay-browse', allowance('ebay-browse')]]),
        {
          keywords: false,
        },
      )
      const stores = planStoreTasks(
        await loadStoreCollectionTargets(db, { day, now: new Date(`${day}T12:00:00Z`) }),
        new Map([['ebay-browse', allowance('ebay-browse')]]),
      )
      return new Set([...collect.tasks, ...stores.tasks].map((x) => x.key))
    }
    const before = await keys()
    expect(before.size).toBeGreaterThan(0)
    const started = await copy(owner, a, b, {
      roots: {
        direction: [src.direction],
        store: [src.store],
        trackedProduct: [src.trackedProduct],
      },
    })
    const plan = await runAll(started.transferId)
    await finalizeTransfer(db, started.transferId)
    expect(plan.quota.additionalBrowseCallsPerDay).toBe(0)
    // 目标空间确实有了副本（方向、对标店铺、店铺、追踪商品）
    expect(await tableCounts(db, b)).toMatchObject({
      direction: 1,
      direction_seller: 1,
      tracked_store: 1,
      tracked_product: 1,
    })
    expect(await keys()).toEqual(before)
  })

  it('涉及卖家数据的复制批次等待 eBay 账号删除的排它锁', async () => {
    const { t, owner, a, b } = await teams('ce')
    const src = await seedWorkspace(db, created, a, { tag: t })
    const started = await copy(owner, a, b, { roots: { direction: [src.direction] } })
    await planTransfer(db, started.transferId, config)
    await runBatch(db, started.transferId, 'config', config)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve
    })
    const deletion = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${EBAY_ACCOUNT_DELETION_LOCK}, 0))`,
      )
      locked()
      await held
    })
    await lockTaken
    let done = false
    const batch = runBatch(db, started.transferId, `direction:${src.direction}`, config).then(
      () => {
        done = true
      },
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(done).toBe(false)
    release()
    await deletion
    await batch
    expect(done).toBe(true)
    await compensateTransfer(db, started.transferId, 'TEST_CLEANUP')
  })

  it('权限：团队 admin 可复制团队数据到个人空间；member 被拒；不能复制到他人个人空间', async () => {
    const t = tag()
    const ensure = async (label: string) => {
      const userId = await createUser(db, created, `${label}${t}`)
      const { ensurePersonalWorkspace } = await import('@product-res/auth')
      await ensurePersonalWorkspace(db, { id: userId })
      created.workspaces.push(userId)
      return userId
    }
    const owner = await ensure('qo')
    const admin = await ensure('qa')
    const plain = await ensure('qm')
    const team = await createTeam(db, created, `Q${t}`, [
      { userId: owner, role: 'owner' },
      { userId: admin, role: 'admin' },
      { userId: plain, role: 'member' },
    ])
    const s = await seedWorkspace(db, created, team, { tag: t })
    const selection = { roots: { direction: [s.direction] } }
    await expect(copy(plain, team, plain, selection)).rejects.toMatchObject({
      code: 'TRANSFER_FORBIDDEN',
      status: 403,
    })
    await expect(copy(admin, team, owner, selection)).rejects.toMatchObject({
      code: 'TRANSFER_FORBIDDEN',
    })
    const before = await snapshotRows(db, [team])
    const ok = await copy(admin, team, admin, selection)
    expect(ok.created).toBe(true)
    await runAll(ok.transferId)
    await finalizeTransfer(db, ok.transferId)
    expect((await tableCounts(db, admin)).direction).toBe(1)
    // 同一幂等键重复提交返回同一流转
    const input = {
      userId: owner,
      sourceWorkspaceId: team,
      targetWorkspaceId: owner,
      selection,
      idempotencyKey: key(),
    }
    const first = await startCopy(db, input, config)
    expect(first.created).toBe(true)
    expect(await startCopy(db, input, config)).toMatchObject({
      transferId: first.transferId,
      created: false,
    })
    await compensateTransfer(db, first.transferId, 'TEST_CLEANUP')
    expect(await snapshotRows(db, [team])).toEqual(before)
  })
})
