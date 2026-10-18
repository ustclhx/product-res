import { Button } from '@product-res/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { getAdminSettings, saveAdminSettings } from '../../features/admin/settings.functions.ts'
import { OperationsSettingsForm } from '../../features/admin/settings-operations-form.tsx'
import { AdminPage, CheckboxField, Field, panelClass, Textarea } from '../../features/admin/ui.tsx'
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
          announcement,
          signupBonusDomainBlacklist: blacklist
            .split(/[\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
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
            <CheckboxField
              label={m.admin_registration_enabled()}
              checked={signupEnabled}
              onChange={(event) => setSignupEnabled(event.target.checked)}
            />
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
