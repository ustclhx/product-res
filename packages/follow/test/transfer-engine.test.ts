import { ensurePersonalWorkspace } from '@product-res/auth'
import {
  costParam,
  direction,
  directionSeller,
  member,
  organization,
  session,
  trackedProduct,
  trackedStore,
  workspaceTransfer,
  workspaceTransferBatch,
  workspaceTransferIdMap,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { afterAll, describe, expect, it } from 'vitest'
import { deleteEbayUserData } from '../src/ebay-account-deletion.ts'
import {
  beginCompensation,
  compensateBatch,
  compensateTransfer,
  finalizeTransfer,
  listTransferBatches,
  lockTransferWorkspaces,
  NON_RETRYABLE_TRANSFER_ERRORS,
  planTransfer,
  runBatch,
  STATIC_TRANSFER_TABLES,
  startMove,
  startUpgrade,
  type TransferPlan,
} from '../src/transfer/index.ts'
import { testDb, url } from './helpers.ts'
import {
  type Created,
  cleanupCreated,
  config,
  createSession,
  createTeam,
  createUser,
  seedWorkspace,
  snapshotRows,
  tableCounts,
} from './transfer-helpers.ts'

// add-workspace-data-transfer tasks 3.2 / 3.3 / 3.5 / 3.6：流转引擎（升级与选择性移动）在真实 PG 上的行为。
describe.skipIf(!url)('数据流转引擎', () => {
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

  async function personal(label: string) {
    const userId = await createUser(db, created, label)
    const workspace = await ensurePersonalWorkspace(db, { id: userId })
    created.workspaces.push(workspace.id)
    return userId
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

  describe('升级', () => {
    it('整体移动到新团队空间，按表计数一致，个人空间身份不变', async () => {
      const t = tag()
      const userId = await personal(`up${t}`)
      await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
      const sessionId = await createSession(db, userId, userId)
      const before = await tableCounts(db, userId)
      expect(Object.values(before).every((n) => n > 0)).toBe(true)
      const [ownerBefore] = await db.select().from(member).where(eq(member.organizationId, userId))

      const idempotencyKey = key()
      const input = { userId, name: 'Team', slug: `team-${t}`, idempotencyKey, sessionId }
      const first = await startUpgrade(db, input, config)
      const again = await startUpgrade(db, input, config)
      expect(first.created).toBe(true)
      expect(again).toMatchObject({ transferId: first.transferId, created: false })
      created.workspaces.push(first.targetWorkspaceId)
      // 重复提交只建一个团队空间
      const teams = await db
        .select()
        .from(organization)
        .where(eq(organization.slug, `team-${t}`))
      expect(teams).toHaveLength(1)

      const plan = await runAll(first.transferId)
      expect(plan.tables).toEqual(before)
      const finalized = await finalizeTransfer(db, first.transferId)
      expect(finalized.sessionTokens).toEqual([`t-${sessionId}`])
      // 重试返回同一批需失效的会话 token
      expect(await finalizeTransfer(db, first.transferId)).toEqual(finalized)

      expect(await tableCounts(db, first.targetWorkspaceId)).toEqual(before)
      expect(Object.values(await tableCounts(db, userId)).every((n) => n === 0)).toBe(true)
      const [transfer] = await db
        .select()
        .from(workspaceTransfer)
        .where(eq(workspaceTransfer.id, first.transferId))
      expect(transfer?.status).toBe('completed')
      for (const [table, n] of Object.entries(before))
        expect(transfer?.counts[table], table).toEqual({ moved: n })

      // 个人空间：id = user.id、is_personal、owner 成员行不变，补建不会产生第二个个人空间
      const [org] = await db.select().from(organization).where(eq(organization.id, userId))
      expect(org).toMatchObject({ id: userId, isPersonal: true, deletedAt: null })
      const [ownerAfter] = await db.select().from(member).where(eq(member.organizationId, userId))
      expect(ownerAfter).toEqual(ownerBefore)
      expect((await ensurePersonalWorkspace(db, { id: userId })).id).toBe(userId)
      const personalOrgs = await db.execute(
        sql`select o.id from organization o join member m on m.organization_id = o.id
          where m.user_id = ${userId} and o.is_personal`,
      )
      expect(personalOrgs).toHaveLength(1)
      // 新空间只有发起人一个 owner；会话切到新空间
      const members = await db
        .select()
        .from(member)
        .where(eq(member.organizationId, first.targetWorkspaceId))
      expect(members.map((m) => [m.userId, m.role])).toEqual([[userId, 'owner']])
      const [s] = await db.select().from(session).where(eq(session.id, sessionId))
      expect(s?.activeOrganizationId).toBe(first.targetWorkspaceId)
    })

    // spec「不随数据流转的内容 / 升级后的积分」：不流转的空间表逐行留在个人空间，新团队空间没有积分
    it('积分、AI 对话、通知与已有审计留在个人空间，新团队空间没有积分', async () => {
      const t = tag()
      const userId = await personal(`upk${t}`)
      await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
      const [grant] = (await db.execute(
        sql`insert into credit_grant (id, workspace_id, source, source_ref, amount, remaining)
          values (${newId()}, ${userId}, 'admin', ${`transfer-test:${t}`}, 500, 320) returning id`,
      )) as unknown as { id: string }[]
      await db.execute(sql`insert into credit_ledger (id, workspace_id, user_id, grant_id, delta, type)
        values (${newId()}, ${userId}, ${userId}, ${grant?.id}, 500, 'grant'),
          (${newId()}, ${userId}, ${userId}, ${grant?.id}, -180, 'consume')`)
      await db.execute(sql`insert into ai_conversation (id, workspace_id, user_id, model_key)
        values (${newId()}, ${userId}, ${userId}, 'test-model')`)
      await db.execute(sql`insert into notification (id, user_id, workspace_id, type, title)
        values (${newId()}, ${userId}, ${userId}, 'test', 'kept')`)
      await db.execute(sql`insert into audit_log (id, workspace_id, actor_user_id, action)
        values (${newId()}, ${userId}, ${userId}, 'test.before_upgrade')`)
      // 成员与邀请表以 organization_id 关联空间，其余为 workspace_id
      const spaceColumn = new Map(
        STATIC_TRANSFER_TABLES.filter((x) => x.link === 'workspace').map((x) => [
          x.name,
          getTableConfig(x.table).columns.some((c) => c.name === 'workspace_id')
            ? 'workspace_id'
            : 'organization_id',
        ]),
      )
      const staticTables = [...spaceColumn.keys()]
      const staticRows = async (ws: string) => {
        const out: Record<string, unknown[]> = {}
        for (const name of staticTables)
          out[name] = (
            (await db.execute(
              sql`select to_jsonb(t) as j from ${sql.raw(`"${name}"`)} t
                where ${sql.raw(`"${spaceColumn.get(name)}"`)} = ${ws} order by to_jsonb(t)::text`,
            )) as unknown as { j: unknown }[]
          ).map((r) => r.j)
        return out
      }
      const before = await staticRows(userId)
      const started = await startUpgrade(
        db,
        { userId, name: 'Team', slug: `teamk-${t}`, idempotencyKey: key() },
        config,
      )
      created.workspaces.push(started.targetWorkspaceId)
      await runAll(started.transferId)
      await finalizeTransfer(db, started.transferId)

      // 个人空间：除审计另写新行外，全部不流转的表逐行不变；已有审计行仍在原空间
      const after = await staticRows(userId)
      for (const name of staticTables.filter((x) => x !== 'audit_log'))
        expect(after[name], name).toEqual(before[name])
      expect(after.audit_log).toEqual(expect.arrayContaining(before.audit_log ?? []))
      const balance = (await db.execute(
        sql`select coalesce(sum(remaining),0)::int as n from credit_grant where workspace_id = ${userId}`,
      )) as unknown as { n: number }[]
      expect(balance[0]?.n).toBe(320)
      // 新团队空间：只有发起人的 owner 成员与流转 / 升级审计，没有积分、流水、对话与通知
      const team = await staticRows(started.targetWorkspaceId)
      for (const name of staticTables.filter((x) => x !== 'member' && x !== 'audit_log'))
        expect(team[name], name).toEqual([])
      expect(team.member).toHaveLength(1)
      const actions = (team.audit_log as { action: string }[]).map((r) => r.action)
      expect(actions.length).toBeGreaterThan(0)
      expect(actions.every((a) => a.startsWith('workspace.'))).toBe(true)
    })

    it('批次失败后续跑幂等，补偿后两边恢复并软删新空间', async () => {
      const t = tag()
      const userId = await personal(`upc${t}`)
      await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
      const snapshot = await snapshotRows(db, [userId])
      const started = await startUpgrade(
        db,
        { userId, name: 'Team', slug: `teamc-${t}`, idempotencyKey: key() },
        config,
      )
      created.workspaces.push(started.targetWorkspaceId)
      await planTransfer(db, started.transferId, config)
      // plan 重试返回同一计划，不重复写清单
      const plan = (await planTransfer(db, started.transferId, config)) as TransferPlan
      const batches = await listTransferBatches(db, started.transferId)
      expect(batches.map((b) => b.key)).toEqual(plan.batches.map((b) => b.key))
      expect(batches.at(-1)?.key).toBe('validation')

      // 目标被写入抽检记录：验证批次失败（不可重试），其余批次不受影响
      const [blocker] = (await db.execute(
        sql`insert into accuracy_audit (id, workspace_id, week_of, seed, sample_size)
          values (${newId()}, ${started.targetWorkspaceId}, '2031-02-03', 'x', 1) returning id`,
      )) as unknown as { id: string }[]
      for (const batch of batches.slice(0, -1))
        expect((await runBatch(db, started.transferId, batch.key, config)).status).toBe('done')
      await expect(runBatch(db, started.transferId, 'validation', config)).rejects.toMatchObject({
        code: 'TRANSFER_TARGET_NOT_EMPTY',
      })
      // 已完成的批次重试直接跳过；阻塞解除后从未完成的批次续跑
      expect((await runBatch(db, started.transferId, 'config', config)).status).toBe('skipped')
      await db.execute(sql`delete from accuracy_audit where id = ${blocker?.id}`)
      expect((await runBatch(db, started.transferId, 'validation', config)).status).toBe('done')
      expect(Object.values(await tableCounts(db, userId)).every((n) => n === 0)).toBe(true)

      const teamSession = await createSession(db, userId, started.targetWorkspaceId)
      const result = await compensateTransfer(db, started.transferId, 'TEST_CANCEL')
      expect(result).toEqual({ status: 'compensated', sessionTokens: [`t-${teamSession}`] })
      expect(await compensateTransfer(db, started.transferId, 'TEST_CANCEL')).toEqual(result)
      expect(await snapshotRows(db, [userId])).toEqual(snapshot)
      expect(
        Object.values(await tableCounts(db, started.targetWorkspaceId)).every((n) => n === 0),
      ).toBe(true)
      const [team] = await db
        .select()
        .from(organization)
        .where(eq(organization.id, started.targetWorkspaceId))
      expect(team?.deletedAt).not.toBeNull()
      const [transfer] = await db
        .select()
        .from(workspaceTransfer)
        .where(eq(workspaceTransfer.id, started.transferId))
      expect(transfer).toMatchObject({ status: 'compensated', errorCode: 'TEST_CANCEL' })
      const states = await listTransferBatches(db, started.transferId)
      expect(states.every((b) => b.status === 'compensated')).toBe(true)
    })

    it('目标不为空或权限不满足时拒绝', async () => {
      const t = tag()
      const userId = await personal(`upr${t}`)
      await expect(
        startUpgrade(db, { userId, name: 'X', slug: 'admin', idempotencyKey: key() }, config),
      ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_SLUG' })
      await expect(
        startUpgrade(
          db,
          { userId, name: 'X', slug: `x-${t}`, idempotencyKey: key() },
          { tenancy: { ...config.tenancy, dataTransfer: false } },
        ),
      ).rejects.toMatchObject({ code: 'TRANSFER_DISABLED' })
      await expect(
        startUpgrade(
          db,
          { userId, name: 'X', slug: `x-${t}`, idempotencyKey: key() },
          { tenancy: { ...config.tenancy, maxWorkspacesPerUser: 0 } },
        ),
      ).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' })
      const started = await startUpgrade(
        db,
        { userId, name: 'X', slug: `x-${t}`, idempotencyKey: key() },
        config,
      )
      created.workspaces.push(started.targetWorkspaceId)
      // 进行中的流转锁住个人空间
      await expect(
        startUpgrade(db, { userId, name: 'Y', slug: `y-${t}`, idempotencyKey: key() }, config),
      ).rejects.toMatchObject({ code: 'TRANSFER_IN_PROGRESS' })
      await db
        .insert(direction)
        .values({ workspaceId: started.targetWorkspaceId, name: 'pre-existing' })
      await expect(planTransfer(db, started.transferId, config)).rejects.toMatchObject({
        code: 'TRANSFER_TARGET_NOT_EMPTY',
      })
      await db.delete(direction).where(eq(direction.workspaceId, started.targetWorkspaceId))
      await compensateTransfer(db, started.transferId, 'TRANSFER_TARGET_NOT_EMPTY')
    })
  })

  describe('选择性移动', () => {
    it('冲突按决定重命名 / 合并 / 保留目标，补偿后两边逐行恢复', async () => {
      const t = tag()
      const owner = await createUser(db, created, `mv${t}`)
      const a = await createTeam(db, created, `A${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `B${t}`, [{ userId: owner, role: 'admin' }])
      const src = await seedWorkspace(db, created, a, { tag: t, tier: 'hot' })
      // 目标：同名方向、同一店铺与商品（冷档）、同名同计费物流方案、同名节点
      const dst = await seedWorkspace(db, created, b, {
        tag: `${t}b`,
        sellerKey: `seller_${t}`,
        product: src.product,
        tier: 'cold',
      })
      // 源空间已有未流转的“重命名候选名”方向：新名称须避开（否则先在源空间改名会撞唯一索引）
      const [taken] = await db
        .insert(direction)
        .values({ workspaceId: a, name: `万圣节装饰（来自 A${t}）` })
        .returning()
      // 未流转的店铺引用了移走的方向：源侧去掉该方向
      const [watcher] = await db
        .insert(trackedStore)
        .values({
          workspaceId: a,
          platform: 'ebay',
          marketplace: 'ebay-us',
          sellerKey: `watch_${t}`,
          kind: 'watch',
          directionIds: [src.direction, taken?.id as string],
        })
        .returning()
      // 两条自然键相同的规则都合并到目标同一条规则：同簇两条风险发现改写后撞唯一键，合并为一条
      const [rule2] = (await db.execute(
        sql`insert into risk_rule (id, workspace_id, kind, match, level, description)
          values (${newId()}, ${a}, 'hazmat', '{"attributes":["battery"]}', 'high', 'battery 2')
          returning id`,
      )) as unknown as { id: string }[]
      await db.execute(sql`insert into risk_finding (id, workspace_id, cluster_id, kind, ref, level)
        values (${newId()}, ${a}, ${src.cluster}, 'hazmat', ${rule2?.id}, 'high')`)
      const before = await snapshotRows(db, [a, b])
      const selection = {
        roots: {
          direction: [src.direction],
          store: [src.store],
          trackedProduct: [src.trackedProduct],
          categoryStudy: [src.study],
        },
      }
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection,
          idempotencyKey: key(),
        },
        config,
      )
      const plan = await runAll(started.transferId)
      const decisions = Object.fromEntries(plan.conflicts.map((c) => [c.table, c]))
      expect(decisions.direction).toMatchObject({
        action: 'rename',
        newName: `万圣节装饰（来自 A${t}） 2`,
      })
      expect(decisions.category_study).toMatchObject({ action: 'rename' })
      expect(decisions.tracked_store).toMatchObject({ action: 'merge', targetId: dst.store })
      expect(decisions.tracked_product).toMatchObject({
        action: 'merge',
        targetId: dst.trackedProduct,
      })
      expect(decisions.seasonal_node).toMatchObject({ action: 'merge', targetId: dst.node })
      expect(decisions.logistics_profile).toMatchObject({ action: 'merge', targetId: dst.profile })
      expect(plan.scoringVersions).toEqual([])
      // 店铺并入的方向与原方向类目相同：不新增采集任务
      expect(plan.quota.additionalBrowseCallsPerDay).toBe(0)
      expect(plan.tables.readiness_stat).toBeUndefined()

      // 方向原地移动并改名，节点改指目标同名节点
      const [moved] = await db.select().from(direction).where(eq(direction.id, src.direction))
      expect(moved).toMatchObject({
        workspaceId: b,
        name: `万圣节装饰（来自 A${t}） 2`,
        nodeIds: [dst.node],
      })
      // 报价改指复制到目标的供应商；核算方案改指合并的物流方案；源配置保留
      const [quote] = (await db.execute(
        sql`select workspace_id, supplier_id from supplier_quote where id = ${src.quote}`,
      )) as unknown as { workspace_id: string; supplier_id: string }[]
      expect(quote?.workspace_id).toBe(b)
      const supplierMap = await idMap(started.transferId, 'supplier', src.supplier)
      expect(supplierMap?.action).toBe('merged')
      expect(quote?.supplier_id).toBe(dst.supplier)
      const [scenario] = (await db.execute(
        sql`select profile_id from costing_scenario where id = ${src.scenario}`,
      )) as unknown as { profile_id: string }[]
      expect(scenario?.profile_id).toBe(dst.profile)
      expect(
        (await db.execute(sql`select 1 from logistics_profile where id = ${src.profile}`)).length,
      ).toBe(1)
      // 店铺合并：目标保留并并入方向，源店铺删除；商品取更热档位
      const [store] = await db.select().from(trackedStore).where(eq(trackedStore.id, dst.store))
      expect(store?.directionIds).toEqual([dst.direction, src.direction])
      expect(
        await db.select().from(trackedStore).where(eq(trackedStore.id, src.store)),
      ).toHaveLength(0)
      const [tp] = await db
        .select()
        .from(trackedProduct)
        .where(eq(trackedProduct.id, dst.trackedProduct))
      expect(tp).toMatchObject({ tier: 'hot', tierReason: 'transfer' })
      // 影子验证样本随簇移动；准备度留在源空间
      const counts = await tableCounts(db, a)
      expect(counts).toMatchObject({
        direction: 1,
        cluster: 0,
        recommendation: 0,
        readiness_stat: 1,
        seasonal_node: 1,
        supplier: 1,
      })

      const [detached] = await db
        .select()
        .from(trackedStore)
        .where(eq(trackedStore.id, watcher?.id as string))
      expect(detached).toMatchObject({ workspaceId: a, directionIds: [taken?.id] })
      expect(
        (await idMap(started.transferId, 'tracked_store', watcher?.id as string))?.action,
      ).toBe('updated')
      const findings = (await db.execute(
        sql`select workspace_id, ref from risk_finding where cluster_id = ${src.cluster}`,
      )) as unknown as { workspace_id: string; ref: string }[]
      expect(findings).toEqual([{ workspace_id: b, ref: dst.rule }])

      await compensateTransfer(db, started.transferId, 'TEST_ROLLBACK')
      expect(await snapshotRows(db, [a, b])).toEqual(before)
    })

    it('方向合并：簇挂到目标方向，对标店铺去重（目标 rejected 保持），数组取并集', async () => {
      const t = tag()
      const owner = await createUser(db, created, `mg${t}`)
      const a = await createTeam(db, created, `MA${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `MB${t}`, [{ userId: owner, role: 'owner' }])
      // 源方向带准备度统计：删除合并的源方向会级联删除，须快照并在补偿时恢复
      const src = await seedWorkspace(db, created, a, { tag: t })
      const dst = await seedWorkspace(db, created, b, {
        tag: `${t}b`,
        sellerKey: `seller_${t}`,
        readiness: false,
      })
      await db
        .update(directionSeller)
        .set({ status: 'rejected' })
        .where(eq(directionSeller.id, dst.seller))
      const extra = await db
        .insert(directionSeller)
        .values({
          workspaceId: a,
          directionId: src.direction,
          marketplace: 'ebay-us',
          sellerPlatformId: `other_${t}`,
          status: 'seed',
        })
        .returning()
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection: { roots: { direction: [src.direction] }, conflicts: { direction: 'merge' } },
          idempotencyKey: key(),
        },
        config,
      )
      const plan = await planTransfer(db, started.transferId, config)
      // 计划之后才加入源方向的对标店铺：随方向流转，不被删除源方向时级联删掉
      await db.insert(directionSeller).values({
        workspaceId: a,
        directionId: src.direction,
        marketplace: 'ebay-us',
        sellerPlatformId: `late_${t}`,
        status: 'suggested',
      })
      const before = await snapshotRows(db, [a, b])
      for (const batch of await listTransferBatches(db, started.transferId))
        await runBatch(db, started.transferId, batch.key, config)
      expect((await tableCounts(db, a)).readiness_stat).toBe(0)
      expect(plan.conflicts.find((c) => c.table === 'direction')).toMatchObject({
        action: 'merge',
        targetId: dst.direction,
      })
      // 两个对标店铺按合并后多出的目标类目各新增一个 Browse 任务
      expect(plan.quota.additionalBrowseCallsPerDay).toBe(2)
      expect(await db.select().from(direction).where(eq(direction.id, src.direction))).toHaveLength(
        0,
      )
      const [target] = await db.select().from(direction).where(eq(direction.id, dst.direction))
      expect(target?.categoryIds).toEqual([`cat-${t}b`, `cat-${t}`])
      const clusters = (await db.execute(
        sql`select direction_id, workspace_id from cluster where id = ${src.cluster}`,
      )) as unknown as { direction_id: string; workspace_id: string }[]
      expect(clusters[0]).toEqual({ direction_id: dst.direction, workspace_id: b })
      const sellers = await db
        .select()
        .from(directionSeller)
        .where(eq(directionSeller.directionId, dst.direction))
      expect(sellers.map((s) => [s.sellerPlatformId, s.status]).sort()).toEqual(
        [
          [`late_${t}`, 'suggested'],
          [`other_${t}`, 'seed'],
          [`seller_${t}`, 'rejected'],
        ].sort(),
      )
      expect(extra[0]?.id).toBeDefined()
      await compensateTransfer(db, started.transferId, 'TEST_ROLLBACK')
      expect(await snapshotRows(db, [a, b])).toEqual(before)
    })

    it('以档案为根：带上整簇与整份成本参数，方向在目标复制，成本参数保留目标', async () => {
      const t = tag()
      const owner = await createUser(db, created, `ld${t}`)
      const a = await createTeam(db, created, `LA${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `LB${t}`, [{ userId: owner, role: 'owner' }])
      const src = await seedWorkspace(db, created, a, { tag: t, upgradeOnly: false })
      await db.execute(sql`insert into scoring_setting
        (id, workspace_id, version, weights, reverse_dimensions, veto_threshold, min_dimensions,
          hard_gates, margin_floor_bp)
        values (${newId()}, ${a}, 1, '{}'::jsonb, '{}', 30, 3, '{}'::jsonb, 1500)`)
      await db.insert(costParam).values({ workspaceId: a, platform: 'amazon' })
      await db.insert(costParam).values({ workspaceId: b, platform: 'ebay', commissionRate: 0.2 })
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection: { roots: { decision: [src.decision] } },
          idempotencyKey: key(),
        },
        config,
      )
      const plan = await runAll(started.transferId)
      await finalizeTransfer(db, started.transferId)
      // 整簇（含合并相连的簇）移动；方向留在源空间并复制到目标
      expect(plan.tables).toMatchObject({ cluster: 2, direction: 1, cost_param: 2 })
      expect(plan.scoringVersions).toMatchObject([{ version: 1 }])
      const dirMap = await idMap(started.transferId, 'direction', src.direction)
      expect(dirMap?.action).toBe('copied')
      const [copy] = await db
        .select()
        .from(direction)
        .where(eq(direction.id, dirMap?.targetId as string))
      expect(copy).toMatchObject({ workspaceId: b, name: '万圣节装饰' })
      expect(
        (await db.select().from(direction).where(eq(direction.id, src.direction)))[0],
      ).toMatchObject({ workspaceId: a })
      const leads = (await db.execute(
        sql`select workspace_id, direction_id from lead where id = ${src.lead}`,
      )) as unknown as { workspace_id: string; direction_id: string }[]
      expect(leads[0]).toEqual({ workspace_id: b, direction_id: copy?.id })
      const recs = (await db.execute(
        sql`select direction_id from recommendation where id = ${src.recommendation}`,
      )) as unknown as { direction_id: string }[]
      expect(recs[0]?.direction_id).toBe(copy?.id)
      // 成本参数：目标已有 ebay 默认值保留目标；amazon 复制
      const params = await db.select().from(costParam).where(eq(costParam.workspaceId, b))
      expect(params.map((p) => [p.platform, p.commissionRate]).sort()).toEqual(
        [
          ['amazon', null],
          ['ebay', 0.2],
        ].sort(),
      )
      expect(plan.conflicts.find((c) => c.table === 'cost_param')).toMatchObject({
        action: 'keep-target',
      })
      // 对标店铺随方向留在源空间
      expect(
        await db.select().from(directionSeller).where(eq(directionSeller.id, src.seller)),
      ).toMatchObject([{ workspaceId: a }])
    })
  })

  describe('权限', () => {
    it('member 拒绝；admin 不能移出团队数据；他人个人空间拒绝', async () => {
      const t = tag()
      const owner = await personal(`po${t}`)
      const admin = await personal(`pa${t}`)
      const plain = await personal(`pm${t}`)
      const team = await createTeam(db, created, `P${t}`, [
        { userId: owner, role: 'owner' },
        { userId: admin, role: 'admin' },
        { userId: plain, role: 'member' },
      ])
      const s = await seedWorkspace(db, created, team, { tag: t })
      const move = (userId: string, from: string, to: string) =>
        startMove(
          db,
          {
            userId,
            sourceWorkspaceId: from,
            targetWorkspaceId: to,
            selection: { roots: { direction: [s.direction] } },
            idempotencyKey: key(),
          },
          config,
        )
      await expect(move(plain, team, plain)).rejects.toMatchObject({
        code: 'TRANSFER_FORBIDDEN',
        status: 403,
      })
      await expect(move(admin, team, admin)).rejects.toMatchObject({
        code: 'TRANSFER_FORBIDDEN',
        status: 403,
      })
      await expect(move(owner, team, admin)).rejects.toMatchObject({ code: 'TRANSFER_FORBIDDEN' })
      await expect(move(owner, team, team)).rejects.toMatchObject({
        code: 'TRANSFER_SAME_WORKSPACE',
      })
      await expect(
        startMove(
          db,
          {
            userId: owner,
            sourceWorkspaceId: team,
            targetWorkspaceId: owner,
            selection: { roots: { direction: [s.direction] } },
            idempotencyKey: key(),
          },
          { tenancy: { ...config.tenancy, multiTenant: false } },
        ),
      ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' })
      // 已软删的源或目标空间在发起时拒绝
      const gone = await createTeam(db, created, `PD${t}`, [{ userId: owner, role: 'owner' }])
      await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, gone))
      await expect(move(owner, team, gone)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
      await expect(move(owner, gone, owner)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
      // owner 移到自己的个人空间允许
      const ok = await move(owner, team, owner)
      expect(ok.created).toBe(true)
      await compensateTransfer(db, ok.transferId, 'TEST_CLEANUP')
    })

    it('批次执行时权限失效：批次拒绝，补偿后数据恢复', async () => {
      const t = tag()
      const owner = await createUser(db, created, `rv${t}`)
      const a = await createTeam(db, created, `RA${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `RB${t}`, [{ userId: owner, role: 'owner' }])
      const s = await seedWorkspace(db, created, a, { tag: t })
      const before = await snapshotRows(db, [a, b])
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection: { roots: { direction: [s.direction], store: [s.store] } },
          idempotencyKey: key(),
        },
        config,
      )
      await planTransfer(db, started.transferId, config)
      const [first, ...rest] = await listTransferBatches(db, started.transferId)
      await runBatch(db, started.transferId, first?.key as string, config)
      // 源空间 owner 被降为 admin：移出团队数据的权限失效
      await db
        .update(member)
        .set({ role: 'admin' })
        .where(and(eq(member.organizationId, a), eq(member.userId, owner)))
      await expect(
        runBatch(db, started.transferId, rest[0]?.key as string, config),
      ).rejects.toMatchObject({ code: 'TRANSFER_PERMISSION_REVOKED' })
      await compensateTransfer(db, started.transferId, 'TRANSFER_PERMISSION_REVOKED')
      expect(await snapshotRows(db, [a, b])).toEqual(before)
    })
  })

  describe('状态与顺序', () => {
    async function moving(label: string) {
      const t = tag()
      const owner = await createUser(db, created, `${label}${t}`)
      const a = await createTeam(db, created, `${label}A${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `${label}B${t}`, [{ userId: owner, role: 'owner' }])
      const s = await seedWorkspace(db, created, a, { tag: t })
      const before = await snapshotRows(db, [a, b])
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection: { roots: { direction: [s.direction], store: [s.store] } },
          idempotencyKey: key(),
        },
        config,
      )
      await planTransfer(db, started.transferId, config)
      return { a, b, before, transferId: started.transferId }
    }

    it('进入补偿后批次与完成都不再执行；补偿只能按批次逆序', async () => {
      const { a, b, before, transferId } = await moving('st')
      const batches = await listTransferBatches(db, transferId)
      expect(batches.map((x) => x.key.split(':')[0])).toEqual(['config', 'direction', 'store-pool'])
      await runBatch(db, transferId, batches[0]?.key as string, config)
      await runBatch(db, transferId, batches[1]?.key as string, config)
      await beginCompensation(db, transferId, 'TEST_CANCEL')
      await expect(
        runBatch(db, transferId, batches[2]?.key as string, config),
      ).rejects.toMatchObject({ code: 'TRANSFER_STATE' })
      await expect(finalizeTransfer(db, transferId)).rejects.toMatchObject({
        code: 'TRANSFER_STATE',
      })
      // 先撤销配置批次会级联删掉方向批次中改指复制供应商的报价
      await expect(
        compensateBatch(db, transferId, batches[0]?.key as string),
      ).rejects.toMatchObject({ code: 'TRANSFER_COMPENSATION_ORDER' })
      const [row] = await db
        .select({ status: workspaceTransfer.status })
        .from(workspaceTransfer)
        .where(eq(workspaceTransfer.id, transferId))
      expect(row?.status).toBe('compensating')
      await compensateTransfer(db, transferId, 'TEST_CANCEL')
      expect(await snapshotRows(db, [a, b])).toEqual(before)
    })

    it('执行中空间被软删或团队转为只读：不可重试的 TRANSFER_PERMISSION_REVOKED', async () => {
      const { a, b, before, transferId } = await moving('sd')
      const [first] = await listTransferBatches(db, transferId)
      await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, b))
      await expect(runBatch(db, transferId, first?.key as string, config)).rejects.toMatchObject({
        code: 'TRANSFER_PERMISSION_REVOKED',
      })
      await db.update(organization).set({ deletedAt: null }).where(eq(organization.id, b))
      await expect(
        runBatch(db, transferId, first?.key as string, {
          tenancy: { ...config.tenancy, multiTenant: false },
        }),
      ).rejects.toMatchObject({ code: 'TRANSFER_PERMISSION_REVOKED' })
      expect(NON_RETRYABLE_TRANSFER_ERRORS.has('TRANSFER_PERMISSION_REVOKED')).toBe(true)
      await compensateTransfer(db, transferId, 'TRANSFER_PERMISSION_REVOKED')
      expect(await snapshotRows(db, [a, b])).toEqual(before)
    })
  })

  describe('eBay 账号删除互斥', () => {
    it('删除等待流转批次持有的共享锁', async () => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let locked: () => void = () => {}
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve
      })
      const batch = db.transaction(async (tx) => {
        await lockTransferWorkspaces(tx, [], { sellerData: true })
        locked()
        await held
      })
      await lockTaken
      let done = false
      const deletion = deleteEbayUserData(db, {
        notificationId: `n-${newId()}`,
        username: `nobody_${tag()}`,
      }).then(() => {
        done = true
      })
      await new Promise((r) => setTimeout(r, 300))
      expect(done).toBe(false)
      release()
      await batch
      await deletion
      expect(done).toBe(true)
    })

    it('删除清理流转快照与预览中的卖家；补偿跳过已清理条目；未执行的批次记为 skipped', async () => {
      const t = tag()
      const owner = await createUser(db, created, `eb${t}`)
      const a = await createTeam(db, created, `EA${t}`, [{ userId: owner, role: 'owner' }])
      const b = await createTeam(db, created, `EB${t}`, [{ userId: owner, role: 'owner' }])
      const seller = `Seller_${t}`
      const src = await seedWorkspace(db, created, a, { tag: t, sellerKey: seller })
      await seedWorkspace(db, created, b, { tag: `${t}b`, sellerKey: seller })
      // 另一个店铺：计划后、批次前被删除
      const [gone] = await db
        .insert(trackedStore)
        .values({
          workspaceId: a,
          platform: 'ebay',
          marketplace: 'ebay-us',
          sellerKey: `gone_${t}`,
          kind: 'watch',
        })
        .returning()
      const started = await startMove(
        db,
        {
          userId: owner,
          sourceWorkspaceId: a,
          targetWorkspaceId: b,
          selection: { roots: { store: [src.store, gone?.id as string] } },
          idempotencyKey: key(),
        },
        config,
      )
      const plan = await planTransfer(db, started.transferId, config)
      expect(plan.conflicts.map((c) => c.label)).toContain(seller)
      await deleteEbayUserData(db, { notificationId: `n-${newId()}`, username: `gone_${t}` })
      for (const batch of await listTransferBatches(db, started.transferId))
        await runBatch(db, started.transferId, batch.key, config)
      expect((await idMap(started.transferId, 'tracked_store', gone?.id as string))?.action).toBe(
        'skipped',
      )
      const merged = await idMap(started.transferId, 'tracked_store', src.store)
      expect(merged?.action).toBe('merged')
      expect(merged?.sourceRow).not.toBeNull()

      await deleteEbayUserData(db, {
        notificationId: `n-${newId()}`,
        username: seller.toLowerCase(),
      })
      expect((await idMap(started.transferId, 'tracked_store', src.store))?.sourceRow).toBeNull()
      const [transfer] = await db
        .select()
        .from(workspaceTransfer)
        .where(eq(workspaceTransfer.id, started.transferId))
      expect(
        (transfer?.plan as unknown as TransferPlan | undefined)?.conflicts.map((c) => c.label),
      ).not.toContain(seller)

      await compensateTransfer(db, started.transferId, 'TEST_ROLLBACK')
      // 被删卖家的店铺不会从快照恢复
      const stores = await db.execute(
        sql`select id from tracked_store where lower(seller_key) = ${seller.toLowerCase()}`,
      )
      expect(stores).toHaveLength(0)
      const [state] = await db
        .select({ status: workspaceTransferBatch.status })
        .from(workspaceTransferBatch)
        .where(eq(workspaceTransferBatch.transferId, started.transferId))
      expect(state?.status).toBe('compensated')
    })
  })
})
