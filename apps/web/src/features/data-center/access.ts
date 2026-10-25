import { AppError } from '@product-res/shared'
import { assertWorkbenchNotReadOnly } from '../workbench/access.ts'

interface AccessContext {
  workspaceReadOnly: boolean
  workspaceTransferring?: boolean | undefined
  member: { role: string }
}

/** 只读空间不可写 */
export function assertNotReadOnly(context: AccessContext) {
  assertWorkbenchNotReadOnly(context)
}

/** 修改数据源配置、触发同步、导入与提交抽检要求可写空间中的 owner / admin */
export function assertWriter(context: AccessContext) {
  assertNotReadOnly(context)
  if (context.member.role !== 'owner' && context.member.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only owners and admins can change data sources', {
      status: 403,
    })
}
