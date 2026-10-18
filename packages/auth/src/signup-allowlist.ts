import { APIError } from 'better-auth/api'

/** 解析逗号分隔的邮箱名单：去空白、转小写、去重；空值表示不限制 */
export function parseEmailList(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * 注册白名单：名单非空时，只有名单内邮箱可以创建用户。
 * 挂在 user.create.before 上，覆盖邮箱密码、验证码、魔法链接与 OAuth 等所有建号路径。
 */
export function signupAllowlist(configured: string | undefined) {
  const allowed = parseEmailList(configured)
  return (email: string) => {
    if (allowed.size === 0) return
    if (!allowed.has(email.trim().toLowerCase()))
      throw APIError.from('FORBIDDEN', {
        code: 'SIGNUP_NOT_ALLOWED',
        message: 'Sign-up is limited to invited email addresses',
      })
  }
}
