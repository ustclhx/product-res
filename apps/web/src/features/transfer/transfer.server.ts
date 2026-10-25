import type { TemplateConfig } from '@product-res/config'
import { getCreditBalance } from '@product-res/credits'
import {
  aiConversation,
  apikey,
  auditLog,
  type Database,
  file,
  notFound,
  scoped,
  subscription,
  WORKSPACE_TRANSFER_ACTIVE_STATUSES,
  workspaceTransfer,
} from '@product-res/db'
import {
  beginCompensation,
  getWorkspaceTransferDetail,
  holdTransferStart,
  listWorkspaceTransfers,
  type StartResult,
  startMove,
  startUpgrade,
  type TransferDetail,
  type TransferSummary,
  upgradeTableCounts,
  type WorkspaceTransferWorkflowParams,
} from '@product-res/follow/transfer'
import { type Capability, requireCapability, type Workflow } from '@product-res/platform'
import { AppError, newId } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * 跨空间数据流转的服务端入口（openspec/changes/add-workspace-data-transfer tasks 4.1，design D6、D8、D11）。
 * 页面（W4）经 transfer.functions.ts 调用；权限以引擎为准（assertTransferAccess），入口另做
 * requireFreshSession（在 functions 层）与开关检查。流转表同时关联两个空间、不经 scoped()，
 * 每个查询都限定在请求者所在的空间（作为源或目标）。
 */

export type TransferWorkflow = Workflow<WorkspaceTransferWorkflowParams>

export interface TransferDeps {
  readonly db: Database
  readonly workflow: Capability<TransferWorkflow> | undefined
  readonly config: Pick<TemplateConfig, 'tenancy' | 'credits'>
}

/** 请求者在当前空间（URL slug 解析出的空间）中的身份 */
export interface TransferActor {
  readonly userId: string
  readonly sessionId: string
  readonly workspace: { readonly id: string; readonly isPersonal: boolean }
  readonly role: string
}

/**
 * 开关关闭时发起入口表现为不存在（与未开放的功能一致）。列表、详情、取消、续跑与后台只读
 * 不受开关影响：design Migration Plan 要求进行中的流转先完成或补偿，关闭开关后卡住的流转仍可自助恢复。
 */
export function assertTransferEnabled(config: Pick<TemplateConfig, 'tenancy'>) {
  if (!config.tenancy.dataTransfer) throw notFound()
}

function workflowOf(deps: TransferDeps): TransferWorkflow {
  return requireCapability(
    deps.workflow ?? { available: false },
    'Transfer workflow',
  ) as TransferWorkflow
}

/**
 * 与 media-tasks 相同的事务性投递：在写入流转记录的事务内启动实例，创建失败则整体回滚。
 * 先持有发起锁（Workflow 的 load 步骤等它释放后再读），并记录当前实例 id。
 */
const enqueue = (workflow: TransferWorkflow) => ({
  onCreated: async (tx: Tx, transfer: { id: string }) => {
    await holdTransferStart(tx, transfer.id)
    await tx
      .update(workspaceTransfer)
      .set({ workflowInstanceId: transfer.id })
      .where(eq(workspaceTransfer.id, transfer.id))
    await workflow.create({ id: transfer.id, params: { transferId: transfer.id } })
  },
})

export interface StartUpgradeInput {
  readonly name: string
  readonly slug: string
  readonly idempotencyKey: string
}

/** 发起升级：当前空间必须是请求者自己的个人空间；同一幂等键重复提交返回同一流转与同一团队空间 */
export async function startWorkspaceUpgrade(
  deps: TransferDeps,
  actor: TransferActor,
  input: StartUpgradeInput,
): Promise<StartResult> {
  assertTransferEnabled(deps.config)
  if (!actor.workspace.isPersonal || actor.workspace.id !== actor.userId)
    throw new AppError('TRANSFER_FORBIDDEN', '只能升级自己的个人空间', { status: 403 })
  // 在任何写入之前确认 Workflow 可用，避免留下无人执行的流转（两个空间会一直只读）
  const workflow = workflowOf(deps)
  return startUpgrade(
    deps.db,
    {
      userId: actor.userId,
      name: input.name,
      slug: input.slug,
      idempotencyKey: input.idempotencyKey,
      sessionId: actor.sessionId,
    },
    deps.config,
    enqueue(workflow),
  )
}

export interface StartMoveInput {
  readonly targetWorkspaceId: string
  readonly selection: unknown
  readonly idempotencyKey: string
}

