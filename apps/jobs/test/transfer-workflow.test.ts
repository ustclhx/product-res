import { env } from 'cloudflare:workers'
import { ensurePersonalWorkspace } from '@product-res/auth'
import { auditLog, createDb, organization, session, workspaceTransfer } from '@product-res/db'
import {
  beginCompensation,
  compensateTransfer,
  listTransferBatches,
  startUpgrade,
} from '@product-res/follow/transfer'
import { NonRetryableError, type WorkflowStep } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type Created,
  cleanupCreated,
  config,
  createSession,
  createUser,
  seedWorkspace,
  snapshotRows,
  tableCounts,
} from '../../../packages/follow/test/transfer-helpers.ts'
import {
  runWorkspaceTransfer,
  TRANSFER_TIMEOUT_CODE,
  type TransferRunnerDeps,
} from '../src/workflows/transfer-runner.ts'

// add-workspace-data-transfer 4.1：流转 Workflow 端到端（真实 PG + 引擎，步骤由与 media-workflow 相同的假 step 驱动）。
const db = createDb(env.HYPERDRIVE)
const created: Created = { users: [], workspaces: [], products: [] }
afterAll(() => cleanupCreated(db, created))

class Crash extends Error {}

/** 假 step：按 retries.limit 同步重试，NonRetryableError 不重试；crashAfter 模拟进程在某步骤后中断 */
function harness(
  options: {
    after?: (name: string) => Promise<void>
    crashAfter?: string | ((name: string) => boolean)
    /** 该步骤每次尝试都抛基础设施错误（如数据库不可达），直到重试耗尽 */
    failing?: string
  } = {},
) {
  const names: string[] = []
  let crashed = false
  const step = {
    async do(name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) {
      if (crashed) throw new Crash('process gone')
      if (names.includes(name)) throw new Error(`duplicate step ${name}`)
      names.push(name)
      const callback = (maybeCallback ?? configOrCallback) as () => Promise<unknown>
      const limit = maybeCallback
        ? ((configOrCallback as { retries?: { limit: number } }).retries?.limit ?? 0)
        : 0
      for (let attempt = 0; ; attempt++) {
        try {
          if (options.failing === name) throw new Error('connection terminated')
          const value = JSON.parse(JSON.stringify((await callback()) ?? null))
          await options.after?.(name)
          if (
            typeof options.crashAfter === 'function'
              ? options.crashAfter(name)
              : options.crashAfter === name
          )
            crashed = true
          return value
        } catch (error) {
          if (error instanceof NonRetryableError || attempt >= limit) throw error
        }
      }
    },
  } as unknown as WorkflowStep
  return { step, names }
}

function fakeCache() {
  const deleted: string[] = []
  return { deleted, cache: { delete: async (key: string) => void deleted.push(key) } }
}

const tag = () => newId().slice(-8)

async function upgradeFixture() {
  const t = tag()
  const userId = await createUser(db, created, `wf${t}`)
  await ensurePersonalWorkspace(db, { id: userId })
  created.workspaces.push(userId)
  await seedWorkspace(db, created, userId, { tag: t, upgradeOnly: true })
  const sessionId = await createSession(db, userId, userId)
  const before = await snapshotRows(db, [userId])
  const counts = await tableCounts(db, userId)
  const started = await startUpgrade(
    db,
    { userId, name: 'Team', slug: `wf-${t}`, idempotencyKey: `k-${t}`, sessionId },
    config,
  )
  created.workspaces.push(started.targetWorkspaceId)
  return { userId, sessionId, before, counts, ...started }
}

const deps = (cache: TransferRunnerDeps['cache'], extra: Partial<TransferRunnerDeps> = {}) => ({
  db,
  config,
  cache,
  ...extra,
})

async function transferRow(id: string) {
  const [row] = await db.select().from(workspaceTransfer).where(eq(workspaceTransfer.id, id))
  return row
}

async function transferAudits(f: { userId: string; targetWorkspaceId: string }) {
  return (
    await db
      .select({ action: auditLog.action, workspaceId: auditLog.workspaceId })
      .from(auditLog)
      .where(inArray(auditLog.workspaceId, [f.userId, f.targetWorkspaceId]))
  )
    .filter((r) => r.action.startsWith('workspace.transfer.'))
    .map((r) => `${r.workspaceId === f.userId ? 'source' : 'target'}:${r.action}`)
    .sort()
}

/** plan 之后在目标写入抽检记录：验证批次（最后一批）因目标非空不可重试失败 */
const blockValidation = (f: { targetWorkspaceId: string }) => async (name: string) => {
  if (name === 'plan')
    await db.execute(sql`insert into accuracy_audit (id, workspace_id, week_of, seed, sample_size)
      values (${newId()}, ${f.targetWorkspaceId}, '2031-02-03', 'x', 1)`)
}

