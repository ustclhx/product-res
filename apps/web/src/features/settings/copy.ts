import { m } from '../../paraglide/messages.js'

// 按当前页面语言惰性取文案，避免模块初始化时固定为默认语言。
export const ACCOUNT_COPY = {
  get title() {
    return m.account_title()
  },
  get heading() {
    return m.account_heading()
  },
  get saving() {
    return m.account_saving()
  },
  profile: {
    get heading() {
      return m.account_profile_heading()
    },
    get name() {
      return m.account_profile_name()
    },
    get image() {
      return m.account_profile_image()
    },
    get imageHint() {
      return m.account_profile_imagehint()
    },
    get email() {
      return m.account_profile_email()
    },
    get submit() {
      return m.account_profile_submit()
    },
    get saved() {
      return m.account_profile_saved()
    },
  },
  preferences: {
    get heading() {
      return m.account_preferences_heading()
    },
    get locale() {
      return m.account_preferences_locale()
    },
    get localeDefault() {
      return m.account_preferences_localedefault()
    },
    get timezone() {
      return m.account_preferences_timezone()
    },
    get timezoneHint() {
      return m.account_preferences_timezonehint()
    },
    get useBrowserTimezone() {
      return m.account_preferences_usebrowsertimezone()
    },
    get submit() {
      return m.account_preferences_submit()
    },
    get saved() {
      return m.account_preferences_saved()
    },
  },
  verification: {
    get heading() {
      return m.account_verification_heading()
    },
    get verified() {
      return m.account_verification_verified()
    },
    get unverified() {
      return m.account_verification_unverified()
    },
    get send() {
      return m.account_verification_send()
    },
    get sent() {
      return m.account_verification_sent()
    },
    get callbackFailed() {
      return m.account_verification_callbackfailed()
    },
  },
  password: {
    get heading() {
      return m.account_password_heading()
    },
    get current() {
      return m.account_password_current()
    },
    get next() {
      return m.account_password_next()
    },
    get confirm() {
      return m.account_password_confirm()
    },
    get mismatch() {
      return m.account_password_mismatch()
    },
    get submit() {
      return m.account_password_submit()
    },
    get changed() {
      return m.account_password_changed()
    },
    get noPassword() {
      return m.account_password_nopassword()
    },
  },
  twoFactor: {
    get heading() {
      return m.account_twofactor_heading()
    },
    get enabled() {
      return m.account_twofactor_enabled()
    },
    get disabled() {
      return m.account_twofactor_disabled()
    },
    get needsPassword() {
      return m.account_twofactor_needspassword()
    },
    get password() {
      return m.account_twofactor_password()
    },
    get enable() {
      return m.account_twofactor_enable()
    },
    get disable() {
      return m.account_twofactor_disable()
    },
    get setupIntro() {
      return m.account_twofactor_setupintro()
    },
    get totpUri() {
      return m.account_twofactor_totpuri()
    },
    get backupCodes() {
      return m.account_twofactor_backupcodes()
    },
    get code() {
      return m.account_twofactor_code()
    },
    get verify() {
      return m.account_twofactor_verify()
    },
    get turnedOn() {
      return m.account_twofactor_turnedon()
    },
    get turnedOff() {
      return m.account_twofactor_turnedoff()
    },
  },
  errors: {
    get INVALID_PASSWORD() {
      return m.account_errors_invalid_password()
    },
    get PASSWORD_TOO_SHORT() {
      return m.account_errors_password_too_short()
    },
    get PASSWORD_TOO_LONG() {
      return m.account_errors_password_too_long()
    },
    get VALIDATION_ERROR() {
      return m.account_errors_validation_error()
    },
    get INVALID_CODE() {
      return m.account_errors_invalid_code()
    },
    get INVALID_TWO_FACTOR_AUTHENTICATION() {
      return m.account_errors_invalid_two_factor_authentication()
    },
    get SESSION_REQUIRED() {
      return m.account_errors_session_required()
    },
    get USER_BANNED() {
      return m.account_errors_user_banned()
    },
    get RATE_LIMITED() {
      return m.account_errors_rate_limited()
    },
    get unknown() {
      return m.account_errors_unknown()
    },
  } as Record<string, string>,
} as const

/** Better Auth 客户端返回的错误：按错误码取文案 */
export function errorMessage(error: { code?: string | undefined } | null | undefined): string {
  return ACCOUNT_COPY.errors[error?.code ?? ''] ?? ACCOUNT_COPY.errors.unknown ?? ''
}
