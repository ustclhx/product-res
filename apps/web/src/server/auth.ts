import { type AuthEnv, type CreateAuthDeps, createAuth } from '@product-res/auth'
import { grantSignupBonus } from '@product-res/billing'
import type { Database } from '@product-res/db'
import { templateConfig } from './template-config.ts'
import { resolveWorkspaceMaxSeats } from './workspace-data.ts'

/** 中立认证工厂；发信、注册准入与删除外部能力由 composition root 注入。 */
export function createWebAuth(config: AuthEnv, db: Database, deps: Omit<CreateAuthDeps, 'config'>) {
  return createAuth(config, db, {
    ...deps,
    config: templateConfig,
    resolveMaxSeats: deps.resolveMaxSeats ?? resolveWorkspaceMaxSeats,
    onEmailVerified:
      deps.onEmailVerified ??
      (async (user) => {
        if (templateConfig.credits.enabled)
          return grantSignupBonus({ db, userId: user.id, config: templateConfig.billing })
      }),
  })
}
