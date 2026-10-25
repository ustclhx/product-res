import type { WorkspaceTransferKind } from '@product-res/db'
import { sql } from 'drizzle-orm'
import { EBAY_ACCOUNT_DELETION_LOCK } from '../ebay-account-deletion.ts'
import { rows, type TransferConfig, type Tx, transferError, xactLock } from './common.ts'

/**
 * 流转的锁与权限（design D6、D8 与「决定」中的 eBay 账号删除互斥）。
 *
 * 锁顺序：eBay 删除全局锁（共享） → owner: → ws:（两个空间按 uuid 字符串升序）。
 * 与现有协议兼容：团队准入与删除流程按 owner: → ws: 取锁；eBay 账号删除只取通知锁与全局排它锁，
 * 从不取 ws: 锁，因此不会成环。
 */
export async function lockTransferWorkspaces(
  tx: Tx,
  workspaceIds: readonly string[],
  options: { readonly sellerData: boolean },
): Promise<void> {
  if (options.sellerData)
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${EBAY_ACCOUNT_DELETION_LOCK}, 0))`,
    )
  for (const id of [...new Set(workspaceIds)].sort()) await xactLock(tx, `ws:${id}`)
}

interface WorkspaceRow {
  id: string
  is_personal: boolean
  deleted_at: string | null
  role: string | null
}

export interface TransferAccessInput {
  readonly kind: WorkspaceTransferKind
  readonly userId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
}

const forbidden = (message: string, revoked: boolean) =>
  revoked
    ? transferError('TRANSFER_PERMISSION_REVOKED', message, 403)
    : transferError('TRANSFER_FORBIDDEN', message, 403)

/**
 * D6 权限，以数据库当前成员关系为准；发起时（revoked=false）与每个批次开始时（revoked=true）各校验一次。
 * 批次时失败抛 TRANSFER_PERMISSION_REVOKED（不可重试），Workflow 据此转入补偿。
 */
export async function assertTransferAccess(
  tx: Tx,
  input: TransferAccessInput,
  config: TransferConfig,
  options: { readonly revoked: boolean },
): Promise<void> {
  const deny = (message: string): never => {
    throw forbidden(message, options.revoked)
  }
  if (input.sourceWorkspaceId === input.targetWorkspaceId)
    throw transferError('TRANSFER_SAME_WORKSPACE', '源空间与目标空间不能相同', 400)
  const [user] = await rows(
    tx,
    sql`select id from "user" where id=${input.userId}
      and not (coalesce(banned,false) and (ban_expires is null or ban_expires>now()))`,
  )
  if (!user) deny('账号不可用')
  const workspaces = await rows<WorkspaceRow>(
    tx,
    sql`select o.id, o.is_personal, o.deleted_at, m.role from organization o
      left join member m on m.organization_id = o.id and m.user_id = ${input.userId}
      where o.id in (${input.sourceWorkspaceId}, ${input.targetWorkspaceId})`,
  )
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const check = (id: string, side: 'source' | 'target') => {
    const workspace = byId.get(id)
    if (!workspace || workspace.deleted_at)
      throw transferError('WORKSPACE_NOT_FOUND', '空间不存在', options.revoked ? 403 : 404)
    // multiTenant=false 时团队空间只读（workspaceReadOnly）
    if (!workspace.is_personal && !config.tenancy.multiTenant)
      throw transferError('WORKSPACE_READ_ONLY', '团队空间当前只读', 403)
    if (workspace.is_personal) {
      // 个人空间只能由本人作为源或目标；不能流入或读取他人的个人空间
      if (workspace.id !== input.userId || workspace.role !== 'owner')
        deny('不能访问他人的个人空间')
      if (input.kind === 'upgrade' && side === 'target') deny('升级的目标必须是团队空间')
      return
    }
    if (input.kind === 'upgrade' && side === 'source') deny('只能升级自己的个人空间')
    const role = workspace.role
    const allowed =
      side === 'source' && input.kind !== 'copy'
        ? // 移出团队数据会删除团队数据，需 owner；升级的目标由发起人新建，同样是 owner
          role === 'owner'
        : side === 'target' && input.kind === 'upgrade'
          ? role === 'owner'
          : role === 'owner' || role === 'admin'
    if (!allowed)
      deny(
        side === 'source' && input.kind === 'move'
          ? '只有空间所有者可以移出团队数据'
          : '只有空间所有者和管理员可以流转数据',
      )
  }
  check(input.sourceWorkspaceId, 'source')
  check(input.targetWorkspaceId, 'target')
}

/** 两个空间都没有进行中的流转（部分唯一索引是最终保证，这里给出可读的错误） */
export async function assertNoActiveTransfer(
  tx: Tx,
  workspaceIds: readonly string[],
  exceptTransferId?: string,
): Promise<void> {
  const [active] = await rows(
    tx,
    sql`select id from workspace_transfer
      where status in ('pending','running','compensating')
        and (source_workspace_id in (${sql.join(
          workspaceIds.map((id) => sql`${id}`),
          sql`, `,
        )}) or target_workspace_id in (${sql.join(
          workspaceIds.map((id) => sql`${id}`),
          sql`, `,
        )}))
        and id is distinct from ${exceptTransferId ?? null}::uuid
      limit 1`,
  )
  if (active) throw transferError('TRANSFER_IN_PROGRESS', '空间正在进行数据流转', 409)
}
