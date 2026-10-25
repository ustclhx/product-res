import { ensurePersonalWorkspace } from '@product-res/auth'
import { auditLog, readinessStat, weightSuggestion } from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  compensateTransfer,
  finalizeTransfer,
  getWorkspaceTransferDetail,
  listTransferBatches,
  listWorkspaceTransfers,
  planTransfer,
  runBatch,
  startMove,
  startUpgrade,
} from '../src/transfer/index.ts'
import { testDb, url } from './helpers.ts'
import {
  type Created,
  cleanupCreated,
  config,
  createTeam,
  createUser,
  seedWorkspace,
} from './transfer-helpers.ts'

// add-workspace-data-transfer tasks 5.1（审计）与 4.2（move 完成后重算准备度、作废权重建议）。
describe.skipIf(!url)('数据流转审计与派生统计', () => {
  const db = testDb()
  const created: Created = { users: [], workspaces: [], products: [] }
  afterAll(() => cleanupCreated(db, created))
  const tag = () => newId().slice(-8)

  async function runAll(transferId: string) {
    await planTransfer(db, transferId, config)
    for (const batch of await listTransferBatches(db, transferId))
      await runBatch(db, transferId, batch.key, config)
  }

  async function audits(workspaceIds: string[]) {
    return db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.workspaceId, workspaceIds))
      .orderBy(auditLog.id)
  }

  it('升级：发起、完成在源与目标各一行，另写升级 / 创建 / owner 加入；重试不重复写，已有审计不改归属', async () => {
    const t = tag()
    const userId = await createUser(db, created, `au${t}`)
    await ensurePersonalWorkspace(db, { id: userId })
    created.workspaces.push(userId)
    await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
    const [old] = await db
      .insert(auditLog)
      .values({ workspaceId: userId, actorUserId: userId, action: 'test.before' })
      .returning()
    const input = { userId, name: 'Team', slug: `aud-${t}`, idempotencyKey: `k-${t}` }
    const started = await startUpgrade(db, input, config)
    await startUpgrade(db, input, config)
    created.workspaces.push(started.targetWorkspaceId)
    await runAll(started.transferId)
    await finalizeTransfer(db, started.transferId)
    await finalizeTransfer(db, started.transferId)

    const rows = await audits([userId, started.targetWorkspaceId])
    const of = (ws: string) =>
      rows
        .filter((r) => r.workspaceId === ws)
        .map((r) => r.action)
        .sort()
    expect(of(userId)).toEqual(
      [
        'test.before',
        'workspace.transfer.completed',
        'workspace.transfer.requested',
        'workspace.upgraded',
      ].sort(),
    )
    expect(of(started.targetWorkspaceId)).toEqual(
      [
        'workspace.created_from_personal',
        'workspace.member_added',
        'workspace.transfer.completed',
        'workspace.transfer.requested',
      ].sort(),
    )
    // 已有审计行仍在个人空间
    const [kept] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, old?.id as string))
    expect(kept?.workspaceId).toBe(userId)
    const completed = rows.find(
      (r) => r.workspaceId === userId && r.action === 'workspace.transfer.completed',
    )
    expect(completed).toMatchObject({
      actorUserId: userId,
      targetType: 'workspace_transfer',
      targetId: started.transferId,
    })
    expect(completed?.meta).toMatchObject({
      transferId: started.transferId,
      kind: 'upgrade',
      side: 'source',
      counterpartWorkspaceId: started.targetWorkspaceId,
      counts: { direction: { moved: 1 }, lead: { moved: 1 } },
    })
    const added = rows.find((r) => r.action === 'workspace.member_added')
    expect(added?.meta).toMatchObject({ targetUserId: userId, newRole: 'owner', oldRole: null })

    // 只读查询：列表与详情（进度、计数）
    const [summary] = await listWorkspaceTransfers(db, userId)
    expect(summary).toMatchObject({
      id: started.transferId,
      status: 'completed',
      progress: { done: 6, total: 6 },
    })
    const detail = await getWorkspaceTransferDetail(db, started.transferId, userId)
    expect(detail?.counts.direction).toEqual({ moved: 1 })
    expect(await getWorkspaceTransferDetail(db, started.transferId, newId())).toBeNull()
  })

  it('失败转补偿：两边各记失败与回滚，带错误码与已执行计数', async () => {
    const t = tag()
    const owner = await createUser(db, created, `af${t}`)
    const a = await createTeam(db, created, `FA${t}`, [{ userId: owner, role: 'owner' }])
    const b = await createTeam(db, created, `FB${t}`, [{ userId: owner, role: 'owner' }])
    const src = await seedWorkspace(db, created, a, { tag: t })
    const started = await startMove(
      db,
      {
        userId: owner,
        sourceWorkspaceId: a,
        targetWorkspaceId: b,
        selection: { roots: { direction: [src.direction] } },
        idempotencyKey: `k-${t}`,
      },
      config,
    )
    await runAll(started.transferId)
    await compensateTransfer(db, started.transferId, 'TRANSFER_PERMISSION_REVOKED')
    await compensateTransfer(db, started.transferId, 'TRANSFER_PERMISSION_REVOKED')
    const rows = (await audits([a, b])).filter((r) => r.action.startsWith('workspace.transfer.'))
    for (const ws of [a, b])
      expect(
        rows
          .filter((r) => r.workspaceId === ws)
          .map((r) => r.action)
          .sort(),
      ).toEqual([
        'workspace.transfer.compensated',
        'workspace.transfer.failed',
        'workspace.transfer.requested',
      ])
    const failed = rows.find((r) => r.workspaceId === b && r.action === 'workspace.transfer.failed')
    expect(failed?.meta).toMatchObject({
      kind: 'move',
      side: 'target',
      counterpartWorkspaceId: a,
      errorCode: 'TRANSFER_PERMISSION_REVOKED',
      counts: { direction: { moved: 1 } },
    })
  })

  it('move 完成后两边重算准备度，源空间未处理的权重建议作废（发起人）', async () => {
    const t = tag()
    const owner = await createUser(db, created, `ar${t}`)
    const a = await createTeam(db, created, `RA${t}`, [{ userId: owner, role: 'owner' }])
    const b = await createTeam(db, created, `RB${t}`, [{ userId: owner, role: 'owner' }])
    const src = await seedWorkspace(db, created, a, { tag: t })
    // 目标有一条与流入样本无关的陈旧统计
    await db.insert(readinessStat).values({
      workspaceId: b,
      marketplace: 'ebay-us',
      directionId: (await seedWorkspace(db, created, b, { tag: `${t}b`, readiness: false }))
        .direction,
      signalType: 'market-demand',
      computedOn: '2020-01-01',
      level: 'cold-start',
    })
    const [pending] = await db
      .insert(weightSuggestion)
      .values({
        workspaceId: a,
        sampleCount: 10,
        suggestedWeights: {} as never,
        currentWeights: {} as never,
        metrics: {},
      })
      .returning()
    const started = await startMove(
      db,
      {
        userId: owner,
        sourceWorkspaceId: a,
        targetWorkspaceId: b,
        selection: { roots: { direction: [src.direction] } },
        idempotencyKey: `k-${t}`,
      },
      config,
    )
    await runAll(started.transferId)
    await finalizeTransfer(db, started.transferId)

    const [suggestion] = await db
      .select()
      .from(weightSuggestion)
      .where(eq(weightSuggestion.id, pending?.id as string))
    expect(suggestion).toMatchObject({ status: 'dismissed', resolvedBy: owner })
    // 重算后统计只来自各自空间现有的样本：陈旧行被清除，移走的方向在两边都按样本重新生成
    const stats = async (ws: string) =>
      db
        .select()
        .from(readinessStat)
        .where(and(eq(readinessStat.workspaceId, ws)))
    const target = await stats(b)
    expect(target.some((s) => s.computedOn === '2020-01-01')).toBe(false)
    expect(target.some((s) => s.directionId === src.direction)).toBe(true)
    const source = await stats(a)
    expect(source.some((s) => s.directionId === src.direction)).toBe(false)
  })
})
