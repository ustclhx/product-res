import { useAppForm } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../../features/auth/auth-client.ts'
import {
  AuthLayout,
  authLinkClassName,
  FormAlert,
  StatusAlert,
} from '../../features/auth/auth-layout.tsx'
import { getAuthUiOptions } from '../../features/auth/options.functions.ts'
import { useTurnstile } from '../../features/auth/turnstile.tsx'
import { useAuthRequest } from '../../features/auth/use-auth-request.ts'
import { m } from '../../paraglide/messages.js'

/** 按当前请求或页面语言读取文案，避免在模块初始化时固定语言。 */
const COPY = {
  get metaTitle() {
    return m.auth_forgot_password()
  },
  get title() {
    return m.auth_reset_your_password()
  },
  get description() {
    return m.auth_enter_your_email_and_we_ll_send_you()
  },
  get email() {
    return m.auth_email()
  },
  get submit() {
    return m.auth_send_reset_link()
  },
  get pending() {
    return m.auth_sending()
  },
  // 不论邮箱是否注册都给出同样的提示，不泄露账号是否存在
  sent: (email: string) => m.auth_if_an_account_exists_for_you_will_receive({ email: email }),
  get backToLogin() {
    return m.auth_back_to_sign_in()
  },
  get unavailable() {
    return m.auth_password_sign_in_is_not_enabled()
  },
  get invalidEmail() {
    return m.auth_enter_a_valid_email_address()
  },
} as const

const schema = () => z.object({ email: z.email(COPY.invalidEmail) })

export const Route = createFileRoute('/(auth)/forgot-password')({
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const options = Route.useLoaderData()
  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        <Link to="/login" className={authLinkClassName}>
          {COPY.backToLogin}
        </Link>
      }
    >
      {options.emailPassword ? (
        <ForgotPasswordForm siteKey={options.turnstileSiteKey} />
      ) : (
        <FormAlert message={COPY.unavailable} />
      )}
    </AuthLayout>
  )
}

function ForgotPasswordForm({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'reset-password')
  const { error, run } = useAuthRequest(turnstile)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: schema() },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().requestPasswordReset({
          email: value.email,
          // 邮件链接经 /api/auth/reset-password/:token 校验后回到该页，带 ?token= 或 ?error=
          redirectTo: '/reset-password',
          fetchOptions: { headers },
        }),
      )
      if (data) setSentTo(value.email)
    },
  })

  if (sentTo !== null) return <StatusAlert>{COPY.sent(sentTo)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.title}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.pending} disabled={!turnstile.ready}>
          {COPY.submit}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
