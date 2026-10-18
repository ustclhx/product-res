import { Button, useAppForm } from '@product-res/ui'
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
import { AUTH_ERROR_MESSAGES, authErrorMessage } from '../../features/auth/errors.ts'
import { m } from '../../paraglide/messages.js'

/** 按当前请求或页面语言读取文案，避免在模块初始化时固定语言。 */
const COPY = {
  get metaTitle() {
    return m.auth_set_a_new_password()
  },
  get title() {
    return m.auth_set_a_new_password()
  },
  get description() {
    return m.auth_choose_a_new_password_for_your_account()
  },
  get password() {
    return m.auth_new_password()
  },
  get confirm() {
    return m.auth_confirm_new_password()
  },
  get passwordHint() {
    return m.auth_at_least_8_characters()
  },
  get submit() {
    return m.auth_update_password()
  },
  get pending() {
    return m.auth_updating()
  },
  get done() {
    return m.auth_your_password_has_been_updated_other_signed_in()
  },
  get signIn() {
    return m.auth_sign_in()
  },
  get requestNewLink() {
    return m.auth_request_a_new_link()
  },
  get backToLogin() {
    return m.auth_back_to_sign_in()
  },
  get passwordTooShort() {
    return m.auth_password_must_be_at_least_8_characters()
  },
  get passwordTooLong() {
    return m.auth_password_must_be_at_most_128_characters()
  },
  get mismatch() {
    return m.auth_passwords_do_not_match()
  },
} as const

const schema = () =>
  z
    .object({
      password: z.string().min(8, COPY.passwordTooShort).max(128, COPY.passwordTooLong),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { message: COPY.mismatch, path: ['confirm'] })

export const Route = createFileRoute('/(auth)/reset-password')({
  // 重置链接校验通过时带 ?token=，链接无效 / 过期时带 ?error=INVALID_TOKEN
  validateSearch: z.object({ token: z.string().optional(), error: z.string().optional() }),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token, error } = Route.useSearch()
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
      {error || !token ? (
        <>
          <FormAlert message={authErrorMessage(error ?? 'INVALID_TOKEN')} />
          <Button asChild variant="outline">
            <Link to="/forgot-password">{COPY.requestNewLink}</Link>
          </Button>
        </>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthLayout>
  )
}

function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const form = useAppForm({
    defaultValues: { password: '', confirm: '' },
    validators: { onBlur: schema(), onSubmit: schema() },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        // 重置密码不在 Turnstile 保护范围内（一次性令牌本身即凭据）
        const result = await authClient().resetPassword({ newPassword: value.password, token })
        if (result.error) setError(authErrorMessage(result.error))
        else setDone(true)
      } catch {
        setError(AUTH_ERROR_MESSAGES.UNKNOWN)
      }
    },
  })

  if (done) {
    return (
      <>
        <StatusAlert>{COPY.done}</StatusAlert>
        <Button asChild>
          <Link to="/login">{COPY.signIn}</Link>
        </Button>
      </>
    )
  }
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.title}>
        <FormAlert message={error} />
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={COPY.password}
              type="password"
              autoComplete="new-password"
              description={COPY.passwordHint}
            />
          )}
        </form.AppField>
        <form.AppField name="confirm">
          {(field) => (
            <field.TextField label={COPY.confirm} type="password" autoComplete="new-password" />
          )}
        </form.AppField>
        <form.SubmitButton pendingLabel={COPY.pending}>{COPY.submit}</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
