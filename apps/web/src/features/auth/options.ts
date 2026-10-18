import type { OAuthProvider, TemplateConfig } from '@product-res/config'

/** 认证页面需要的公开配置：启用了哪些登录方式、Turnstile site key。不含任何密钥。 */
export interface AuthUiOptions {
  readonly emailPassword: boolean
  readonly emailOtp: boolean
  readonly magicLink: boolean
  /** 已启用且配置了凭据的 OAuth 提供方（与 @product-res/auth 注册 socialProviders 的条件一致） */
  readonly oauth: readonly OAuthProvider[]
  /** `auth.turnstile=false` 时为 `null`，页面不渲染小组件、请求不带令牌 */
  readonly turnstileSiteKey: string | null
}

export interface AuthUiEnv {
  readonly TURNSTILE_SITE_KEY?: string | undefined
  readonly GOOGLE_CLIENT_ID?: string | undefined
  readonly GOOGLE_CLIENT_SECRET?: string | undefined
  readonly GITHUB_CLIENT_ID?: string | undefined
  readonly GITHUB_CLIENT_SECRET?: string | undefined
}

const OAUTH_CREDENTIALS = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
} as const satisfies Record<OAuthProvider, readonly (keyof AuthUiEnv)[]>

/**
 * 按模板配置决定登录页显示哪些入口（specs/user-auth「可配置的登录方式」：未开启的方式在界面上隐藏）。
 */
export function authUiOptions(config: TemplateConfig, env: AuthUiEnv): AuthUiOptions {
  const { auth } = config
  return {
    emailPassword: auth.emailPassword,
    emailOtp: auth.emailOtp,
    magicLink: auth.magicLink,
    oauth: auth.oauth.filter((provider) =>
      OAUTH_CREDENTIALS[provider].every((key) => Boolean(env[key])),
    ),
    turnstileSiteKey: auth.turnstile ? (env.TURNSTILE_SITE_KEY ?? null) : null,
  }
}
