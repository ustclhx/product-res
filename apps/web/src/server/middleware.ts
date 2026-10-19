import { type FreshSession, requireFreshSession } from '@product-res/auth'
import type { Database } from '@product-res/db'
import {
  type EntitlementRequirement,
  getEntitlements,
  requireEntitlement,
} from '@product-res/entitlements'
import { AppError } from '@product-res/shared'
import { notFound, redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { assertRealSession } from '../features/admin/impersonation.ts'
import { readRequestSession } from '../features/i18n/session.server.ts'
import { assertAccountActivated } from './account-activation.ts'
import { requireFeature } from './feature-gates.ts'
import { getWebRuntime } from './runtime.ts'
import { templateConfig } from './template-config.ts'
import { resolveDefaultWorkspace, resolveWorkspaceBySlug } from './workspace-context.ts'

/**
 * 服务端入口的中间件链（design.md 决策 6）：`withSession → withWorkspace → withEntitlement → handler`。
 * `withEntitlement` 继承 `withWorkspace`，成员关系仍在每次请求时读取。
 *
 * 用法：在 server function 上 `.middleware([withWorkspace])`，handler 的 `context` 中即有
 * `{ db, user, session, workspace, member }`；`withWorkspace` 已包含 `withSession`。
 */

/** 未登录时跳转的页面（`/login` 由认证页面提供） */
export const LOGIN_PATH = '/login'

/**
 * 读取会话并注入 `{ db, user, session }`；未登录重定向到 `/login`。
 * 应用页面按数据库校验有效会话与封禁，防止删号后的缓存 Cookie 触发个人空间补建。
 * Better Auth 的普通会话接口仍使用 Cookie / KV 缓存；空间成员身份由 `withWorkspace` 查库。
 */
export const withSession = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const { db, auth } = getWebRuntime()
  let result: FreshSession
  try {
    result = await readRequestSession({
      auth,
      db,
      headers: getRequest().headers,
    })
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403))
      throw redirect({ href: LOGIN_PATH })
    throw error
  }
  return next({ context: { db, user: result.user, session: result.session } })
})

/** 计费等敏感操作必须是真实登录；普通页面仍可供模拟排查。 */
export const withRealSession = createMiddleware({ type: 'function' })
  .middleware([withSession])
  .server(async ({ context, next }) => {
    // 敏感入口独立实时校验，不复用语言 / 只读页面缓存。
    const fresh = await requireFreshSession({
      auth: getWebRuntime().auth,
      db: context.db,
      headers: getRequest().headers,
    })
    assertRealSession(fresh.session)
    return next({ context: fresh })
  })

/** server function 的输入来自客户端，按形状校验；是否有权访问由下方查库判断 */
// Preserve action fields until the server function validates its full input.
const workspaceInput = z.looseObject({
  /** URL 中的 `$slug`；省略时解析 `/app` 的默认空间（活跃空间 → 个人空间） */
  slug: z.string().min(1).max(64).optional(),
})

/**
 * 解析当前空间并注入 `{ workspace, member }`（docs/04-auth-and-tenancy.md §3「当前空间的解析」）。
 * 成员身份每次请求查库，不使用会话缓存中的空间信息；空间不存在、已删除或不是成员一律 404，
 * 跨空间访问与访问不存在的空间不可区分。
 */
export const withWorkspaceMembership = createMiddleware({ type: 'function' })
  .middleware([withSession])
  .validator(workspaceInput)
  .server(async ({ next, data, context }) => {
    const { db, user, session } = context
    const resolved =
      data.slug === undefined
        ? await resolveDefaultWorkspace(db, user, session.activeOrganizationId)
        : await resolveWorkspaceBySlug(db, user.id, data.slug)
    if (!resolved) throw notFound()
    return next({
      context: {
        ...resolved,
        workspaceReadOnly: !templateConfig.tenancy.multiTenant && !resolved.workspace.isPersonal,
      },
    })
  })

/**
 * 工作台入口：在成员校验之上要求账号已开通（add-beta-access-gate），未开通返回 403
 * `ACCOUNT_NOT_ACTIVATED`。只有 `/app` 重定向与 `getWorkspacePage`（需要展示待开通页面）
 * 直接使用 `withWorkspaceMembership`。
 */
export const withWorkspace = createMiddleware({ type: 'function' })
  .middleware([withWorkspaceMembership])
  .server(async ({ next, context }) => {
    await assertAccountActivated(context.db, context.user, context.workspace.id)
    return next()
  })

/**
 * `.middleware([withEntitlement({ capability: 'ai.useModel', modelKey: 'pro-model' })])`.
 * Limits accept a requested total, or a callback using validated input and fresh context.
 * Mutations reject read-only team workspaces; read operations opt in with `access: 'read'`.
 */
export function withEntitlement(
  requirement:
    | EntitlementRequirement
    | ((ctx: {
        db: Database
        workspaceId: string
        userId: string
        data: { slug?: string | undefined }
      }) => EntitlementRequirement | Promise<EntitlementRequirement>),
  { access = 'write' }: { access?: 'read' | 'write' } = {},
) {
  return createMiddleware({ type: 'function' })
    .middleware([withWorkspace])
    .server(async ({ context, data, next }) => {
      if (access === 'write' && context.workspaceReadOnly)
        throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', {
          status: 403,
        })
      requireFeature('billing')
      const entitlements = await getEntitlements(context.db, context.workspace.id, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      })
      const required =
        typeof requirement === 'function'
          ? await requirement({
              db: context.db,
              workspaceId: context.workspace.id,
              userId: context.user.id,
              data,
            })
          : requirement
      requireEntitlement(entitlements, required)
      return next({ context: { entitlements } })
    })
}
