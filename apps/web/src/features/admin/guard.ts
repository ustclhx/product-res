import { type AuthContextSource, type FreshSession, requireFreshSession } from '@product-res/auth'
import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'

/**
 * `/admin` 的角色守卫（tasks.md 5.1，specs/user-auth「平台角色」）：
 * 先用 `requireFreshSession` 按数据库校验会话与封禁（`/admin` 属于敏感操作，不走缓存），
 * 再要求平台角色为 `admin`。未登录、会话失效、被封禁、非 admin 一律得到同一个 404，
 * 不暴露后台是否存在。
 */

export const ADMIN_NOT_FOUND = 'NOT_FOUND'

/** admin 插件允许以逗号分隔多个角色（`adminRoles` 默认 `['admin']`），这里与插件的判断一致 */
export function isPlatformAdmin(role: string | null | undefined): boolean {
  return (role ?? '').split(',').some((r) => r.trim() === 'admin')
}

const notFound = () => new AppError(ADMIN_NOT_FOUND, 'Not Found', { status: 404 })

export async function requireAdmin(options: {
  readonly auth: AuthContextSource
  readonly db: Database
  readonly headers: Headers
}): Promise<FreshSession> {
  let fresh: FreshSession
  try {
    fresh = await requireFreshSession(options)
  } catch (error) {
    if (error instanceof AppError) throw notFound()
    throw error
  }
  if (fresh.session.impersonatedBy || !isPlatformAdmin(fresh.user.role)) throw notFound()
  return fresh
}

export function isAdminNotFound(error: unknown): boolean {
  return error instanceof AppError && error.code === ADMIN_NOT_FOUND
}
