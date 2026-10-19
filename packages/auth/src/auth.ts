import { apiKey } from '@better-auth/api-key'
import type { TemplateConfig } from '@product-res/config'
import type { Database } from '@product-res/db'
import * as schema from '@product-res/db/schema'
import type { KeyValueStore, RateLimiter } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { admin, emailOTP, magicLink, organization, twoFactor } from 'better-auth/plugins'
import { accountSettings, userSettingsFields } from './account-settings.ts'
import { adminBootstrap } from './admin-bootstrap.ts'
import { type DeletionStep, deletionPlugin } from './deletion.ts'
import type { SendAuthEmail } from './email.ts'
import { emailVerificationOptions } from './email-verification.ts'
import { type AuthEnv, parseAuthEnv } from './env.ts'
import { freshSessionGuard } from './fresh-session.ts'
import { passwordHasher } from './password.ts'
import { personalWorkspaceHooks } from './personal-workspace.ts'
import { authProtection } from './protection.ts'
import { sessionStorageOptions } from './session.ts'
import { signupAllowlist } from './signup-allowlist.ts'
import { type ResolveMaxSeats, teamWorkspaces } from './team-workspaces.ts'
import { verificationReservation } from './verification-reservation.ts'
import { workspaceLifecyclePlugin } from './workspace-lifecycle.ts'

// Better Auth 只支持从头解析 IP；入口包装会强制覆盖，客户端不能选择此值。
const CLIENT_IP_HEADER = 'x-product-res-auth-client-ip'

export interface CreateAuthDeps {
  readonly cache?: KeyValueStore | undefined
  readonly rateLimiter?: RateLimiter | undefined
  /** 可信运行时入口解析的本请求 IP。 */
  readonly clientIp?: string | null | undefined
  readonly beforeUserCreate?: (user: { readonly email: string }, headers?: Headers) => Promise<void>
  readonly deletionSteps?: readonly DeletionStep[]
  /** 模板配置（`template.config.ts`），决定启用哪些登录方式与插件 */
  readonly config: TemplateConfig
  /** 认证邮件的发送点；由调用方注入（后续接 EMAIL_QUEUE），测试中用假实现 */
  readonly sendEmail: SendAuthEmail
  readonly resolveMaxSeats?: ResolveMaxSeats
  /** Runs after verification is persisted, or after an already-verified registration's personal workspace.
   * Errors propagate; the caller must provide an idempotent callback and a claim endpoint for retries.
   */
  readonly onEmailVerified?: (user: {
    readonly id: string
    readonly email: string
  }) => Promise<unknown>
}

/**
 * 按请求创建 Better Auth 实例（design.md 决策 1）：每个请求传入该请求的 env 与 `createDb()` 实例，
 * 不要缓存到模块作用域。
 *
 * 登录方式按 `config.auth` 开关（specs/user-auth「可配置的登录方式」）：
 * - 邮箱密码关闭时注册 / 登录 / 找回密码接口返回错误；
 * - `emailOTP`、`magicLink`、`twoFactor` 关闭时不注册对应插件，其接口不存在（404）；
 * - 未启用的 OAuth 提供方不注册，以它发起登录会返回错误。
 * 数据库 schema 始终包含全部插件的表与字段（packages/db/src/schema/auth.ts），开关只影响接口。
 */
