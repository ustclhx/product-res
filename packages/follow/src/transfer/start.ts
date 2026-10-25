import { admitTeamWorkspace, isValidTeamSlug } from '@product-res/auth/workspace-admission'
import {
  type Database,
  member,
  organization,
  type WorkspaceTransfer,
  workspaceTransfer,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { and, eq, sql } from 'drizzle-orm'
import { assertNoActiveTransfer, assertTransferAccess, lockTransferWorkspaces } from './access.ts'
import {
  invalid,
  isUuid,
  parseSelection,
  rows,
  type TransferConfig,
  type Tx,
  transferError,
  uuidList,
  xactLock,
} from './common.ts'
import { tableMeta } from './meta.ts'

/**
 * 流转入口（design D1、D6、D8）：一个事务内写 `workspace_transfer(pending)`；调用方可在同一事务中
 * 经 onCreated 投递 Workflow（TransactionalEnqueue），回滚则不投递。同一用户以同一幂等键重复提交
 * 返回同一流转（created=false）。
 */
export interface StartHooks {
  readonly onCreated?: (tx: Tx, transfer: WorkspaceTransfer) => Promise<void>
}

export interface StartResult {
  readonly transferId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly status: WorkspaceTransfer['status']
  readonly created: boolean
}

const toResult = (transfer: WorkspaceTransfer, created: boolean): StartResult => ({
  transferId: transfer.id,
  sourceWorkspaceId: transfer.sourceWorkspaceId,
  targetWorkspaceId: transfer.targetWorkspaceId,
  status: transfer.status,
  created,
})

function assertEnabled(config: TransferConfig) {
  if (!config.tenancy.dataTransfer) throw transferError('TRANSFER_DISABLED', '数据流转未开启', 403)
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200)
    invalid('幂等键必须是 1–200 个字符')
  return value
}

async function existing(tx: Tx, userId: string, key: string, kind: WorkspaceTransfer['kind']) {
  const [found] = await tx
    .select()
    .from(workspaceTransfer)
    .where(
      and(eq(workspaceTransfer.requestedBy, userId), eq(workspaceTransfer.idempotencyKey, key)),
    )
  if (found && found.kind !== kind)
    throw transferError('TRANSFER_IDEMPOTENCY_CONFLICT', '幂等键已用于其他流转', 409)
  return found
}

export interface StartUpgradeInput {
  readonly userId: string
  /** 新团队空间的名称与 slug（与团队创建同一规则） */
  readonly name: string
  readonly slug: string
  readonly idempotencyKey: string
  /** 完成后切换活跃空间的发起人会话；省略时切换发起人所有停在个人空间的会话 */
  readonly sessionId?: string
}

/**
 * 升级（D1、tasks 3.6）：一个事务内新建团队空间 + owner 成员 + `workspace_transfer(kind='upgrade')`。
 * 团队准入复用 packages/auth（multiTenant、maxWorkspacesPerUser、slug 规则与锁顺序 owner: → slug: → ws:）。
 * 个人空间的 organization 行与成员行不做任何修改。
 */
