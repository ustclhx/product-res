import type { Database, Session, User } from '@product-res/db'
import { AppError } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

/**
 * 敏感操作的实时会话校验（design.md 决策 3，specs/user-auth「敏感操作实时校验会话」）：
 * 只从签名 Cookie 中取会话 token（校验签名），会话与用户一律直接查库，不读 Cookie 缓存与 KV。
 * 被吊销的会话（数据库行已删除或已过期）与被封禁的用户立即被拒绝，不受缓存时长影响。
 */

export interface FreshSession {
  readonly session: Session
  readonly user: User
}

export const SESSION_REQUIRED = 'SESSION_REQUIRED'
export const USER_BANNED = 'USER_BANNED'

/** 封禁是否仍生效：`banExpires` 为空表示永久封禁（与 admin 插件一致） */
function isBanned(user: User, now: Date): boolean {
  return user.banned === true && (user.banExpires === null || user.banExpires > now)
}

type FreshCheck =
  | { readonly ok: true; readonly value: FreshSession }
  | { readonly ok: false; readonly code: typeof SESSION_REQUIRED | typeof USER_BANNED }

/** 按会话 token 直接查库，校验会话未过期、用户未被封禁。 */
export async function checkSessionInDatabase(db: Database, token: string): Promise<FreshCheck> {
  const row = await db.query.session.findFirst({
    where: (s, { eq }) => eq(s.token, token),
    with: { user: true },
  })
  const now = new Date()
  if (!row || row.expiresAt <= now) return { ok: false, code: SESSION_REQUIRED }
  const { user, ...session } = row
  if (isBanned(user, now)) return { ok: false, code: USER_BANNED }
  return { ok: true, value: { session, user } }
}

/** Better Auth 签名 Cookie 的格式：`<value>.<base64 HMAC-SHA256(secret, value)>`（better-call） */
async function verifySignedCookie(raw: string, secret: string): Promise<string | null> {
  const value = decodeURIComponent(raw)
  const dot = value.lastIndexOf('.')
  if (dot < 1) return null
  const token = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  if (signature.length !== 44 || !signature.endsWith('=')) return null
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return (await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(token))) ? token : null
}

function readCookie(headers: Headers, name: string): string | null {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** `requireFreshSession` 需要的 auth 实例部分（`createAuth` 的返回值满足） */
export interface AuthContextSource {
  readonly $context: Promise<{
    readonly secret: string
    readonly authCookies: { readonly sessionToken: { readonly name: string } }
  }>
}

/**
 * 守卫：请求必须带有效会话，且会话与用户状态以数据库为准。
 * 未登录或会话已失效抛 401 `SESSION_REQUIRED`，用户被封禁抛 403 `USER_BANNED`。
 * 适用范围以 specs/user-auth 的列表为准：修改密码 / 邮箱 / 2FA、删除账号、计费操作、
 * 成员与角色管理、创建 API Key、`/admin` 下的所有请求。
 */
export async function requireFreshSession(options: {
  readonly auth: AuthContextSource
  readonly db: Database
  readonly headers: Headers
}): Promise<FreshSession> {
  const context = await options.auth.$context
  const raw = readCookie(options.headers, context.authCookies.sessionToken.name)
  const token = raw && (await verifySignedCookie(raw, context.secret))
  if (!token) throw new AppError(SESSION_REQUIRED, 'Sign in required', { status: 401 })
  const result = await checkSessionInDatabase(options.db, token)
  if (result.ok) return result.value
  if (result.code === USER_BANNED) {
    throw new AppError(USER_BANNED, 'Account suspended', { status: 403 })
  }
  throw new AppError(SESSION_REQUIRED, 'Sign in required', { status: 401 })
}

/**
 * Better Auth 自带的敏感接口：执行前按数据库校验会话与封禁状态。
 * Better Auth 的 `sensitiveSessionMiddleware` 只绕过 Cookie 缓存，仍会读 KV，
 * 在 KV 删除尚未传播到所有节点时会放行已吊销的会话。
 */
const SENSITIVE_PATHS = [
  '/change-password',
  '/change-email',
  '/set-password',
  '/delete-user',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
]
const SENSITIVE_PREFIXES = ['/two-factor/', '/admin/', '/api-key/create']
/** 成员与角色管理（organization 插件）；只读接口不在此列 */
const SENSITIVE_ORGANIZATION = [
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/accept-invitation',
  '/organization/remove-member',
  '/organization/update-member-role',
  '/organization/update',
  '/organization/leave',
  '/organization/add-member',
  '/organization/delete',
]

export function isSensitivePath(path: string): boolean {
  return (
    SENSITIVE_PATHS.includes(path) ||
    SENSITIVE_ORGANIZATION.includes(path) ||
    SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

/** 把实时校验接到 Better Auth 的敏感接口上（只拦截带会话 Cookie 的 HTTP 请求，其余交给接口自身处理）。 */
export function freshSessionGuard(db: Database) {
  return {
    id: 'fresh-session-guard',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.request !== undefined && isSensitivePath(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            )
            // 没有会话 Cookie 时由接口自己返回 401
            if (!token) return
            const result = await checkSessionInDatabase(db, token)
            if (result.ok) return
            if (result.code === USER_BANNED) {
              throw APIError.from('FORBIDDEN', { code: USER_BANNED, message: 'Account suspended' })
            }
            throw APIError.from('UNAUTHORIZED', {
              code: SESSION_REQUIRED,
              message: 'Sign in required',
            })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
