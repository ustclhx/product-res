import type { TemplateConfig } from '@product-res/config'
import { hasAdminGrant } from '@product-res/credits'
import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { isPlatformAdmin } from '../features/admin/guard.ts'
import { templateConfig } from './template-config.ts'

export const ACCOUNT_NOT_ACTIVATED = 'ACCOUNT_NOT_ACTIVATED'

/**
 * 内测准入（openspec/changes/add-beta-access-gate D2）：开启 `credits.requireGrantForAccess` 时，
 * 空间需有管理员发放的积分批次才能使用工作台；平台 admin 始终放行，避免运维把自己锁在外面。
 */
export async function isAccountActivated(
  db: Database,
  user: { readonly role?: string | null | undefined },
  workspaceId: string,
  config: Pick<TemplateConfig, 'credits'> = templateConfig,
): Promise<boolean> {
  if (!config.credits.enabled || !config.credits.requireGrantForAccess) return true
  if (isPlatformAdmin(user.role)) return true
  return hasAdminGrant(db, workspaceId)
}

export async function assertAccountActivated(
  db: Database,
  user: { readonly role?: string | null | undefined },
  workspaceId: string,
  config: Pick<TemplateConfig, 'credits'> = templateConfig,
): Promise<void> {
  if (!(await isAccountActivated(db, user, workspaceId, config)))
    throw new AppError(ACCOUNT_NOT_ACTIVATED, 'Account is pending administrator activation', {
      status: 403,
    })
}