export async function startUpgrade(
  db: Database,
  input: StartUpgradeInput,
  config: TransferConfig,
  hooks: StartHooks = {},
): Promise<StartResult> {
  assertEnabled(config)
  const key = idempotencyKey(input.idempotencyKey)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < 1 || name.length > 100) invalid('空间名称必须是 1–100 个字符')
  if (!isValidTeamSlug(input.slug))
    throw transferError('INVALID_WORKSPACE_SLUG', 'Invalid or reserved slug', 400)
  if (input.sessionId !== undefined && !isUuid(input.sessionId)) invalid('sessionId 无效')
  return db.transaction(async (tx) => {
    await xactLock(tx, `owner:${input.userId}`)
    const found = await existing(tx, input.userId, key, 'upgrade')
    if (found) return toResult(found, false)
    if (!config.tenancy.multiTenant)
      throw transferError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', 403)
    const [personal] = await rows<{ id: string }>(
      tx,
      sql`select o.id from organization o join member m on m.organization_id = o.id
        where o.id = ${input.userId} and o.is_personal and o.deleted_at is null
          and m.user_id = ${input.userId} and m.role = 'owner'`,
    )
    if (!personal) throw transferError('TRANSFER_FORBIDDEN', '只能升级自己的个人空间', 403)
    await admitTeamWorkspace(
      (strings, ...values) => rows(tx, sql(strings, ...(values as never[]))),
      {
        userId: input.userId,
        slug: input.slug,
        maxWorkspacesPerUser: config.tenancy.maxWorkspacesPerUser,
      },
      (code, message, status) => {
        throw transferError(code, message, status)
      },
    )
    const targetId = newId()
    await lockTransferWorkspaces(tx, [personal.id, targetId], { sellerData: false })
    await assertNoActiveTransfer(tx, [personal.id])
    await tx
      .insert(organization)
      .values({ id: targetId, name, slug: input.slug, isPersonal: false })
    await tx
      .insert(member)
      .values({ id: newId(), organizationId: targetId, userId: input.userId, role: 'owner' })
    await assertTransferAccess(
      tx,
      {
        kind: 'upgrade',
        userId: input.userId,
        sourceWorkspaceId: personal.id,
        targetWorkspaceId: targetId,
      },
      config,
      { revoked: false },
    )
    const [transfer] = await tx
      .insert(workspaceTransfer)
      .values({
        kind: 'upgrade',
        sourceWorkspaceId: personal.id,
        targetWorkspaceId: targetId,
        requestedBy: input.userId,
        idempotencyKey: key,
        selection: input.sessionId ? { sessionId: input.sessionId } : {},
      })
      .returning()
    if (!transfer) throw new Error('workspace_transfer insert returned no row')
    await hooks.onCreated?.(tx, transfer)
    return toResult(transfer, true)
  })
}

export interface StartMoveInput {
  readonly userId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  /** 根条目与冲突选项（TransferSelection），入库前校验 */
  readonly selection: unknown
  readonly idempotencyKey: string
}

const ROOT_TABLES = {
  direction: 'direction',
  store: 'tracked_store',
  trackedProduct: 'tracked_product',
  categoryStudy: 'category_study',
  costingScenario: 'costing_scenario',
  decision: 'decision',
} as const

/** 选择性移动（D1、D2）：根条目须属于源空间；权限按 D6（移出团队数据需 owner） */
export async function startMove(
  db: Database,
  input: StartMoveInput,
  config: TransferConfig,
  hooks: StartHooks = {},
): Promise<StartResult> {
  assertEnabled(config)
  const key = idempotencyKey(input.idempotencyKey)
  if (!isUuid(input.sourceWorkspaceId) || !isUuid(input.targetWorkspaceId)) invalid('空间 id 无效')
  const selection = parseSelection(input.selection)
  return db.transaction(async (tx) => {
    await xactLock(tx, `owner:${input.userId}`)
    const found = await existing(tx, input.userId, key, 'move')
    if (found) return toResult(found, false)
    const ids = [input.sourceWorkspaceId, input.targetWorkspaceId]
    await lockTransferWorkspaces(tx, ids, { sellerData: false })
    await assertTransferAccess(tx, { kind: 'move', ...input }, config, { revoked: false })
    await assertNoActiveTransfer(tx, ids)
    let found_ = 0
    for (const [root, table] of Object.entries(ROOT_TABLES)) {
      const list = selection.roots?.[root as keyof typeof ROOT_TABLES]
      if (!list?.length) continue
      const meta = tableMeta(table)
      const [row] = await rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from ${sql.raw(`"${meta.name}"`)}
          where ${sql.raw(`"${meta.ws}"`)} = ${input.sourceWorkspaceId}
            and id = any(${uuidList(list)})`,
      )
      found_ += row?.n ?? 0
    }
    if (found_ === 0 && !selection.roots?.configPack)
      throw transferError('TRANSFER_EMPTY_SELECTION', '所选条目不在源空间中', 400)
    const [transfer] = await tx
      .insert(workspaceTransfer)
      .values({
        kind: 'move',
        sourceWorkspaceId: input.sourceWorkspaceId,
        targetWorkspaceId: input.targetWorkspaceId,
        requestedBy: input.userId,
        idempotencyKey: key,
        selection: selection as Record<string, unknown>,
      })
      .returning()
    if (!transfer) throw new Error('workspace_transfer insert returned no row')
    await hooks.onCreated?.(tx, transfer)
    return toResult(transfer, true)
  })
}
