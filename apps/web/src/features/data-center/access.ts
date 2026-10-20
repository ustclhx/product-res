import { AppError } from '@product-res/shared'

interface AccessContext {
  workspaceReadOnly: boolean
  member: { role: string }
}

/** 只读空间不可写 */
export function assertNotReadOnly(context: AccessContext) {
  if (context.workspaceReadOnly)
    throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
}

/** 修改数据源配置、触发同步、导入与提交抽检要求可写空间中的 owner / admin */
export function assertWriter(context: AccessContext) {
  assertNotReadOnly(context)
  if (context.member.role !== 'owner' && context.member.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only owners and admins can change data sources', {
      status: 403,
    })
}
