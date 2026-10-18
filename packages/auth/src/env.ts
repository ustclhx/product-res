import { loadEnv, type TemplateConfig } from '@product-res/config'
import { z } from 'zod'

/** `createAuth` 读取的环境变量（docs/07-infrastructure.md §4）。 */
export interface AuthEnv {
  readonly BETTER_AUTH_SECRET?: string | undefined
  readonly APP_URL?: string | undefined
  /** 已验证邮箱的首次管理员名单；逗号分隔，空值禁用 */
  readonly BOOTSTRAP_ADMIN_EMAILS?: string | undefined
  /** 注册白名单；逗号分隔，空值不限制 */
  readonly SIGNUP_ALLOWED_EMAILS?: string | undefined
  readonly GOOGLE_CLIENT_ID?: string | undefined
  readonly GOOGLE_CLIENT_SECRET?: string | undefined
  readonly GITHUB_CLIENT_ID?: string | undefined
  readonly GITHUB_CLIENT_SECRET?: string | undefined
  /** `auth.turnstile=true` 时必填 */
  readonly TURNSTILE_SECRET_KEY?: string | undefined
}

const secret = z.string().min(1)

/**
 * 按模板配置校验认证所需的变量：只有启用的 OAuth 提供方要求对应的 client id / secret，
 * 启用 Turnstile 时要求 `TURNSTILE_SECRET_KEY`。平台能力由调用方通过 CreateAuthDeps 注入，不进入标量 env。
 * 失败时抛出 `EnvValidationError`（只含变量名，不含取值）。
 */
export function parseAuthEnv(env: AuthEnv, config: TemplateConfig) {
  const oauth = new Set(config.auth.oauth)
  const optional = secret.optional()
  const schema = z.object({
    // Better Auth 要求至少 32 个字符
    BETTER_AUTH_SECRET: z.string().min(32),
    APP_URL: z.url(),
    BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
    SIGNUP_ALLOWED_EMAILS: z.string().optional(),
    GOOGLE_CLIENT_ID: oauth.has('google') ? secret : optional,
    GOOGLE_CLIENT_SECRET: oauth.has('google') ? secret : optional,
    GITHUB_CLIENT_ID: oauth.has('github') ? secret : optional,
    GITHUB_CLIENT_SECRET: oauth.has('github') ? secret : optional,
    TURNSTILE_SECRET_KEY: config.auth.turnstile ? secret : optional,
  })
  return loadEnv(env, schema)
}
