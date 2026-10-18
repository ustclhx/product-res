import type { RateLimiter } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

/**
 * 认证入口防刷（specs/user-auth「认证入口防刷」，docs/04-auth-and-tenancy.md §1）：
 * 注册、登录、发送验证码 / 魔法链接、找回密码在执行前依次检查
 * 1. RL_AUTH 按 IP 限流；2. Turnstile 令牌（启用时）；3. RL_AUTH 按邮箱限流。
 * 任一不通过即返回错误，接口本身不执行，因此不会创建用户或发送邮件。
 * 只拦截经 `auth.handler` 进入的 HTTP 请求；服务端直接调用 `auth.api.*` 视为可信调用。
 *
 * Rate Limiting 绑定按 Cloudflare 数据中心分别计数、最终一致，只用于防刷和削峰，不是精确配额。
 */

/** 受保护的接口路径（Better Auth 端点路径，不含 basePath） */
export const PROTECTED_AUTH_PATHS = [
  // 注册
  '/sign-up/email',
  // 登录（魔法链接的发送接口也是登录入口）
  '/sign-in/email',
  '/sign-in/email-otp',
  '/sign-in/magic-link',
  // 发送验证码
  '/email-otp/send-verification-otp',
  // 找回密码
  '/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/request-password-reset',
  // 主动发起邮箱验证（账号设置、领取注册赠送积分，email-verification.ts）：同样发邮件，一并限流；
  // 带有效签名会话 Cookie 的请求（已登录用户）不要求 Turnstile
  '/send-verification-email',
] as const

/** 已登录用户调用时免 Turnstile 的接口 */
const TURNSTILE_OPTIONAL_WITH_SESSION = new Set<string>(['/send-verification-email'])

export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token'
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export interface AuthProtectionOptions {
  /** 认证限流；未提供时仅用于无能力的单元测试。 */
  readonly rateLimiter?: RateLimiter | undefined
  /** Turnstile secret；`null` 表示模板配置关闭了 Turnstile */
  readonly turnstileSecret: string | null
  /** 可信运行时入口解析的本请求 IP；业务不读取转发头。 */
  readonly clientIp?: string | null | undefined
}

const encoder = new TextEncoder()

/** 限流键中的邮箱用 SHA-256 摘要，不把明文邮箱交给限流服务 */
async function emailKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(email.trim().toLowerCase()))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function tooManyRequests(): never {
  throw APIError.from('TOO_MANY_REQUESTS', {
    code: 'RATE_LIMITED',
    message: 'Too many requests, please try again later',
  })
}

/** 调用 Turnstile siteverify；网络错误或非 2xx 视为校验失败（fail closed）。 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
): Promise<boolean> {
  const body = new FormData()
  body.set('secret', secret)
  body.set('response', token)
  if (remoteIp) body.set('remoteip', remoteIp)
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, { method: 'POST', body })
    if (!res.ok) return false
    const result = (await res.json()) as { success?: unknown }
    return result.success === true
  } catch {
    return false
  }
}

export function authProtection(options: AuthProtectionOptions) {
  const paths = new Set<string>(PROTECTED_AUTH_PATHS)
  const { rateLimiter, turnstileSecret } = options
  const ip = options.clientIp ?? 'unknown'
  async function allow(key: string): Promise<boolean> {
    if (!rateLimiter) return true
    try {
      return (await rateLimiter.limit('auth', key)).success
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 503) throw error
      throw APIError.from('SERVICE_UNAVAILABLE', { code: error.code, message: error.message })
    }
  }
  return {
    id: 'auth-protection',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.request !== undefined && paths.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.request?.headers ?? new Headers()

            if (!(await allow(`auth:ip:${ip}`))) {
              tooManyRequests()
            }

            const signedIn =
              TURNSTILE_OPTIONAL_WITH_SESSION.has(ctx.path ?? '') &&
              Boolean(
                await ctx.getSignedCookie(
                  ctx.context.authCookies.sessionToken.name,
                  ctx.context.secret,
                ),
              )
            if (turnstileSecret !== null && !signedIn) {
              const token = headers.get(TURNSTILE_TOKEN_HEADER)
              const passed =
                token !== null &&
                token !== '' &&
                (await verifyTurnstile(turnstileSecret, token, ip === 'unknown' ? null : ip))
              if (!passed) {
                throw APIError.from('FORBIDDEN', {
                  code: 'TURNSTILE_FAILED',
                  message: 'Human verification failed',
                })
              }
            }

            const email = (ctx.body as { email?: unknown } | undefined)?.email
            if (
              rateLimiter &&
              typeof email === 'string' &&
              email !== '' &&
              !(await allow(`auth:email:${await emailKey(email)}`))
            ) {
              tooManyRequests()
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
