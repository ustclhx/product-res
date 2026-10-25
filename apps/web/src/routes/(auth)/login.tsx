import { Button, useAppForm } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { z } from 'zod'
import {
  authClient,
  goToApp,
  redirectSearch,
  signInCallbackURL,
} from '../../features/auth/auth-client.ts'
import {
  AuthDivider,
  AuthLayout,
  authLinkClassName,
  FormAlert,
  StatusAlert,
} from '../../features/auth/auth-layout.tsx'
import { authErrorMessage } from '../../features/auth/errors.ts'
import { getAuthUiOptions } from '../../features/auth/options.functions.ts'
import type { AuthUiOptions } from '../../features/auth/options.ts'
import { useTurnstile } from '../../features/auth/turnstile.tsx'
import { useAuthRequest } from '../../features/auth/use-auth-request.ts'
import { m } from '../../paraglide/messages.js'

/** 按当前请求或页面语言读取文案，避免在模块初始化时固定语言。 */
const COPY = {
  get metaTitle() {
    return m.auth_sign_in()
  },
  get title() {
    return m.auth_sign_in()
  },
  get description() {
    return m.auth_welcome_back_choose_how_you_want_to_sign()
  },
  get email() {
    return m.auth_email()
  },
  get password() {
    return m.auth_password()
  },
  get code() {
    return m.auth_verification_code()
  },
  get forgotPassword() {
    return m.auth_forgot_password_link()
  },
  get signIn() {
    return m.auth_sign_in()
  },
  get signingIn() {
    return m.auth_signing_in()
  },
  get sendCode() {
    return m.auth_send_code()
  },
  get sendingCode() {
    return m.auth_sending()
  },
  codeSent: (email: string) => m.auth_we_sent_a_6_digit_code_to_it({ email: email }),
  get useAnotherEmail() {
    return m.auth_use_a_different_email()
  },
  get sendLink() {
    return m.auth_send_magic_link()
  },
  get sendingLink() {
    return m.auth_sending()
  },
  linkSent: (email: string) => m.auth_check_for_a_sign_in_link({ email: email }),
  get or() {
    return m.auth_or()
  },
  modes: {
    get password() {
      return m.auth_sign_in_with_password()
    },
    get otp() {
      return m.auth_sign_in_with_email_code()
    },
    get magicLink() {
      return m.auth_sign_in_with_magic_link()
    },
  },
  oauth: {
    get google() {
      return m.auth_continue_with_google()
    },
    get github() {
      return m.auth_continue_with_github()
    },
  },
  get noAccount() {
    return m.auth_don_t_have_an_account()
  },
  get register() {
    return m.auth_sign_up()
  },
  get noMethods() {
    return m.auth_sign_in_is_not_available_right_now()
  },
  get invalidEmail() {
    return m.auth_enter_a_valid_email_address()
  },
  get passwordRequired() {
    return m.auth_enter_your_password()
  },
  get invalidCode() {
    return m.auth_enter_the_6_digit_code()
  },
} as const

type Mode = keyof typeof COPY.modes

export const Route = createFileRoute('/(auth)/login')({
  // OAuth / 魔法链接失败时 Better Auth 把错误码放在 ?error= 中带回登录页
  validateSearch: z.object({ error: z.string().optional(), redirect: z.string().optional() }),
  loader: () => getAuthUiOptions(),
  head: () => ({ meta: [{ title: COPY.metaTitle }] }),
  component: LoginPage,
})

function enabledModes(options: AuthUiOptions): Mode[] {
  return [
    ...(options.emailPassword ? (['password'] as const) : []),
    ...(options.emailOtp ? (['otp'] as const) : []),
    ...(options.magicLink ? (['magicLink'] as const) : []),
  ]
}

function LoginPage() {
  const options = Route.useLoaderData()
  const { error: callbackError, redirect } = Route.useSearch()
  // 注册入口保留回跳地址（例如邀请链接），注册完成后回到原页面
  const registerHref = `/register${redirectSearch(redirect ? `?redirect=${encodeURIComponent(redirect)}` : '')}`
  const modes = enabledModes(options)
  const [mode, setMode] = useState<Mode | undefined>(modes[0])
  const otherModes = modes.filter((m) => m !== mode)
  const hasAny = modes.length > 0 || options.oauth.length > 0

  return (
    <AuthLayout
      title={COPY.title}
      description={COPY.description}
      footer={
        options.emailPassword ? (
          <p>
            {COPY.noAccount}{' '}
            <a href={registerHref} className={authLinkClassName}>
              {COPY.register}
            </a>
          </p>
        ) : null
      }
    >
      {callbackError ? <FormAlert message={authErrorMessage(callbackError)} /> : null}
      {!hasAny ? <FormAlert message={COPY.noMethods} /> : null}

      {/* 第三方登录放在最上方：一键入口优先，邮箱表单作为备选 */}
      {options.oauth.length > 0 ? (
        <div className="grid gap-2">
          {options.oauth.map((provider) => (
            <OAuthButton key={provider} provider={provider} />
          ))}
        </div>
      ) : null}
      {options.oauth.length > 0 && mode !== undefined ? (
        <AuthDivider>{m.auth_divider_email()}</AuthDivider>
      ) : null}

      {mode === 'password' ? <PasswordSignIn siteKey={options.turnstileSiteKey} /> : null}
      {mode === 'otp' ? <OtpSignIn siteKey={options.turnstileSiteKey} /> : null}
      {mode === 'magicLink' ? <MagicLinkSignIn siteKey={options.turnstileSiteKey} /> : null}

      {otherModes.length > 0 ? (
        <>
          <AuthDivider>{COPY.or}</AuthDivider>
          <div className="grid gap-2">
            {otherModes.map((other) => (
              <Button key={other} type="button" variant="outline" onClick={() => setMode(other)}>
                {COPY.modes[other]}
              </Button>
            ))}
          </div>
        </>
      ) : null}
    </AuthLayout>
  )
}