/** 发起选择性移动：当前空间为源；源 / 目标权限按 D6 由引擎校验 */
export async function startWorkspaceMove(
  deps: TransferDeps,
  actor: TransferActor,
  input: StartMoveInput,
): Promise<StartResult> {
  assertTransferEnabled(deps.config)
  const workflow = workflowOf(deps)
  return startMove(
    deps.db,
    {
      userId: actor.userId,
      sourceWorkspaceId: actor.workspace.id,
      targetWorkspaceId: input.targetWorkspaceId,
      selection: input.selection,
      idempotencyKey: input.idempotencyKey,
    },
    deps.config,
    enqueue(workflow),
  )
}

export interface UpgradePreview {
  /** 是否可以发起（不满足时 reasons 列出原因码） */
  readonly eligible: boolean
  readonly reasons: readonly string[]
  /** 随升级移动的数据：按表行数 */
  readonly tables: Readonly<Record<string, number>>
  readonly total: number
  /** 不随迁移、留在个人空间的内容 */
  readonly stays: {
    readonly credits: { readonly available: number; readonly held: number } | null
    readonly subscriptions: number
    readonly aiConversations: number
    readonly files: number
    readonly apiKeys: number
    readonly auditLogs: number
  }
  /** 新团队空间需管理员开通才能使用工作台（credits.requireGrantForAccess） */
  readonly targetRequiresActivation: boolean
  readonly maxWorkspacesPerUser: number
  readonly teamWorkspaces: number
}

/** 升级预览（D11）：数据条数、不随迁移的内容与新空间需开通的提示 */
export async function upgradePreview(
  deps: TransferDeps,
  actor: TransferActor,
): Promise<UpgradePreview> {
  assertTransferEnabled(deps.config)
  const { db, config } = deps
  const ws = actor.workspace.id
  // 只能升级自己的个人空间：不满足时不返回积分、订阅等任何空间数据
  if (!actor.workspace.isPersonal || ws !== actor.userId)
    throw new AppError('TRANSFER_FORBIDDEN', '只能升级自己的个人空间', { status: 403 })
  const reasons: string[] = []
  const tenant = scoped(db, ws)
  const [active] = await db
    .select({ id: workspaceTransfer.id })
    .from(workspaceTransfer)
    .where(
      and(
        or(
          eq(workspaceTransfer.sourceWorkspaceId, ws),
          eq(workspaceTransfer.targetWorkspaceId, ws),
        ),
        inArray(workspaceTransfer.status, [...WORKSPACE_TRANSFER_ACTIVE_STATUSES]),
      ),
    )
    .limit(1)
  if (active) reasons.push('TRANSFER_IN_PROGRESS')
  // 与 packages/auth admitTeamWorkspace 相同口径：以 owner 身份持有的未删除团队空间
  const [owned] = (await db.execute(
    sql`select count(*)::int as n from member m join organization o on o.id = m.organization_id
      where m.user_id = ${actor.userId} and m.role = 'owner' and not o.is_personal and o.deleted_at is null`,
  )) as unknown as { n: number }[]
  const teamWorkspaces = owned?.n ?? 0
  if (teamWorkspaces >= config.tenancy.maxWorkspacesPerUser) reasons.push('WORKSPACE_LIMIT')
  const tables = await upgradeTableCounts(db, ws)
  const balance = config.credits.enabled ? await getCreditBalance(db, ws) : null
  const [keys] = (await db.execute(
    sql`select count(*)::int as n from ${apikey} where ${apikey.metadata}::jsonb ->> 'workspaceId' = ${ws}`,
  )) as unknown as { n: number }[]
  return {
    eligible: reasons.length === 0,
    reasons,
    tables,
    total: Object.values(tables).reduce((a, b) => a + b, 0),
    stays: {
      credits: balance ? { available: balance.available, held: balance.held } : null,
      subscriptions: await tenant.count(subscription),
      aiConversations: await tenant.count(aiConversation),
      files: await tenant.count(file, isNull(file.deletedAt)),
      apiKeys: keys?.n ?? 0,
      auditLogs: await tenant.count(auditLog),
    },
    targetRequiresActivation: config.credits.enabled && config.credits.requireGrantForAccess,
    maxWorkspacesPerUser: config.tenancy.maxWorkspacesPerUser,
    teamWorkspaces,
  }
}

const isManager = (actor: TransferActor) => actor.role === 'owner' || actor.role === 'admin'

/** 当前空间作为源或目标的流转记录：owner / admin 看全部，其他成员只看自己发起的 */
export async function workspaceTransfers(
  deps: TransferDeps,
  actor: TransferActor,
): Promise<TransferSummary[]> {
  const list = await listWorkspaceTransfers(deps.db, actor.workspace.id)
  return isManager(actor) ? list : list.filter((t) => t.requestedBy === actor.userId)
}

/**
 * 单条详情（进度、按表计数、跳过 / 重命名清单、失败原因）：仅当前空间的 owner / admin 或发起人可见；
 * 不属于当前空间或无权查看的流转一律视为不存在
 */
