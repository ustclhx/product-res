import { type AuthContextSource, type FreshSession, requireFreshSession } from '@product-res/auth'
import { type Database, member, scoped } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { assertAccountActivated } from '../../server/account-activation.ts'
import { templateConfig } from '../../server/template-config.ts'

export const fileWorkspaceInput = z.object({ workspaceId: z.uuid() })
export const uploadInput = fileWorkspaceInput.extend({
  mime: z.string().min(1).max(128),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export const fileInput = fileWorkspaceInput.extend({ fileId: z.uuid() })

export const fileNotFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

/** 下载与 server function 共用实时守卫，隐藏会话失效、成员被移除和空间软删的差异。 */
export async function requireFileWorkspace(options: {
  db: Database
  auth: AuthContextSource
  headers: Headers
  workspaceId: string
}) {
  let fresh: FreshSession
  try {
    fresh = await requireFreshSession(options)
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403))
      throw fileNotFound()
    throw error
  }
  const workspace = await options.db.query.organization.findFirst({
    where: (o, { eq }) => eq(o.id, options.workspaceId),
  })
  if (!workspace || workspace.deletedAt) throw fileNotFound()
  const [membership] = await scoped(options.db, workspace.id)
    .select(member, { where: eq(member.userId, fresh.user.id) })
    .limit(1)
  if (!membership) throw fileNotFound()
  // 文件接口不经 withWorkspace，内测准入在此单独检查（add-beta-access-gate）
  await assertAccountActivated(options.db, fresh.user, workspace.id)
  return {
    ...fresh,
    workspace,
    member: membership,
    workspaceReadOnly: !templateConfig.tenancy.multiTenant && !workspace.isPersonal,
  }
}

export function requireFileWrite(context: { workspaceReadOnly: boolean }) {
  if (context.workspaceReadOnly)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
}
