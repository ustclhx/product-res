import { env } from 'cloudflare:workers'
import { ensurePersonalWorkspace } from '@product-res/auth'
import {
  auditLog,
  createDb,
  direction,
  organization,
  scoped,
  user,
  workspaceTransfer,
} from '@product-res/db'
import type { WorkspaceTransferWorkflowParams } from '@product-res/follow/transfer'
import type { Workflow, WorkflowInstance } from '@product-res/platform'
import { AppError, newId } from '@product-res/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  activeTransferBanner,
  cancelWorkspaceTransfer,
  retryWorkspaceTransfer,
  startWorkspaceUpgrade,
  type TransferActor,
  type TransferDeps,
  upgradePreview,
  workspaceTransferDetail,
  workspaceTransfers,
} from '../src/features/transfer/transfer.server.ts'

// add-workspace-data-transfer 4.1：流转服务端入口（事务内投递、幂等、开关、取消与续跑）。
// 测试库为隔离库；审计只追加，创建的用户与空间保留。
const db = () => createDb(env.HYPERDRIVE)
const config = {
  tenancy: { multiTenant: true, dataTransfer: true, maxWorkspacesPerUser: 5 },
  credits: { enabled: true, requireGrantForAccess: true },
} as const

function fakeWorkflow(options: { fail?: boolean; status?: string } = {}) {
  const created: { id: string; params: WorkspaceTransferWorkflowParams }[] = []
  const instance = (id: string) =>
    ({
      id,
      // 本 fake 新建的实例视为运行中；其余实例（主实例）按 options.status
      status: async () => ({
        status: created.some((c) => c.id === id) ? 'running' : (options.status ?? 'running'),
      }),
      terminate: async () => {},
      sendEvent: async () => {},
    }) as unknown as WorkflowInstance
  const workflow: Workflow<WorkspaceTransferWorkflowParams> = {
    async create({ id, params }) {
      // 模拟投递耗时，让并发请求在行锁上交错
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (options.fail) throw new AppError('WORKFLOW_UNAVAILABLE', 'down', { status: 503 })
      created.push({ id: id as string, params })
      return instance(id as string)
    },
    async get(id) {
      return instance(id)
    },
  }
  return { workflow, created }
}

const deps = (workflow?: Workflow<WorkspaceTransferWorkflowParams>, overrides = {}) =>
  ({
    db: db(),
    workflow: workflow ? { available: true, value: workflow } : { available: false },
    config: { ...config, ...overrides },
  }) as TransferDeps

async function personal(): Promise<TransferActor> {
  const userId = newId()
  await db()
    .insert(user)
    .values({ id: userId, name: 'Upgrader', email: `${userId}@transfer.test` })
  await ensurePersonalWorkspace(db(), { id: userId })
  await scoped(db(), userId).insert(direction, { name: '万圣节装饰' })
  return {
    userId,
    sessionId: newId(),
    workspace: { id: userId, isPersonal: true },
    role: 'owner',
  }
}

