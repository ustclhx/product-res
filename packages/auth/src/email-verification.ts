import type { TemplateConfig } from '@product-res/config'
import type { BetterAuthOptions } from 'better-auth'
import type { SendAuthEmail } from './email.ts'

/**
 * 邮箱验证（specs/user-auth「邮箱验证」，docs/04-auth-and-tenancy.md §1）：
 * - 默认（`auth.requireEmailVerification=false`）：注册不发验证邮件，未验证也能登录；
 * - 开启时：邮箱密码注册即发验证邮件，未验证不能登录，登录被拒时重新发送验证邮件；
 * - 两种配置下都可以经 `POST /api/auth/send-verification-email` 主动发起验证
 *   （账号设置、领取注册赠送积分），点击邮件中的链接后 `emailVerified=true`；
 * - OAuth 提供方返回已验证邮箱时 Better Auth 直接把账号记为已验证。
 */
export function emailVerificationOptions(config: TemplateConfig, sendEmail: SendAuthEmail) {
  const required = config.auth.emailPassword && config.auth.requireEmailVerification
  return {
    sendOnSignUp: required,
    sendOnSignIn: required,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({ type: 'verify-email', to: user.email, url })
    },
  } satisfies BetterAuthOptions['emailVerification']
}
