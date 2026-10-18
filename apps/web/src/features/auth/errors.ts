import { m } from '../../paraglide/messages.js'

/**
 * 认证接口错误码 → 提示文案（按当前请求 / 页面语言显示）。
 * 错误码来自 Better Auth（BASE_ERROR_CODES 与插件）以及本项目的 @product-res/auth（protection.ts、fresh-session.ts）。
 */
export const AUTH_ERROR_MESSAGES = {
  get SIGNUP_DISABLED() {
    return m.auth_error_signup_disabled()
  },
  get RATE_LIMITED() {
    return m.auth_error_rate_limited()
  },
  get TURNSTILE_FAILED() {
    return m.auth_error_turnstile_failed()
  },
  get TURNSTILE_PENDING() {
    return m.auth_error_turnstile_pending()
  },
  get EMAIL_NOT_VERIFIED() {
    return m.auth_error_email_not_verified()
  },
  get INVALID_EMAIL_OR_PASSWORD() {
    return m.auth_error_invalid_email_or_password()
  },
  get INVALID_EMAIL() {
    return m.auth_error_invalid_email()
  },
  get INVALID_PASSWORD() {
    return m.auth_error_invalid_password()
  },
  get PASSWORD_TOO_SHORT() {
    return m.auth_error_password_too_short()
  },
  get PASSWORD_TOO_LONG() {
    return m.auth_error_password_too_long()
  },
  get USER_ALREADY_EXISTS() {
    return m.auth_error_user_already_exists()
  },
  get USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL() {
    return m.auth_error_user_already_exists_use_another_email()
  },
  get BANNED_USER() {
    return m.auth_error_banned_user()
  },
  get USER_BANNED() {
    return m.auth_error_user_banned()
  },
  get INVALID_OTP() {
    return m.auth_error_invalid_otp()
  },
  get OTP_EXPIRED() {
    return m.auth_error_otp_expired()
  },
  get TOO_MANY_ATTEMPTS() {
    return m.auth_error_too_many_attempts()
  },
  get INVALID_TOKEN() {
    return m.auth_error_invalid_token()
  },
  get TOKEN_EXPIRED() {
    return m.auth_error_token_expired()
  },
  get EXPIRED_TOKEN() {
    return m.auth_error_expired_token()
  },
  get USER_NOT_FOUND() {
    return m.auth_error_user_not_found()
  },
  get INVALID_USER() {
    return m.auth_error_invalid_user()
  },
  get ATTEMPTS_EXCEEDED() {
    return m.auth_error_attempts_exceeded()
  },
  get NOT_FOUND() {
    return m.auth_error_not_found()
  },
  get ACCESS_DENIED() {
    return m.auth_error_access_denied()
  },
  get STATE_MISMATCH() {
    return m.auth_error_state_mismatch()
  },
  get UNABLE_TO_GET_USER_INFO() {
    return m.auth_error_unable_to_get_user_info()
  },
  get UNKNOWN() {
    return m.auth_error_unknown()
  },
} as const

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES

export interface AuthErrorLike {
  readonly code?: string | undefined
  readonly status?: number | undefined
}

/** 按错误码选文案：429 一律视为限流；未知错误码给通用提示，不直接显示服务端原文 */
export function authErrorMessage(error: AuthErrorLike | string | null | undefined): string {
  if (error === null || error === undefined) return AUTH_ERROR_MESSAGES.UNKNOWN
  const { code, status } = typeof error === 'string' ? { code: error, status: undefined } : error
  if (status === 429) return AUTH_ERROR_MESSAGES.RATE_LIMITED
  const key = code?.toUpperCase()
  if (key && key in AUTH_ERROR_MESSAGES) return AUTH_ERROR_MESSAGES[key as AuthErrorCode]
  if (status === 404) return AUTH_ERROR_MESSAGES.NOT_FOUND
  return AUTH_ERROR_MESSAGES.UNKNOWN
}
