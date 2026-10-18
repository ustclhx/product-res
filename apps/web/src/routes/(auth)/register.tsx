import { useAppForm } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient, goToApp } from '../../features/auth/auth-client.ts'
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
    return m.auth_create_account()
  },
  get title() {
    return m.auth_create_an_account()
  },
  get description() {
    return m.auth_sign_up_with_your_email_address()
  },
  get name() {
    return m.auth_name()
  },
  get email() {
    return m.auth_email()
  },
  get password() {
    return m.auth_password()
  },
  get passwordHint() {
    return m.auth_at_least_8_characters()
  },
  get submit() {
    return m.auth_create_account()
  },
  get pending() {
    return m.auth_creating_account()
  },
  checkEmail: (email: string) =>
    m.auth_we_sent_a_verification_link_to_verify_your({ email: email }),
  get haveAccount() {
    return m.auth_already_have_an_account()
  },
  get signIn() {
    return m.auth_sign_in()
  },
  get unavailable() {
    return m.auth_sign_up_with_email_and_password_is_not()
  },
  get nameRequired() {
    return m.auth_enter_your_name()
  },
  get invalidEmail() {
    return m.auth_enter_a_valid_email_address()
  },
  get passwordTooShort() {
    return m.auth_password_must_be_at_least_8_characters()
  },
  get passwordTooLong() {
    return m.auth_password_must_be_at_most_128_characters()
  },
} as const

// 与 Better Auth 默认的密码长度限制一致（minPasswordLength 8 / maxPasswordLength 128）
const schema = () =>
  z.object({
    name: z.string().trim().min(1, COPY.nameRequired),
    email: z.email(COPY.invalidEmail),
    password: z.string().min(8, COPY.passwordTooShort).max(128, COPY.passwordTooLong),
  })

export const Route = createFileRoute('/(auth)/register')({
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: RegisterPage,
})

function RegisterPage() {
  const options = Route.useLoaderData()
  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        <p>
          {COPY.haveAccount}{' '}
          <Link to="/login" className={authLinkClassName}>
            {COPY.signIn}
          </Link>
        </p>
      }
    >
      {options.emailPassword ? (
        <RegisterForm siteKey={options.turnstileSiteKey} />
      ) : (
        <FormAlert message={COPY.unavailable} />
      )}
    </AuthLayout>
  )
}

function RegisterForm({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'sign-up')
  const { error, run } = useAuthRequest(turnstile)
  const [verifyEmail, setVerifyEmail] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { name: '', email: '', password: '' },
    validators: { onBlur: schema(), onSubmit: schema() },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signUp.email({
          ...value,
          name: value.name.trim(),
          // 验证邮件中的回跳地址（结果页）
          callbackURL: '/verify-email',
          fetchOptions: { headers },
        }),
      )
      if (!data) return
      // 强制验证邮箱时注册不登录（token 为 null），提示去邮箱验证；否则已登录，进入应用区
      if (data.token) goToApp()
      else setVerifyEmail(value.email)
    },
  })

  if (verifyEmail !== null) return <StatusAlert>{COPY.checkEmail(verifyEmail)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.title}>
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => <field.TextField label={COPY.name} autoComplete="name" />}
        </form.AppField>
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
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
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.pending} disabled={!turnstile.ready}>
          {COPY.submit}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}