describe('数据流转服务端入口', () => {
  it('升级：同一幂等键两次只建一个流转与一个团队空间，实例 id 为流转 id', async () => {
    const actor = await personal()
    const { workflow, created } = fakeWorkflow()
    const slug = `up-${actor.userId.slice(-12)}`
    const input = { name: 'Team', slug, idempotencyKey: `k-${actor.userId}` }
    const first = await startWorkspaceUpgrade(deps(workflow), actor, input)
    const again = await startWorkspaceUpgrade(deps(workflow), actor, input)
    expect(first.created).toBe(true)
    expect(again).toMatchObject({ transferId: first.transferId, created: false })
    expect(created).toEqual([{ id: first.transferId, params: { transferId: first.transferId } }])
    expect(await db().select().from(organization).where(eq(organization.slug, slug))).toHaveLength(
      1,
    )
    const transfers = await db()
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.sourceWorkspaceId, actor.userId))
    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.selection).toEqual({ sessionId: actor.sessionId })

    const [summary] = await workspaceTransfers(deps(workflow), actor)
    expect(summary).toMatchObject({ id: first.transferId, kind: 'upgrade', status: 'pending' })
    expect(
      (await workspaceTransferDetail(deps(workflow), actor, first.transferId)).progress,
    ).toEqual({ done: 0, compensated: 0, total: 0 })
    // 不属于当前空间的流转视为不存在
    const other = await personal()
    await expect(
      workspaceTransferDetail(deps(workflow), other, first.transferId),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('Workflow 不可用或投递失败：整体回滚，不留下流转与团队空间', async () => {
    const actor = await personal()
    const slug = `rb-${actor.userId.slice(-12)}`
    const input = { name: 'Team', slug, idempotencyKey: `k-${actor.userId}` }
    await expect(startWorkspaceUpgrade(deps(), actor, input)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(
      startWorkspaceUpgrade(deps(fakeWorkflow({ fail: true }).workflow), actor, input),
    ).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' })
    expect(await db().select().from(organization).where(eq(organization.slug, slug))).toHaveLength(
      0,
    )
    expect(
      await db()
        .select()
        .from(workspaceTransfer)
        .where(eq(workspaceTransfer.sourceWorkspaceId, actor.userId)),
    ).toHaveLength(0)
  })

  it('开关关闭时 404；非个人空间不能升级', async () => {
    const actor = await personal()
    const { workflow } = fakeWorkflow()
    const input = { name: 'Team', slug: `off-${actor.userId.slice(-12)}`, idempotencyKey: 'k' }
    await expect(
      startWorkspaceUpgrade(
        deps(workflow, {
          tenancy: { multiTenant: true, dataTransfer: false, maxWorkspacesPerUser: 5 },
        }),
        actor,
        input,
      ),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      startWorkspaceUpgrade(
        deps(workflow),
        { ...actor, workspace: { id: newId(), isPersonal: false } },
        input,
      ),
    ).rejects.toMatchObject({ code: 'TRANSFER_FORBIDDEN' })
  })

  it('升级预览：数据条数、留在个人空间的内容与新空间需开通提示', async () => {
    const actor = await personal()
    const preview = await upgradePreview(deps(fakeWorkflow().workflow), actor)
    expect(preview).toMatchObject({
      eligible: true,
      reasons: [],
      targetRequiresActivation: true,
      stays: { subscriptions: 0, aiConversations: 0, files: 0, apiKeys: 0 },
    })
    expect(preview.tables.direction).toBe(1)
    expect(preview.total).toBeGreaterThanOrEqual(1)
  })

  it('取消进入补偿并在实例停止时另起实例；续跑只在进行中且实例停止时启动', async () => {
    const actor = await personal()
    const running = fakeWorkflow()
    const started = await startWorkspaceUpgrade(deps(running.workflow), actor, {
      name: 'Team',
      slug: `cx-${actor.userId.slice(-12)}`,
      idempotencyKey: 'k',
    })
    // 主实例仍在运行：续跑不重复启动
    expect(await retryWorkspaceTransfer(deps(running.workflow), actor, started.transferId)).toEqual(
      { status: 'pending', resumed: false },
    )
    // 非发起人且非 owner 不能取消，也看不到详情
    const stranger = { ...actor, userId: newId(), role: 'admin' }
    await expect(
      cancelWorkspaceTransfer(deps(running.workflow), stranger, started.transferId),
    ).rejects.toMatchObject({ code: 'TRANSFER_FORBIDDEN' })
    await expect(
      workspaceTransferDetail(
        deps(running.workflow),
        { ...stranger, role: 'member' },
        started.transferId,
      ),
    ).rejects.toMatchObject({ status: 404 })
    // 开关关闭后取消、续跑、详情仍可用（进行中的流转先完成或补偿）
    const off = { tenancy: { multiTenant: true, dataTransfer: false, maxWorkspacesPerUser: 5 } }
    const stopped = fakeWorkflow({ status: 'failed' })
    expect(
      await cancelWorkspaceTransfer(deps(stopped.workflow, off), actor, started.transferId),
    ).toEqual({ status: 'compensating', resumed: true })
    expect(stopped.created).toHaveLength(1)
    const instanceId = stopped.created[0]?.id as string
    expect(instanceId.startsWith(`${started.transferId}-`)).toBe(true)
    const [row] = await db()
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, started.transferId))
    expect(row).toMatchObject({
      status: 'compensating',
      errorCode: 'TRANSFER_CANCELLED',
      workflowInstanceId: instanceId,
    })
    // 取消审计记录真实操作人
    const [failed] = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, actor.userId),
          eq(auditLog.action, 'workspace.transfer.failed'),
        ),
      )
    expect(failed?.meta).toMatchObject({
      cancelledBy: actor.userId,
      errorCode: 'TRANSFER_CANCELLED',
    })
    // 当前实例在运行：续跑不再起新实例
    expect(
      await retryWorkspaceTransfer(deps(stopped.workflow, off), actor, started.transferId),
    ).toEqual({ status: 'compensating', resumed: false })
    expect(
      (await workspaceTransferDetail(deps(stopped.workflow, off), actor, started.transferId))
        .status,
    ).toBe('compensating')
  })

  it('并发续跑只起一个实例', async () => {
    const actor = await personal()
    const first = fakeWorkflow()
    const started = await startWorkspaceUpgrade(deps(first.workflow), actor, {
      name: 'Team',
      slug: `cc-${actor.userId.slice(-12)}`,
      idempotencyKey: 'k',
    })
    const stopped = fakeWorkflow({ status: 'failed' })
    const results = await Promise.all([
      retryWorkspaceTransfer(deps(stopped.workflow), actor, started.transferId),
      retryWorkspaceTransfer(deps(stopped.workflow), actor, started.transferId),
    ])
    expect(results.map((r) => r.resumed).sort()).toEqual([false, true])
    expect(stopped.created).toHaveLength(1)
  })

  it('非个人空间的升级预览直接拒绝，不返回空间数据', async () => {
    const actor = await personal()
    await expect(
      upgradePreview(deps(fakeWorkflow().workflow), {
        ...actor,
        workspace: { id: newId(), isPersonal: false },
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_FORBIDDEN' })
  })

  it('只读横幅：进行中的流转两边都显示，详情链接只给 owner / admin 与发起人，结束后消失', async () => {
    const actor = await personal()
    const { workflow } = fakeWorkflow()
    const started = await startWorkspaceUpgrade(deps(workflow), actor, {
      name: 'Team',
      slug: `bn-${actor.userId.slice(-12)}`,
      idempotencyKey: 'k',
    })
    const mine = { userId: actor.userId, role: 'owner' }
    expect(await activeTransferBanner(db(), actor.userId, mine)).toEqual({
      id: started.transferId,
      kind: 'upgrade',
      status: 'pending',
      viewable: true,
    })
    expect(
      await activeTransferBanner(db(), started.targetWorkspaceId, {
        userId: newId(),
        role: 'member',
      }),
    ).toMatchObject({ id: started.transferId, viewable: false })
    await db()
      .update(workspaceTransfer)
      .set({ status: 'completed' })
      .where(eq(workspaceTransfer.id, started.transferId))
    expect(await activeTransferBanner(db(), actor.userId, mine)).toBeNull()
  })
})
