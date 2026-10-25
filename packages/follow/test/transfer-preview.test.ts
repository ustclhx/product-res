import { workspaceTransfer } from '@product-res/db'
import { newId } from '@product-res/shared'
import { inArray, or } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { planTransfer, previewTransfer, startCopy } from '../src/transfer/index.ts'
import { testDb, url } from './helpers.ts'
import {
  type Created,
  cleanupCreated,
  config,
  createTeam,
  createUser,
  seedWorkspace,
  tableCounts,
} from './transfer-helpers.ts'

// add-workspace-data-transfer tasks 6.2：对话框预览不落库，且与随后发起的流转计划一致。
describe.skipIf(!url)('数据流转：只读预览', () => {
  const db = testDb()
  const created: Created = { users: [], workspaces: [], products: [] }
  afterAll(() => cleanupCreated(db, created))
  const tag = () => newId().slice(-8)

  async function setup() {
    const t = tag()
    const owner = await createUser(db, created, `pv${t}`)
    const admin = await createUser(db, created, `pva${t}`)
    const viewer = await createUser(db, created, `pvm${t}`)
    const a = await createTeam(db, created, `pvA${t}`, [
      { userId: owner, role: 'owner' },
      { userId: admin, role: 'admin' },
      { userId: viewer, role: 'member' },
    ])
    const b = await createTeam(db, created, `pvB${t}`, [
      { userId: owner, role: 'admin' },
      { userId: admin, role: 'admin' },
    ])
    const src = await seedWorkspace(db, created, a, { tag: t, upgradeOnly: true })
    await seedWorkspace(db, created, b, { tag: `${t}b` })
    return { t, owner, admin, viewer, a, b, src }
  }

  // 映射与批次外键指向流转行（cascade），没有流转行即没有映射与批次
  const persisted = async (...ids: string[]) =>
    (
      await db
        .select({ id: workspaceTransfer.id })
        .from(workspaceTransfer)
        .where(
          or(
            inArray(workspaceTransfer.sourceWorkspaceId, ids),
            inArray(workspaceTransfer.targetWorkspaceId, ids),
          ),
        )
    ).length

  it('冲突预览：同名方向默认重命名、可改为合并；不写流转、映射与批次，两边数据不变', async () => {
    const { t, owner, a, b, src } = await setup()
    const targetBefore = await tableCounts(db, b)
    const input = {
      kind: 'copy' as const,
      userId: owner,
      sourceWorkspaceId: a,
      targetWorkspaceId: b,
      selection: { roots: { direction: [src.direction] } },
    }
    const preview = await previewTransfer(db, input, config)
    expect(preview).toMatchObject({
      kind: 'copy',
      sourceName: `pvA${t}`,
      targetName: `pvB${t}`,
      roots: { direction: 1 },
      tooLarge: false,
      directionsFollowLeads: false,
      scoringVersions: [1],
    })
    expect(preview.tables.direction).toBe(1)
    expect(preview.tables.recommendation).toBeUndefined()
    expect(preview.conflicts.find((c) => c.table === 'direction')).toMatchObject({
      action: 'rename',
      newName: `万圣节装饰（来自 pvA${t}）`,
    })
    // 节点同名合并、物流方案计费一致合并
    expect(preview.conflicts.find((c) => c.table === 'seasonal_node')?.action).toBe('merge')

    const merged = await previewTransfer(
      db,
      { ...input, selection: { ...input.selection, conflicts: { direction: 'merge' } } },
      config,
    )
    expect(merged.conflicts.find((c) => c.table === 'direction')?.action).toBe('merge')

    expect(await persisted(a, b)).toBe(0)
    expect(await tableCounts(db, b)).toEqual(targetBefore)

    // 预览与随后发起的流转计划一致
    const started = await startCopy(db, { ...input, idempotencyKey: `k-${newId()}` }, config)
    const plan = await planTransfer(db, started.transferId, config)
    expect(plan.tables).toEqual(preview.tables)
    expect(plan.conflicts).toEqual(preview.conflicts)
    // 源空间已有进行中的流转：预览拒绝
    await expect(previewTransfer(db, input, config)).rejects.toMatchObject({
      code: 'TRANSFER_IN_PROGRESS',
    })
  })

  it('以档案为根：标注方向随线索复制', async () => {
    const { owner, a, b, src } = await setup()
    const preview = await previewTransfer(
      db,
      {
        kind: 'copy',
        userId: owner,
        sourceWorkspaceId: a,
        targetWorkspaceId: b,
        selection: { roots: { decision: [src.decision] } },
      },
      config,
    )
    expect(preview.directionsFollowLeads).toBe(true)
    expect(preview.roots).toEqual({ decision: 1 })
    expect(preview.tables.decision).toBe(1)
    expect(preview.tables.direction).toBe(1)
  })

  it('权限：member 拒绝；admin 可预览复制团队数据，不能预览移出；不属于源空间的条目拒绝', async () => {
    const { admin, viewer, a, b, src } = await setup()
    const base = {
      userId: admin,
      sourceWorkspaceId: a,
      targetWorkspaceId: b,
      selection: { roots: { direction: [src.direction] } },
    }
    await expect(
      previewTransfer(db, { ...base, kind: 'copy', userId: viewer }, config),
    ).rejects.toMatchObject({ code: 'TRANSFER_FORBIDDEN', status: 403 })
    await expect(previewTransfer(db, { ...base, kind: 'copy' }, config)).resolves.toMatchObject({
      kind: 'copy',
    })
    await expect(previewTransfer(db, { ...base, kind: 'move' }, config)).rejects.toMatchObject({
      code: 'TRANSFER_FORBIDDEN',
    })
    await expect(
      previewTransfer(
        db,
        { ...base, kind: 'copy', selection: { roots: { direction: [newId()] } } },
        config,
      ),
    ).rejects.toMatchObject({ code: 'TRANSFER_EMPTY_SELECTION' })
    await expect(
      previewTransfer(
        db,
        { ...base, kind: 'copy' },
        { tenancy: { ...config.tenancy, dataTransfer: false } },
      ),
    ).rejects.toMatchObject({ code: 'TRANSFER_DISABLED' })
  })
})
