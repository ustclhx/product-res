import { Button, Input, Label, useAppForm } from '@product-res/ui'
import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useId, useState } from 'react'
import { baseLocale, isLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import { authClient } from '../auth/auth-client.ts'
import { rememberLocale } from '../i18n/preference.ts'
import type { AccountView } from './account.ts'
import { ACCOUNT_COPY, errorMessage } from './copy.ts'
import {
  changePasswordFormSchema,
  emptyToNull,
  passwordOnlyFormSchema,
  preferencesFormSchema,
  profileFormSchema,
  totpCodeFormSchema,
} from './schemas.ts'

// 设置业务沿用原有 TanStack Form + Zod 校验，共享 UI 基础组件与认证客户端。

type User = AccountView['user']
type Status = { readonly kind: 'success' | 'error'; readonly message: string } | null

function StatusMessage({ status }: { readonly status: Status }) {
  if (!status) return null
  return <p role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</p>
}

/** 字段的校验错误：Standard Schema 的 issue 或字符串 */
function FieldErrors({ id, errors }: { readonly id: string; readonly errors: readonly unknown[] }) {
  const messages = errors.flatMap((e) =>
    typeof e === 'string'
      ? [e]
      : e && typeof e === 'object' && 'message' in e
        ? [String(e.message)]
        : [],
  )
  if (messages.length === 0) return null
  return (
    <ul id={id} role="alert">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  )
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border bg-card p-6 shadow-sm [&_form]:grid [&_form]:gap-4 [&_form_p]:grid [&_form_p]:gap-2"
    >
      <h2 id={id} className="mb-4 font-semibold text-lg">
        {title}
      </h2>
      {children}
    </section>
  )
}

const submitHandler = (submit: () => unknown) => (e: React.FormEvent) => {
  e.preventDefault()
  e.stopPropagation()
  void submit()
}

export function ProfileSection({ user }: { readonly user: User }) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>(null)
  const form = useAppForm({
    defaultValues: { name: user.name, image: user.image ?? '' },
    validators: { onSubmit: profileFormSchema },
    onSubmit: async ({ value }) => {
      setStatus(null)
      const { error } = await authClient().updateUser({
        name: value.name.trim(),
        image: emptyToNull(value.image),
      })
      if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
      setStatus({ kind: 'success', message: ACCOUNT_COPY.profile.saved })
      await router.invalidate()
    },
  })
  const copy = ACCOUNT_COPY.profile
  return (
    <Section title={copy.heading}>
      <p>
        {copy.email}: {user.email}
      </p>
      <form onSubmit={submitHandler(form.handleSubmit)} noValidate>
        <form.Field name="name">
          {(field) => (
            <p>
              <Label htmlFor={field.name}>{copy.name}</Label>
              <Input
                id={field.name}
                name={field.name}
                autoComplete="name"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
            </p>
          )}
        </form.Field>
        <form.Field name="image">
          {(field) => (
            <p>
              <Label htmlFor={field.name}>{copy.image}</Label>
              <Input
                id={field.name}
                name={field.name}
                type="url"
                inputMode="url"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <small>{copy.imageHint}</small>
              <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
            </p>
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? ACCOUNT_COPY.saving : copy.submit}
            </Button>
          )}
        </form.Subscribe>
      </form>
      <StatusMessage status={status} />
    </Section>
  )
}

export function PreferencesSection({
  user,
  locales,
}: {
  readonly user: User
  readonly locales: readonly string[]
}) {
  const [status, setStatus] = useState<Status>(null)
  const form = useAppForm({
    defaultValues: { locale: user.locale ?? '', timezone: user.timezone ?? '' },
    validators: { onSubmit: preferencesFormSchema(locales) },
    onSubmit: async ({ value }) => {
      setStatus(null)
      const { error } = await authClient().updateUser({
        locale: emptyToNull(value.locale),
        timezone: emptyToNull(value.timezone),
      })
      if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
      if (templateConfig.i18n.enabled)
        rememberLocale(isLocale(value.locale) ? value.locale : baseLocale)
      window.location.reload()
    },
  })
  const copy = ACCOUNT_COPY.preferences
  return (
    <Section title={copy.heading}>
      <form onSubmit={submitHandler(form.handleSubmit)} noValidate>
        {templateConfig.i18n.enabled && (
          <form.Field name="locale">
            {(field) => (
              <p>
                <Label htmlFor={field.name}>{copy.locale}</Label>
                <select
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">{copy.localeDefault}</option>
                  {locales.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
              </p>
            )}
          </form.Field>
        )}
        <form.Field name="timezone">
          {(field) => (
            <p>
              <Label htmlFor={field.name}>{copy.timezone}</Label>
              <Input
                id={field.name}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <Button
                type="button"
                onClick={() => field.handleChange(Intl.DateTimeFormat().resolvedOptions().timeZone)}
              >
                {copy.useBrowserTimezone}
              </Button>
              <small>{copy.timezoneHint}</small>
              <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
            </p>
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? ACCOUNT_COPY.saving : copy.submit}
            </Button>
          )}
        </form.Subscribe>
      </form>
      <StatusMessage status={status} />
    </Section>
  )
}

