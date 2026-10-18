import { AppError } from '@product-res/shared'

/**
 * 工作台配置类写操作（选品方向、店铺池、节点、品牌库、风险规则）的权限：
 * 与数据中心一致，要求空间可写且当前成员是 owner / admin；member 只读。
 */
export function assertWorkbenchWriter(context: {
  workspaceReadOnly: boolean
  member: { role: string }
}) {
  if (context.workspaceReadOnly)
    throw new AppError('WORKSPACE_READ_ONLY', '当前空间为只读，不能修改', { status: 403 })
  if (context.member.role !== 'owner' && context.member.role !== 'admin')
    throw new AppError('FORBIDDEN', '只有空间所有者和管理员可以修改', { status: 403 })
}

/** 当前成员能否修改（用于界面隐藏写操作；服务端仍以 assertWorkbenchWriter 为准） */
export function canWriteWorkbench(context: {
  workspaceReadOnly: boolean
  member: { role: string }
}): boolean {
  return (
    !context.workspaceReadOnly &&
    (context.member.role === 'owner' || context.member.role === 'admin')
  )
}