async function assertCompensated(f: Awaited<ReturnType<typeof upgradeFixture>>, code: string) {
  expect(await transferRow(f.transferId)).toMatchObject({ status: 'compensated', errorCode: code })
  expect(await snapshotRows(db, [f.userId])).toEqual(f.before)
  expect(Object.values(await tableCounts(db, f.targetWorkspaceId)).every((n) => n === 0)).toBe(true)
  const [team] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, f.targetWorkspaceId))
  expect(team?.deletedAt).not.toBeNull()
  expect(await transferAudits(f)).toEqual(
    [
      'source:workspace.transfer.compensated',
      'source:workspace.transfer.failed',
      'source:workspace.transfer.requested',
      'target:workspace.transfer.compensated',
      'target:workspace.transfer.failed',
      'target:workspace.transfer.requested',
    ].sort(),
  )
}

describe('WorkspaceTransferWorkflow', () => {
  it('升级成功：plan → 逐批 → finalize，会话切到新空间并失效 KV 缓存', async () => {
    const f = await upgradeFixture()
    const { step, names } = harness()
    const kv = fakeCache()
    const result = await runWorkspaceTransfer(f.transferId, step, deps(kv.cache))
    expect(result).toEqual({ transferId: f.transferId, status: 'completed' })
    const batches = (await listTransferBatches(db, f.transferId)).map((b) => b.key)
    expect(names).toEqual([
      'start',
      'load',
      'plan',
      'batches',
      ...batches.map((key) => `batch:${key}`),
      'finalize',
      'refresh',
      'sessions',
    ])
    expect(await tableCounts(db, f.targetWorkspaceId)).toEqual(f.counts)
    expect(kv.deleted).toEqual([`auth:t-${f.sessionId}`])
    const [s] = await db.select().from(session).where(eq(session.id, f.sessionId))
    expect(s?.activeOrganizationId).toBe(f.targetWorkspaceId)
    expect(await transferAudits(f)).toEqual([
      'source:workspace.transfer.completed',
      'source:workspace.transfer.requested',
      'target:workspace.transfer.completed',
      'target:workspace.transfer.requested',
    ])
    // 已完成的流转再次投递：不重做，只重新失效会话缓存
    const again = harness()
    expect(await runWorkspaceTransfer(f.transferId, again.step, deps(kv.cache))).toMatchObject({
      status: 'completed',
    })
    expect(again.names).toEqual(['start', 'load', 'resume:tokens', 'refresh', 'sessions'])
  })

  it('批次中途不可重试失败：逆序补偿，两边恢复，新空间软删，审计记失败与回滚', async () => {
    const f = await upgradeFixture()
    const { step, names } = harness({ after: blockValidation(f) })
    const kv = fakeCache()
    const result = await runWorkspaceTransfer(f.transferId, step, deps(kv.cache))
    expect(result).toEqual({
      transferId: f.transferId,
      status: 'compensated',
      errorCode: 'TRANSFER_TARGET_NOT_EMPTY',
    })
    await db.execute(sql`delete from accuracy_audit where workspace_id = ${f.targetWorkspaceId}`)
    const batches = await listTransferBatches(db, f.transferId)
    const done = batches.filter((b) => b.key !== 'validation').map((b) => b.key)
    const compensations = names.filter(
      (n) => n.startsWith('compensate:') && !/^compensate:(begin|list:\d+|complete)$/.test(n),
    )
    expect(done.length).toBeGreaterThan(1)
    expect(compensations).toEqual([...done].reverse().map((key) => `compensate:${key}`))
    expect(names).not.toContain('finalize')
    await assertCompensated(f, 'TRANSFER_TARGET_NOT_EMPTY')
  })

  it('取消：web 置为补偿后，运行中的实例在下一批次转入补偿', async () => {
    const f = await upgradeFixture()
    const { step } = harness({
      after: async (name) => {
        if (name === 'batch:config') await beginCompensation(db, f.transferId, 'TRANSFER_CANCELLED')
      },
    })
    const result = await runWorkspaceTransfer(f.transferId, step, deps(fakeCache().cache))
    expect(result).toMatchObject({ status: 'compensated', errorCode: 'TRANSFER_CANCELLED' })
    await assertCompensated(f, 'TRANSFER_CANCELLED')
  })

  it('重试续跑：实例在批次之间中断后，另起实例从未完成的批次继续', async () => {
    const f = await upgradeFixture()
    const first = harness({ crashAfter: 'batch:config' })
    await expect(
      runWorkspaceTransfer(f.transferId, first.step, deps(fakeCache().cache)),
    ).rejects.toBeInstanceOf(Crash)
    expect((await transferRow(f.transferId))?.status).toBe('running')
    const states = await listTransferBatches(db, f.transferId)
    expect(states.filter((b) => b.status === 'done').map((b) => b.key)).toEqual(['config'])

    const second = harness()
    const kv = fakeCache()
    expect(await runWorkspaceTransfer(f.transferId, second.step, deps(kv.cache))).toMatchObject({
      status: 'completed',
    })
    expect(await tableCounts(db, f.targetWorkspaceId)).toEqual(f.counts)
    expect(kv.deleted).toEqual([`auth:t-${f.sessionId}`])
    // 已完成的批次只执行一次：计数与计划一致，审计各一行
    const row = await transferRow(f.transferId)
    for (const [table, n] of Object.entries(f.counts))
      expect(row?.counts[table], table).toEqual({ moved: n })
    expect(await transferAudits(f)).toHaveLength(4)
  })

  it('补偿中断后续跑：从剩余批次继续撤销', async () => {
    const f = await upgradeFixture()
    const undoStep = (name: string) =>
      name.startsWith('compensate:') && !/^compensate:(begin|list:\d+|complete)$/.test(name)
    const first = harness({ crashAfter: undoStep, after: blockValidation(f) })
    await expect(
      runWorkspaceTransfer(f.transferId, first.step, deps(fakeCache().cache)),
    ).rejects.toBeInstanceOf(Crash)
    expect((await transferRow(f.transferId))?.status).toBe('compensating')
    await db.execute(sql`delete from accuracy_audit where workspace_id = ${f.targetWorkspaceId}`)
    const second = harness()
    expect(
      await runWorkspaceTransfer(f.transferId, second.step, deps(fakeCache().cache)),
    ).toMatchObject({ status: 'compensated', errorCode: 'TRANSFER_TARGET_NOT_EMPTY' })
    const firstUndo = first.names.find(undoStep)
    expect(firstUndo).toBeDefined()
    expect(second.names).not.toContain(firstUndo)
    expect(second.names.filter(undoStep).length).toBeGreaterThan(0)
    await assertCompensated(f, 'TRANSFER_TARGET_NOT_EMPTY')
  })

  it('总超时：未执行的批次不再开始，转入补偿', async () => {
    const f = await upgradeFixture()
    let now = 1_000
    const { step, names } = harness({
      after: async (name) => {
        if (name === 'batch:config') now += 31 * 60_000
      },
    })
    const result = await runWorkspaceTransfer(
      f.transferId,
      step,
      deps(fakeCache().cache, { now: () => now }),
    )
    expect(result).toMatchObject({ status: 'compensated', errorCode: TRANSFER_TIMEOUT_CODE })
    expect(names).toContain('compensate:config')
    await assertCompensated(f, TRANSFER_TIMEOUT_CODE)
  })
  it('基础设施错误重试耗尽：原样抛出、不补偿，续跑实例接手完成', async () => {
    const f = await upgradeFixture()
    const first = harness({ failing: 'batch:config' })
    await expect(
      runWorkspaceTransfer(f.transferId, first.step, deps(fakeCache().cache)),
    ).rejects.toThrow('connection terminated')
    expect(first.names.some((n) => n.startsWith('compensate:'))).toBe(false)
    expect((await transferRow(f.transferId))?.status).toBe('running')
    const second = harness()
    expect(
      await runWorkspaceTransfer(f.transferId, second.step, deps(fakeCache().cache)),
    ).toMatchObject({ status: 'completed' })
    expect(await tableCounts(db, f.targetWorkspaceId)).toEqual(f.counts)
  })

  it('全部批次完成后 finalize 故障：不回滚，续跑完成', async () => {
    const f = await upgradeFixture()
    const first = harness({ failing: 'finalize' })
    await expect(
      runWorkspaceTransfer(f.transferId, first.step, deps(fakeCache().cache)),
    ).rejects.toThrow('connection terminated')
    expect((await transferRow(f.transferId))?.status).toBe('running')
    const second = harness()
    expect(
      await runWorkspaceTransfer(f.transferId, second.step, deps(fakeCache().cache)),
    ).toMatchObject({ status: 'completed' })
    expect(await transferAudits(f)).toHaveLength(4)
  })

  it('另一实例已完成补偿：补偿步骤遇到 TRANSFER_STATE 直接收尾', async () => {
    const f = await upgradeFixture()
    const { step, names } = harness({
      after: async (name) => {
        await blockValidation(f)(name)
        // 本实例列出待撤销批次后，另一实例抢先完成整个补偿
        if (name === 'compensate:list:0')
          await compensateTransfer(db, f.transferId, 'TRANSFER_TARGET_NOT_EMPTY')
      },
    })
    expect(await runWorkspaceTransfer(f.transferId, step, deps(fakeCache().cache))).toMatchObject({
      status: 'compensated',
      errorCode: 'TRANSFER_TARGET_NOT_EMPTY',
    })
    expect(names.filter((n) => /^compensate:(?!begin|list|complete)/.test(n))).toHaveLength(1)
    await db.execute(sql`delete from accuracy_audit where workspace_id = ${f.targetWorkspaceId}`)
    await assertCompensated(f, 'TRANSFER_TARGET_NOT_EMPTY')
  })

  it('发起事务回滚：实例判定流转不存在后结束', async () => {
    const { step } = harness()
    expect(await runWorkspaceTransfer(newId(), step, deps(fakeCache().cache))).toMatchObject({
      status: 'missing',
    })
  })
})