export function EmailVerificationSection({
  user,
  callbackError,
}: {
  readonly user: User
  /** 验证链接回调到 /account 时带回的错误（链接无效或过期） */
  readonly callbackError: string | undefined
}) {
  const [status, setStatus] = useState<Status>(
    callbackError && !user.emailVerified
      ? { kind: 'error', message: ACCOUNT_COPY.verification.callbackFailed }
      : null,
  )
  const [sending, setSending] = useState(false)
  const copy = ACCOUNT_COPY.verification
  if (user.emailVerified) {
    return (
      <Section title={copy.heading}>
        <p>{copy.verified}</p>
      </Section>
    )
  }
  const send = async () => {
    setSending(true)
    setStatus(null)
    // POST /api/auth/send-verification-email：已登录时免 Turnstile，按 IP + 邮箱限流
    const { error } = await authClient().sendVerificationEmail({
      email: user.email,
      callbackURL: '/account',
    })
    setSending(false)
    setStatus(
      error
        ? { kind: 'error', message: errorMessage(error) }
        : { kind: 'success', message: copy.sent },
    )
  }
  return (
    <Section title={copy.heading}>
      <p>{copy.unverified}</p>
      <Button type="button" onClick={send} disabled={sending}>
        {copy.send}
      </Button>
      <StatusMessage status={status} />
    </Section>
  )
}

export function PasswordSection({ hasPassword }: { readonly hasPassword: boolean }) {
  const [status, setStatus] = useState<Status>(null)
  const form = useAppForm({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validators: { onSubmit: changePasswordFormSchema },
    onSubmit: async ({ value, formApi }) => {
      setStatus(null)
      // 服务端总会吊销其他会话（packages/auth 的 accountSettings），这里显式传入以表达意图
      const { error } = await authClient().changePassword({
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
        revokeOtherSessions: true,
      })
      if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
      formApi.reset()
      setStatus({ kind: 'success', message: ACCOUNT_COPY.password.changed })
    },
  })
  const copy = ACCOUNT_COPY.password
  if (!hasPassword) {
    return (
      <Section title={copy.heading}>
        <p>{copy.noPassword}</p>
      </Section>
    )
  }
  const fields = [
    ['currentPassword', copy.current, 'current-password'],
    ['newPassword', copy.next, 'new-password'],
    ['confirmPassword', copy.confirm, 'new-password'],
  ] as const
  return (
    <Section title={copy.heading}>
      <form onSubmit={submitHandler(form.handleSubmit)} noValidate>
        {fields.map(([name, label, autoComplete]) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <p>
                <Label htmlFor={field.name}>{label}</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="password"
                  autoComplete={autoComplete}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
              </p>
            )}
          </form.Field>
        ))}
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? ACCOUNT_COPY.saving : copy.submit}
            </Button>
          )}
        </form.Subscribe>
      </form>
      <StatusMessage status={status} />
    </Section>
  )
}

/** 两步验证：只在模板配置 auth.twoFactor=true 时渲染（由页面决定） */
export function TwoFactorSection({
  user,
  hasPassword,
}: {
  readonly user: User
  readonly hasPassword: boolean
}) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>(null)
  // 开启流程第一步返回的密钥与备用码；验证 TOTP 后才真正开启
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null)
  const copy = ACCOUNT_COPY.twoFactor

  const passwordForm = useAppForm({
    defaultValues: { password: '' },
    validators: { onSubmit: passwordOnlyFormSchema },
    onSubmit: async ({ value, formApi }) => {
      setStatus(null)
      if (user.twoFactorEnabled) {
        const { error } = await authClient().twoFactor.disable({ password: value.password })
        if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
        formApi.reset()
        setStatus({ kind: 'success', message: copy.turnedOff })
        await router.invalidate()
        return
      }
      const { data, error } = await authClient().twoFactor.enable({
        password: value.password,
        method: 'totp',
      })
      if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
      formApi.reset()
      if (data.method === 'totp') setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes })
    },
  })

  const codeForm = useAppForm({
    defaultValues: { code: '' },
    validators: { onSubmit: totpCodeFormSchema },
    onSubmit: async ({ value }) => {
      setStatus(null)
      const { error } = await authClient().twoFactor.verifyTotp({ code: value.code })
      if (error) return setStatus({ kind: 'error', message: errorMessage(error) })
      setSetup(null)
      setStatus({ kind: 'success', message: copy.turnedOn })
      await router.invalidate()
    },
  })

  if (!hasPassword) {
    return (
      <Section title={copy.heading}>
        <p>{copy.needsPassword}</p>
      </Section>
    )
  }

  return (
    <Section title={copy.heading}>
      <p>{user.twoFactorEnabled ? copy.enabled : copy.disabled}</p>
      {setup ? (
        <div>
          <p>{copy.setupIntro}</p>
          <p>
            {copy.totpUri}: <code>{setup.totpURI}</code>
          </p>
          <p>{copy.backupCodes}</p>
          <ul>
            {setup.backupCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <form onSubmit={submitHandler(codeForm.handleSubmit)} noValidate>
            <codeForm.Field name="code">
              {(field) => (
                <p>
                  <Label htmlFor="totp-code">{copy.code}</Label>
                  <Input
                    id="totp-code"
                    name={field.name}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <FieldErrors id="totp-code-errors" errors={field.state.meta.errors} />
                </p>
              )}
            </codeForm.Field>
            <Button type="submit">{copy.verify}</Button>
          </form>
        </div>
      ) : (
        <form onSubmit={submitHandler(passwordForm.handleSubmit)} noValidate>
          <passwordForm.Field name="password">
            {(field) => (
              <p>
                <Label htmlFor="two-factor-password">{copy.password}</Label>
                <Input
                  id="two-factor-password"
                  name={field.name}
                  type="password"
                  autoComplete="current-password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldErrors id="two-factor-password-errors" errors={field.state.meta.errors} />
              </p>
            )}
          </passwordForm.Field>
          <Button type="submit">{user.twoFactorEnabled ? copy.disable : copy.enable}</Button>
        </form>
      )}
      <StatusMessage status={status} />
    </Section>
  )
}
