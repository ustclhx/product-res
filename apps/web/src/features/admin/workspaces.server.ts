import { restoreWorkspace } from '@product-res/auth'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withDelegatedAdminAction } from './action.server.ts'
import type { AdminActionContext } from './action.ts'

/** 恢复 API 自管事务：锁定真实管理员 / 会话、owner 与空间，并同时写恢复审计。 */
export function executeAdminWorkspaceRestore(
  context: AdminActionContext,
  options: { runtime: WebRuntime; headers: Headers; workspaceId: string },
) {
  return withDelegatedAdminAction(context, (db) =>
    restoreWorkspace({
      db,
      auth: options.runtime.createAuth(db),
      clientIp: options.runtime.requestMeta.clientIp,
      headers: options.headers,
      workspaceId: options.workspaceId,
      maxWorkspacesPerUser: templateConfig.tenancy.maxWorkspacesPerUser,
    }),
  )
}