export async function workspaceTransferDetail(
  deps: TransferDeps,
  actor: TransferActor,
  transferId: string,
): Promise<TransferDetail> {
  const detail = await getWorkspaceTransferDetail(deps.db, transferId, actor.workspace.id)
  if (!detail || (!isManager(actor) && detail.requestedBy !== actor.userId)) throw notFound()
  return detail
}

const ACTIVE = new Set<string>(WORKSPACE_TRANSFER_ACTIVE_STATUSES)

/** 取消与续跑只允许发起人或当前空间的 owner（流转的另一边也在引擎每批次的权限校验之下） */
async function manageable(deps: TransferDeps, actor: TransferActor, transferId: string) {
  const detail = await workspaceTransferDetail(deps, actor, transferId)
  if (detail.requestedBy !== actor.userId && actor.role !== 'owner')
    throw new AppError('TRANSFER_FORBIDDEN', '只有发起人或空间所有者可以操作流转', {
      status: 403,
    })
  return detail
}

const LIVE = new Set(['queued', 'running', 'waiting', 'paused'])

async function alive(workflow: TransferWorkflow, instanceId: string): Promise<boolean> {
  try {
    return LIVE.has((await (await workflow.get(instanceId)).status()).status)
  } catch (error) {
    if (error instanceof AppError && error.code === 'WORKFLOW_NOT_FOUND') return false
    throw error
  }
}

/**
 * 确保有且只有一个 Workflow 实例在推进该流转：在流转行锁下读取当前实例 id，只有它已终止（或不存在）
 * 才另起 `<流转 id>-<uuid>` 并在同一事务内记录；并发的两个请求按行锁排队，后到者看到新实例仍在运行即返回。
 * 实例创建失败则不更新记录。
 */
async function ensureRunning(
  deps: TransferDeps,
  workflow: TransferWorkflow,
  transferId: string,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        status: workspaceTransfer.status,
        instance: workspaceTransfer.workflowInstanceId,
      })
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, transferId))
      .for('update')
    if (!row || !ACTIVE.has(row.status)) return false
    if (await alive(workflow, row.instance ?? transferId)) return false
    const instanceId = `${transferId}-${newId()}`
    await tx
      .update(workspaceTransfer)
      .set({ workflowInstanceId: instanceId })
      .where(eq(workspaceTransfer.id, transferId))
    await workflow.create({ id: instanceId, params: { transferId } })
    return true
  })
}

/**
 * 取消（完成前）：状态置为 compensating（错误码 TRANSFER_CANCELLED），运行中的实例在下一批次
 * 转入补偿路径；实例已停止时另起实例执行补偿。
 */
export async function cancelWorkspaceTransfer(
  deps: TransferDeps,
  actor: TransferActor,
  transferId: string,
): Promise<{ status: string; resumed: boolean }> {
  const detail = await manageable(deps, actor, transferId)
  if (!ACTIVE.has(detail.status))
    throw new AppError('TRANSFER_STATE', `流转状态为 ${detail.status}，不能取消`, { status: 409 })
  const workflow = workflowOf(deps)
  const status = await beginCompensation(deps.db, transferId, 'TRANSFER_CANCELLED', {
    cancelledBy: actor.userId,
  })
  let resumed = false
  try {
    resumed = await ensureRunning(deps, workflow, transferId)
  } catch (error) {
    // 已进入补偿；实例启动失败时用户可稍后“重试”继续补偿
    log.warn('transfer.cancel_resume_failed', {
      transferId,
      code: error instanceof AppError ? error.code : 'UNKNOWN',
    })
  }
  return { status, resumed }
}

/** 重试续跑：流转仍处于进行中（含补偿中）而执行实例已停止时，另起实例从未完成的批次继续 */
export async function retryWorkspaceTransfer(
  deps: TransferDeps,
  actor: TransferActor,
  transferId: string,
): Promise<{ status: string; resumed: boolean }> {
  const detail = await manageable(deps, actor, transferId)
  if (!ACTIVE.has(detail.status))
    throw new AppError('TRANSFER_STATE', `流转状态为 ${detail.status}，不能续跑`, { status: 409 })
  const resumed = await ensureRunning(deps, workflowOf(deps), transferId)
  return { status: detail.status, resumed }
}

/** /admin/workspaces 详情的只读流转记录（平台管理员；不提供代操作，D6） */
export async function adminWorkspaceTransfers(
  db: Database,
  workspaceId: string,
): Promise<TransferSummary[]> {
  return listWorkspaceTransfers(db, workspaceId)
}

export async function adminWorkspaceTransferDetail(
  db: Database,
  workspaceId: string,
  transferId: string,
): Promise<TransferDetail> {
  const detail = await getWorkspaceTransferDetail(db, transferId, workspaceId)
  if (!detail) throw notFound()
  return detail
}