const emailSchema = () => z.email(COPY.invalidEmail)

function PasswordSignIn({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'sign-in')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: {
      onSubmit: z.object({
        email: emailSchema(),
        password: z.string().min(1, COPY.passwordRequired),
      }),
    },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.email({
          ...value,
          // Verification links and successful sign-in resume the same local destination.
          callbackURL: signInCallbackURL(),
          fetchOptions: { headers },
        }),
      )
      if (data) goToApp()
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.password}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={COPY.password}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.AppField>
        {/* 忘记密码贴在密码框下方右侧，比放在页脚更容易被找到 */}
        <div className="-mt-2 flex justify-end">
          <Link
            to="/forgot-password"
            className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
          >
            {COPY.forgotPassword}
          </Link>
        </div>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.signingIn} disabled={!turnstile.ready}>
          {COPY.signIn}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OtpSignIn({ siteKey }: { siteKey: string | null }) {
  const [email, setEmail] = useState<string | null>(null)
  return email === null ? (
    <OtpRequest siteKey={siteKey} onSent={setEmail} />
  ) : (
    <OtpVerify siteKey={siteKey} email={email} onBack={() => setEmail(null)} />
  )
}

function OtpRequest({
  siteKey,
  onSent,
}: {
  siteKey: string | null
  onSent: (email: string) => void
}) {
  const turnstile = useTurnstile(siteKey, 'send-otp')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: z.object({ email: emailSchema() }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().emailOtp.sendVerificationOtp({
          email: value.email,
          type: 'sign-in',
          fetchOptions: { headers },
        }),
      )
      if (data) onSent(value.email)
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.otp}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.sendingCode} disabled={!turnstile.ready}>
          {COPY.sendCode}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OtpVerify({
  siteKey,
  email,
  onBack,
}: {
  siteKey: string | null
  email: string
  onBack: () => void
}) {
  const turnstile = useTurnstile(siteKey, 'sign-in-otp')
  const { error, run } = useAuthRequest(turnstile)
  const form = useAppForm({
    defaultValues: { otp: '' },
    validators: { onSubmit: z.object({ otp: z.string().regex(/^\d{6}$/, COPY.invalidCode) }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.emailOtp({ email, otp: value.otp, fetchOptions: { headers } }),
      )
      if (data) goToApp()
    },
  })
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.otp}>
        <StatusAlert>{COPY.codeSent(email)}</StatusAlert>
        <FormAlert message={error} />
        <form.AppField name="otp">
          {(field) => (
            <field.TextField
              label={COPY.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          )}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.signingIn} disabled={!turnstile.ready}>
          {COPY.signIn}
        </form.SubmitButton>
        <Button type="button" variant="link" onClick={onBack}>
          {COPY.useAnotherEmail}
        </Button>
      </form.Form>
    </form.AppForm>
  )
}

function MagicLinkSignIn({ siteKey }: { siteKey: string | null }) {
  const turnstile = useTurnstile(siteKey, 'magic-link')
  const { error, run } = useAuthRequest(turnstile)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: z.object({ email: emailSchema() }) },
    onSubmit: async ({ value }) => {
      const data = await run((headers) =>
        authClient().signIn.magicLink({
          email: value.email,
          callbackURL: signInCallbackURL(),
          errorCallbackURL: '/login',
          fetchOptions: { headers },
        }),
      )
      if (data) setSentTo(value.email)
    },
  })
  if (sentTo !== null) return <StatusAlert>{COPY.linkSent(sentTo)}</StatusAlert>
  return (
    <form.AppForm>
      <form.Form aria-label={COPY.modes.magicLink}>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => <field.TextField label={COPY.email} type="email" autoComplete="email" />}
        </form.AppField>
        {turnstile.widget}
        <form.SubmitButton pendingLabel={COPY.sendingLink} disabled={!turnstile.ready}>
          {COPY.sendLink}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

function OAuthButton({ provider }: { provider: AuthUiOptions['oauth'][number] }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const onClick = async () => {
    setPending(true)
    setError(null)
    // OAuth callbacks use the same validated destination as password and OTP sign-in.
    const { data, error } = await authClient().signIn.social({
      provider,
      callbackURL: signInCallbackURL(),
      errorCallbackURL: '/login',
    })
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setPending(false)
    setError(authErrorMessage(error))
  }
  return (
    <>
      <Button type="button" variant="outline" disabled={pending} onClick={onClick}>
        {OAUTH_ICONS[provider]}
        {COPY.oauth[provider]}
      </Button>
      <FormAlert message={error} />
    </>
  )
}

// 提供方标识用内联 SVG，避免为两个图标引入图标库；aria-hidden，按钮名称仍取文字
const OAUTH_ICONS: Record<AuthUiOptions['oauth'][number], ReactNode> = {
  google: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .32.21.69.82.57A12 12 0 0 0 12 .3Z" />
    </svg>
  ),
}
