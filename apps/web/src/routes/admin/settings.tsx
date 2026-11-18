import { Button, Checkbox, Input, Label, Textarea } from '@product-res/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { getAdminSettings, saveAdminSettings } from '../../features/admin/settings.functions.ts'
import { OperationsSettingsForm } from '../../features/admin/settings-operations-form.tsx'
import { AdminPage, Field, panelClass } from '../../features/admin/ui.tsx'
import { m } from '../../paraglide/messages.js'

export const Route = createFileRoute('/admin/settings')({
  loader: () => getAdminSettings(),
  errorComponent: () => <p role="alert">{m.admin_settings_are_unavailable_please_reload()}</p>,
  component: Settings,
})

function Settings() {
  const saved = Route.useLoaderData()
  const router = useRouter()
  const [signupEnabled, setSignupEnabled] = useState(saved.signupEnabled)
  const [announcement, setAnnouncement] = useState(saved.announcement)
  const [blacklist, setBlacklist] = useState(saved.signupBonusDomainBlacklist.join('\n'))
  const [freeFailureCount, setFreeFailureCount] = useState(String(saved.freeFailures.count))
  const [freeFailureMinutes, setFreeFailureMinutes] = useState(
    String(saved.freeFailures.windowSeconds / 60),
  )
  const [dailyAmount, setDailyAmount] = useState(String(saved.dailyAmount))
  const [dailyMaxDays, setDailyMaxDays] = useState(String(saved.dailyMaxDaysPerMonth))
  const [dailyExpiryDays, setDailyExpiryDays] = useState(String(saved.dailyExpiryDays))
  const [dailyVerifiedEmail, setDailyVerifiedEmail] = useState(saved.dailyRequireVerifiedEmail)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await saveAdminSettings({
        data: {
          signupEnabled,
          dailyAmount: Number(dailyAmount),
          dailyMaxDaysPerMonth: Number(dailyMaxDays),
          dailyExpiryDays: Number(dailyExpiryDays),
          dailyRequireVerifiedEmail: dailyVerifiedEmail,
          announcement,
          signupBonusDomainBlacklist: blacklist
            .split(/[\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
          freeFailures: {
            count: Number(freeFailureCount),
            windowSeconds: Math.round(Number(freeFailureMinutes) * 60),
          },
        },
      })
      setMessage(
        result.ok
          ? m.admin_saved_changes_apply_within_about_60_seconds()
          : (result.error ?? m.admin_save_failed()),
      )
      await router.invalidate()
    } catch {
      setMessage(m.admin_save_unavailable_enter_valid_domains_no_email_addresses())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminPage title={m.admin_runtime_settings()} className="max-w-3xl">
      <form onSubmit={submit} aria-label={m.admin_runtime_settings()} className={panelClass()}>
        <fieldset disabled={!hydrated || busy} className="grid min-w-0 gap-5">
          <div className="grid gap-2">
            <Label htmlFor="registration-enabled" className="font-normal text-sm leading-normal">
              <Checkbox
                id="registration-enabled"
                checked={signupEnabled}
                onCheckedChange={setSignupEnabled}
              />
              {m.admin_registration_enabled()}
            </Label>
            <p className="text-muted-foreground text-sm">
              {m.admin_when_registration_is_closed_only_valid_waitlist_invitations()}
            </p>
          </div>
          <Field
            label={m.admin_site_announcement()}
            htmlFor="announcement"
            description={m.admin_plain_text_shown_across_the_site_leave_empty()}
          >
            <Textarea
              id="announcement"
              rows={4}
              maxLength={2000}
              value={announcement}
              onChange={(event) => setAnnouncement(event.target.value)}
            />
          </Field>
          <Field
            label={m.admin_disposable_email_domains()}
            htmlFor="blacklist"
            description={m.admin_one_domain_per_line_or_comma_separated_these()}
          >
            <Textarea
              id="blacklist"
              rows={8}
              value={blacklist}
              onChange={(event) => setBlacklist(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={m.admin_ai_free_failure_count()}
              htmlFor="free-failure-count"
              description={m.admin_ai_free_failure_count_description()}
            >
              <Input
                id="free-failure-count"
                type="number"
                min={0}
                max={1000}
                step={1}
                required
                value={freeFailureCount}
                onChange={(event) => setFreeFailureCount(event.target.value)}
              />
            </Field>
            <Field
              label={m.admin_ai_free_failure_window_minutes()}
              htmlFor="free-failure-window"
              description={m.admin_ai_free_failure_window_description()}
            >
              <Input
                id="free-failure-window"
                type="number"
                min={1}
                max={10080}
                step={1}
                required
                value={freeFailureMinutes}
                onChange={(event) => setFreeFailureMinutes(event.target.value)}
              />
            </Field>
          </div>
          <section className="grid gap-4" aria-label={m.admin_daily_credits_settings()}>
            <h2 className="font-semibold">{m.admin_daily_credits_settings()}</h2>
            <p className="text-muted-foreground text-sm">
              {m.admin_daily_credits_template_switch_note()}
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={m.admin_daily_credits_amount()} htmlFor="daily-amount">
                <Input
                  id="daily-amount"
                  type="number"
                  min={1}
                  max={2147483647}
                  step={1}
                  required
                  value={dailyAmount}
                  onChange={(event) => setDailyAmount(event.target.value)}
                />
              </Field>
              <Field label={m.admin_daily_credits_max_days()} htmlFor="daily-max-days">
                <Input
                  id="daily-max-days"
                  type="number"
                  min={1}
                  max={31}
                  step={1}
                  required
                  value={dailyMaxDays}
                  onChange={(event) => setDailyMaxDays(event.target.value)}
                />
              </Field>
              <Field label={m.admin_daily_credits_expiry_days()} htmlFor="daily-expiry-days">
                <Input
                  id="daily-expiry-days"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  required
                  value={dailyExpiryDays}
                  onChange={(event) => setDailyExpiryDays(event.target.value)}
                />
              </Field>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="daily-verified-email" className="font-normal text-sm leading-normal">
                <Checkbox
                  id="daily-verified-email"
                  checked={dailyVerifiedEmail}
                  onCheckedChange={setDailyVerifiedEmail}
                />
                {m.admin_daily_credits_require_verified_email()}
              </Label>
              <p className="text-muted-foreground text-sm">
                {m.admin_daily_credits_unverified_email_warning()}
              </p>
            </div>
          </section>
          <Button type="submit" className="w-fit">
            {m.admin_save_settings()}
          </Button>
        </fieldset>
      </form>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <OperationsSettingsForm />
    </AdminPage>
  )
}
