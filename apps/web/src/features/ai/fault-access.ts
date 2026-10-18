import type { FaultAccessContext } from '@product-res/ai'
import { type AuthContextSource, type FreshSession, requireFreshSession } from '@product-res/auth'
import { type AiFaultInjectionEnv, isAiFaultInjectionEnabled } from '@product-res/config'
import type { Database } from '@product-res/db'
import { isPlatformAdmin } from '../admin/guard.ts'

/** 权限来自实时会话；空间角色与 API key 都不能授予故障访问。 */
export function sessionFaultAccess(
  fresh: FreshSession,
  env: AiFaultInjectionEnv,
): FaultAccessContext {
  return {
    enabled: isAiFaultInjectionEnabled(env),
    platformAdmin: !fresh.session.impersonatedBy && isPlatformAdmin(fresh.user.role),
  }
}

export async function readFaultAccess(options: {
  auth: AuthContextSource
  db: Database
  headers: Headers
  env: AiFaultInjectionEnv
}): Promise<FaultAccessContext> {
  if (!isAiFaultInjectionEnabled(options.env)) return { enabled: false, platformAdmin: false }
  return sessionFaultAccess(await requireFreshSession(options), options.env)
}
