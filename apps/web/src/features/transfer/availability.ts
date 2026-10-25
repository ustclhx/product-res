/**
 * 列表页“复制到空间… / 移动到空间…”的显示条件（design D6、D11，tasks 6.2）。
 * 只用于界面隐藏不可用操作；发起与预览时引擎按数据库当前成员关系再校验。
 */
export interface TransferAvailability {
  readonly copy: boolean
  readonly move: boolean
}

export const NO_TRANSFER: TransferAvailability = { copy: false, move: false }

export function transferAvailability(
  context: {
    readonly user: { readonly id: string }
    readonly workspace: { readonly id: string; readonly isPersonal: boolean }
    readonly member: { readonly role: string }
    /** 含 multiTenant=false 的团队只读与流转锁 */
    readonly workspaceReadOnly: boolean
  },
  config: { readonly tenancy: { readonly multiTenant: boolean; readonly dataTransfer: boolean } },
): TransferAvailability {
  // multiTenant=false 时开关强制关闭（design Migration Plan）
  if (!config.tenancy.dataTransfer || !config.tenancy.multiTenant) return NO_TRANSFER
  if (context.workspaceReadOnly) return NO_TRANSFER
  const { workspace, member, user } = context
  if (workspace.isPersonal) {
    const own = workspace.id === user.id && member.role === 'owner'
    return { copy: own, move: own }
  }
  // 团队空间：复制需 owner / admin；移出会删除团队数据，需 owner
  return {
    copy: member.role === 'owner' || member.role === 'admin',
    move: member.role === 'owner',
  }
}
