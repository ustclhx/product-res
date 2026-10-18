import { Button } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { AFTER_SIGN_IN_PATH } from '../../features/auth/auth-client.ts'
import { AuthLayout, FormAlert, StatusAlert } from '../../features/auth/auth-layout.tsx'
import { authErrorMessage } from '../../features/auth/errors.ts'
import { m } from '../../paraglide/messages.js'

/** 按当前请求或页面语言读取文案，避免在模块初始化时固定语言。 */
const COPY = {
  get metaTitle() {
    return m.auth_email_verification()
  },
  get successTitle() {
    return m.auth_email_verified()
  },
  get success() {
    return m.auth_your_email_address_has_been_verified()
  },
  get continue() {
    return m.auth_continue()
  },
  get failureTitle() {
    return m.auth_verification_failed()
  },
  get failureHint() {
    return m.auth_sign_in_to_receive_a_new_verification_email()
  },
  get signIn() {
    return m.auth_back_to_sign_in()
  },
} as const

/**
 * 邮箱验证结果页：验证邮件中的链接先到 /api/auth/verify-email，校验后 Better Auth 跳到这里
 * （发起验证时 callbackURL=/verify-email）。成功时不带参数且已自动登录；失败时带 ?error=<错误码>。
 */
export const Route = createFileRoute('/(auth)/verify-email')({
  validateSearch: z.object({ error: z.string().optional() }),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: VerifyEmailPage,
})

function VerifyEmailPage() {
  const { error } = Route.useSearch()
  if (error) {
    return (
      <AuthLayout title={COPY.failureTitle}>
        <FormAlert message={authErrorMessage(error)} />
        <p className="text-muted-foreground text-sm">{COPY.failureHint}</p>
        <Button asChild variant="outline">
          <Link to="/login">{COPY.signIn}</Link>
        </Button>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout title={COPY.successTitle}>
      <StatusAlert>{COPY.success}</StatusAlert>
      {/* /app 由 p1-workspace 实现，尚不在路由树中，用普通链接整页跳转 */}
      <Button asChild>
        <a href={AFTER_SIGN_IN_PATH}>{COPY.continue}</a>
      </Button>
    </AuthLayout>
  )
}