export function createAuth(env: AuthEnv, db: Database, deps: CreateAuthDeps) {
  const { config, sendEmail } = deps
  const vars = parseAuthEnv(env, config)
  const workspaceHooks = personalWorkspaceHooks(db)
  const bootstrapAdmin = adminBootstrap(db, vars.BOOTSTRAP_ADMIN_EMAILS, {
    allowUnverified: vars.BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED === 'true',
  })
  const assertSignupAllowed = signupAllowlist(vars.SIGNUP_ALLOWED_EMAILS)

  const auth = betterAuth({
    appName: config.app.name,
    baseURL: vars.APP_URL,
    basePath: '/api/auth',
    // 空间绑定与角色校验只经应用管理入口；原生 HTTP 接口不能绕过。
    disabledPaths: [
      '/api-key/create',
      '/api-key/update',
      '/api-key/delete',
      '/api-key/get',
      '/api-key/list',
    ],
    secret: vars.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // 会话三层：Cookie 缓存 → KV → 数据库（session.ts）
    ...sessionStorageOptions(deps.cache),
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // 主键统一为 UUIDv7（design.md 决策 2），列类型为 uuid
      database: { generateId: () => newId() },
    },
    // 注册即创建个人空间，新会话默认以个人空间为活跃空间（personal-workspace.ts）
    databaseHooks: {
      ...workspaceHooks,
      user: {
        create: {
          before: async (
            user: { email: string },
            context: { headers?: Headers | undefined; request?: Request | undefined } | null,
          ) => {
            // 白名单先于注入回调，名单外邮箱不触发任何副作用
            assertSignupAllowed(user.email)
            await deps.beforeUserCreate?.(user, context?.request?.headers ?? context?.headers)
          },
          after: async (user) => {
            await workspaceHooks.user.create.after(user)
            await bootstrapAdmin(user.id, 'user.create')
            // Better Auth defers create.after until registration commits. Keep the
            // injected callback outside the workspace hook's best-effort catch.
            if (user.emailVerified && deps.onEmailVerified) {
              const personal = await db.query.organization.findFirst({
                where: (o, { and, eq, isNull }) =>
                  and(eq(o.id, user.id), eq(o.isPersonal, true), isNull(o.deletedAt)),
              })
              if (personal) await deps.onEmailVerified({ id: user.id, email: user.email })
            }
          },
        },
        update: {
          // OTP 与 magic link 直接持久化验证标记，不经过 afterEmailVerification。
          after: async (user) => {
            if (user.emailVerified) await bootstrapAdmin(user.id, 'user.update')
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const workspace = await workspaceHooks.session.create.before(session)
            // 可信 auth.api 调用也不让传入 headers 决定会话 IP。
            return { data: { ...session, ...workspace?.data, ipAddress: deps.clientIp ?? null } }
          },
          after: async (session) => {
            await bootstrapAdmin(session.userId, 'session.create')
          },
        },
      },
    },
    user: {
      deleteUser: { enabled: false },
      // 用户设置中的语言与时区（tasks.md 5.2），取值由校验器限定
      additionalFields: userSettingsFields(config),
    },
    emailAndPassword: {
      enabled: config.auth.emailPassword,
      requireEmailVerification: config.auth.requireEmailVerification,
      password: passwordHasher,
      // 经找回密码重置后与修改密码一样吊销全部会话（specs/user-auth「普通页面的吊销延迟」）
      revokeSessionsOnPasswordReset: true,
      // 不提供 sendResetPassword 时找回密码接口返回错误；关闭邮箱密码时找回密码一并关闭
      ...(config.auth.emailPassword && {
        sendResetPassword: async ({ user, url }) => {
          await sendEmail({ type: 'reset-password', to: user.email, url })
        },
      }),
    },
    emailVerification: {
      ...emailVerificationOptions(config, sendEmail),
      // Installed Better Auth names the post-update hook afterEmailVerification.
      // Verification remains committed if this callback fails: retry via the
      // authenticated claim entry, since replaying a verified link skips this hook.
      afterEmailVerification: async (user) => {
        await bootstrapAdmin(user.id, 'email.verify')
        await deps.onEmailVerified?.({ id: user.id, email: user.email })
      },
    },
    socialProviders: socialProviders(config, vars),
    plugins: [
      // 认证入口防刷：RL_AUTH 限流 + Turnstile（protection.ts）
      authProtection({
        rateLimiter: deps.rateLimiter,
        clientIp: deps.clientIp,
        turnstileSecret: config.auth.turnstile ? (vars.TURNSTILE_SECRET_KEY ?? null) : null,
      }),
      // 敏感接口按数据库实时校验会话与封禁（fresh-session.ts）
      freshSessionGuard(db),
      deletionPlugin(db, deps.cache, config.tenancy.multiTenant, deps.deletionSteps, deps.clientIp),
      verificationReservation(db),
      workspaceLifecyclePlugin(db, config.tenancy.maxWorkspacesPerUser, deps.clientIp),
      teamWorkspaces(db, config, sendEmail, deps.resolveMaxSeats, deps.clientIp),
      // 用户设置：资料校验、修改密码时吊销其他会话（account-settings.ts）
      accountSettings(db, config, deps.clientIp),
      organization({
        // 团队空间的创建准入由 multiTenant 决定；个人空间由服务端创建（tasks.md 4.1）
        allowUserToCreateOrganization: config.tenancy.multiTenant,
        // organization 只软删、从不物理删除（docs/03-data-model.md §7）
        disableOrganizationDeletion: true,
        organizationHooks: {
          beforeCreateOrganization: async () => {
            throw APIError.from('FORBIDDEN', {
              code: 'USE_WORKSPACE_CREATION',
              message: 'Use authenticated workspace creation',
            })
          },
          // Native server-only addMember cannot skip workspace admission.
          beforeAddMember: async () => {
            throw APIError.from('FORBIDDEN', {
              code: 'USE_WORKSPACE_INVITATION',
              message: 'Use the workspace invitation flow',
            })
          },
        },
        schema: {
          organization: {
            additionalFields: {
              isPersonal: { type: 'boolean', required: true, defaultValue: false, input: false },
              deletedAt: { type: 'date', required: false, input: false },
            },
          },
        },
        sendInvitationEmail: async ({ email, id, role, organization, inviter }) => {
          await sendEmail({
            type: 'invitation',
            to: email,
            invitationId: id,
            workspaceName: organization.name,
            inviterName: inviter.user.name,
            role,
          })
        },
      }),
      admin(),
      ...(config.auth.emailOtp
        ? [
            emailOTP({
              sendVerificationOTP: async ({ email, otp, type }) => {
                await sendEmail({ type: 'otp', to: email, otp, purpose: type })
              },
            }),
          ]
        : []),
      ...(config.auth.magicLink
        ? [
            magicLink({
              sendMagicLink: async ({ email, url }) => {
                await sendEmail({ type: 'magic-link', to: email, url })
              },
            }),
          ]
        : []),
      ...(config.auth.twoFactor ? [twoFactor({ issuer: config.app.name })] : []),
      // 公开 API 的密钥按用户归属，workspace 记在 metadata 中（docs/03-data-model.md §1）
      ...(config.features.publicApi
        ? [
            apiKey({
              references: 'user',
              enableMetadata: true,
              rateLimit: { enabled: false },
              keyExpiration: { minExpiresIn: 1 / 1440 },
            }),
          ]
        : []),
    ],
  })
  return {
    ...auth,
    handler: (request: Request) => {
      // 在 Better Auth 内置限流之前覆盖内部头；插件 onRequest 执行顺序太晚。
      const headers = new Headers(request.headers)
      headers.delete(CLIENT_IP_HEADER)
      if (deps.clientIp) headers.set(CLIENT_IP_HEADER, deps.clientIp)
      return auth.handler(new Request(request, { headers }))
    },
  }
}

export type Auth = ReturnType<typeof createAuth>

function socialProviders(config: TemplateConfig, vars: ReturnType<typeof parseAuthEnv>) {
  const providers: {
    google?: { clientId: string; clientSecret: string }
    github?: { clientId: string; clientSecret: string }
  } = {}
  for (const provider of config.auth.oauth) {
    if (provider === 'google' && vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET) {
      providers.google = {
        clientId: vars.GOOGLE_CLIENT_ID,
        clientSecret: vars.GOOGLE_CLIENT_SECRET,
      }
    }
    if (provider === 'github' && vars.GITHUB_CLIENT_ID && vars.GITHUB_CLIENT_SECRET) {
      providers.github = {
        clientId: vars.GITHUB_CLIENT_ID,
        clientSecret: vars.GITHUB_CLIENT_SECRET,
      }
    }
  }
  return providers
}
