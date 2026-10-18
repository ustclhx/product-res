import { Button, DetailList, Input } from '@product-res/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ADMIN_COPY } from '../../../features/admin/copy.ts'
import {
  AdminPage,
  AdminSection,
  CheckboxField,
  EmptyState,
  Field,
  formatDateTime,
  panelClass,
} from '../../../features/admin/ui.tsx'
import {
  getAdminUser,
  setAdminUserBan,
  startAdminImpersonation,
} from '../../../features/admin/users.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/users/$id')({
  loader: ({ params }) => getAdminUser({ data: { id: params.id } }),
  component: UserDetail,
})
function UserDetail() {
  const data = Route.useLoaderData()
  const { admin } = Route.useRouteContext()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function action(impersonate = false) {
    setBusy(true)
    try {
      if (impersonate) {
        await startAdminImpersonation({ data: { userId: data.user.id } })
        window.location.assign('/app')
      } else {
        await setAdminUserBan({ data: { userId: data.user.id, banned: !data.user.banned, reason } })
        setMessage(data.user.banned ? m.admin_user_unbanned() : m.admin_user_banned())
        setConfirm(false)
        setReason('')
        await router.invalidate()
      }
    } catch {
      setMessage(m.admin_operation_failed_reload_to_check_the_current_state())
    } finally {
      setBusy(false)
    }
  }
  const isAdminUser = (data.user.role ?? '').split(',').some((role) => role.trim() === 'admin')
  return (
    <AdminPage
      title={m.admin_user_details()}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/admin/users" search={{ offset: 0 }}>
            {m.admin_back_to_users()}
          </Link>
        </Button>
      }
    >
      <DetailList
        fields={[
          { label: m.admin_email(), value: data.user.email },
          { label: m.admin_name(), value: data.user.name },
          { label: m.admin_id(), value: data.user.id },
          { label: m.admin_registered(), value: formatDateTime(data.user.createdAt) },
          { label: m.admin_login_methods(), value: data.methods.join(', ') || m.admin_none() },
          {
            label: m.admin_ban_status(),
            value: data.user.banned ? m.admin_banned() : m.admin_active(),
          },
          { label: m.admin_ban_reason(), value: data.user.banReason },
          {
            label: m.admin_ban_expires(),
            value: data.user.banExpires
              ? formatDateTime(data.user.banExpires)
              : m.admin_no_expiry(),
          },
        ]}
      />
      <AdminSection title={m.admin_workspaces()}>
        {data.workspaces.length ? (
          <ul className="grid gap-2">
            {data.workspaces.map((ws) => (
              <li
                key={ws.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-all">
                  <Link to="/admin/workspaces/$id" params={{ id: ws.id }} className="underline">
                    {ws.name}
                  </Link>{' '}
                  · {ws.role}
                </span>
                {templateConfig.credits.enabled && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/admin/credits"
                      search={{ offset: 0, workspaceId: ws.id }}
                      aria-label={`${ADMIN_COPY.adjustCredits}: ${ws.name}`}
                    >
                      {ADMIN_COPY.adjustCredits}
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState />
        )}
      </AdminSection>
      <AdminSection title={m.admin_impersonation()}>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={!ready || busy || isAdminUser || Boolean(data.user.banned)}
            onClick={() => void action(true)}
          >
            {m.admin_impersonate_user()}
          </Button>
          <p className="text-muted-foreground text-sm">
            {m.admin_administrators_and_banned_users_cannot_be_impersonated()}
          </p>
        </div>
      </AdminSection>
      <form
        className={panelClass('danger', 'max-w-xl')}
        aria-label={m.admin_ban_management()}
        onSubmit={(event) => {
          event.preventDefault()
          void action()
        }}
      >
        <div className="grid gap-1">
          <h3 className="font-semibold text-destructive text-lg">{m.admin_ban_management()}</h3>
          <p className="text-muted-foreground text-sm">
            {data.user.banned
              ? m.admin_restores_sign_in_for_this_user_the_reason()
              : m.admin_signs_the_user_out_and_blocks_sign_in()}
          </p>
        </div>
        <Field label={m.admin_reason()} htmlFor="ban-reason">
          <Input
            disabled={!ready}
            id="ban-reason"
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </Field>
        <CheckboxField
          label={m.admin_i_confirm_this_user_status_change()}
          disabled={!ready}
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        <Button
          type="submit"
          className="w-fit"
          variant={data.user.banned ? 'default' : 'destructive'}
          disabled={
            !ready ||
            busy ||
            !reason.trim() ||
            !confirm ||
            (!data.user.banned && data.user.id === admin.id)
          }
        >
          {data.user.banned ? m.admin_unban_user() : m.admin_ban_user()}
        </Button>
        {data.user.id === admin.id && (
          <p className="text-muted-foreground text-sm">{m.admin_you_cannot_ban_yourself()}</p>
        )}
      </form>
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
    </AdminPage>
  )
}
