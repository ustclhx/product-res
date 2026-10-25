import {
  type CreateInviteLinkInput,
  createInviteLink,
  type FreshSession,
  type InviteLinkActor,
  type InviteLinkDeps,
  type InviteLinkPreview,
  joinWithInviteLink,
  listInviteLinks,
  previewInviteLink,
  requireFreshSession,
  revokeInviteLink,
} from '@product-res/auth'
import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { getRequest } from '@tanstack/react-start/server'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { resolveWorkspaceMaxSeats } from '../../server/workspace-data.ts'
import { assertRealSession } from '../admin/impersonation.ts'

/**
 * 邀请链接的 web 适配（add-team-invite-links D3–D7）：会话、限流与错误码；业务规则在 @product-res/auth。
 * 预期内的失败以 `{ error: code }` 返回，页面按错误码显示文案，不当作服务端异常上报。
 * token 只在请求体中传递，不写日志。
 */

export type InviteLinkFailure = { readonly error: string }

function deps(db: Database): InviteLinkDeps {
  return { db, config: templateConfig, resolveMaxSeats: resolveWorkspaceMaxSeats }
}

async function freshSession(db: Database): Promise<FreshSession> {
  return requireFreshSession({ auth: getWebRuntime().auth, db, headers: getRequest().headers })
}

function actorOf(fresh: FreshSession): InviteLinkActor {
  return {
    userId: fresh.user.id,
    sessionId: fresh.session.id,
    clientIp: getWebRuntime().requestMeta.clientIp,
  }
}

/** 生成、作废、加入要求真实登录（模拟登录不可用） */
async function realActor(db: Database) {
  const fresh = await freshSession(db)
  assertRealSession(fresh.session)
  return actorOf(fresh)
}

async function expected<T>(run: () => Promise<T>): Promise<T | InviteLinkFailure> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return { error: error.code }
    throw error
  }
}

/** 预览与加入按 IP 与用户共用 RL_AUTH（每分钟 10 次） */
async function rateLimited(userId: string | null): Promise<boolean> {
  const { rateLimiter, requestMeta } = getWebRuntime()
  const keys = [`invite-link:ip:${requestMeta.clientIp ?? 'unknown'}`]
  if (userId) keys.push(`invite-link:user:${userId}`)
  for (const key of keys) if (!(await rateLimiter.limit('auth', key)).success) return true
  return false
}

export async function inviteLinksFor(
  db: Database,
  workspace: { id: string; isPersonal: boolean },
  member: { userId: string; role: string },
  workspaceReadOnly: boolean,
) {
  if (workspace.isPersonal || workspaceReadOnly) return null
  if (member.role !== 'owner' && member.role !== 'admin') return null
  return listInviteLinks(deps(db), member.userId, workspace.id)
}

export async function createLink(
  db: Database,
  workspaceId: string,
  input: Omit<CreateInviteLinkInput, 'workspaceId'>,
) {
  return expected(async () =>
    createInviteLink(deps(db), await realActor(db), { ...input, workspaceId }),
  )
}

export async function revokeLink(db: Database, workspaceId: string, linkId: string) {
  return expected(async () => ({
    link: await revokeInviteLink(deps(db), await realActor(db), { workspaceId, linkId }),
  }))
}

export type JoinPreview = InviteLinkPreview | { readonly status: 'signed_out' | 'rate_limited' }

/** 未登录时不查询链接，不泄露空间名 */
export async function previewJoin(token: string): Promise<JoinPreview> {
  const { db } = getWebRuntime()
  let fresh: FreshSession
  try {
    fresh = await freshSession(db)
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403))
      return { status: 'signed_out' }
    throw error
  }
  if (await rateLimited(fresh.user.id)) return { status: 'rate_limited' }
  return previewInviteLink(deps(db), fresh.user.id, token)
}

export async function joinLink(token: string) {
  const { db } = getWebRuntime()
  return expected(async () => {
    const actor = await realActor(db)
    if (await rateLimited(actor.userId))
      throw new AppError('RATE_LIMITED', 'Try again later', { status: 429 })
    return joinWithInviteLink(deps(db), actor, token)
  })
}
