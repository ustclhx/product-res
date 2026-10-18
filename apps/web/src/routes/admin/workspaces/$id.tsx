import { Button, DetailList } from '@product-res/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ADMIN_COPY } from '../../../features/admin/copy.ts'
import {
  AdminPage,
  AdminSection,
  CheckboxField,
  EmptyState,
  formatDateTime,
  panelClass,
} from '../../../features/admin/ui.tsx'
import {
  getAdminWorkspace,
  getAdminWorkspaceCredits,
  restoreAdminWorkspace,
} from '../../../features/admin/workspaces.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/workspaces/$id')({
  loader: ({ params }) => getAdminWorkspace({ data: { id: params.id } }),
  component: WorkspaceDetail,
})
function WorkspaceDetail() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [confirmed, setConfirmed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [batches, setBatches] = useState(data.batches)
  const [ledger, setLedger] = useState(data.ledger)
  async function restore() {
    setBusy(true)
    try {
      const result = await restoreAdminWorkspace({ data: { id: data.workspace.id } })
      setMessage(
        result.ok
          ? m.admin_workspace_restored_original_owners_can_access_it_again()
          : `${result.message} (${result.code})`,
      )
      await router.invalidate()
    } catch {
      setMessage(m.admin_restore_failed_reload_to_check_the_current_state())
    } finally {
      setBusy(false)
    }
  }
  async function more(kind: 'batches' | 'ledger') {
    const cursor = (kind === 'batches' ? batches : ledger).nextCursor
    if (!cursor) return
    setBusy(true)
    try {
      const page = await getAdminWorkspaceCredits({ data: { id: data.workspace.id, kind, cursor } })
      if (kind === 'batches') setBatches(page as typeof batches)
      else setLedger(page as typeof ledger)
    } catch {
      setMessage(m.admin_credit_history_is_unavailable_please_retry())
    } finally {
      setBusy(false)
    }
  }
  function overlaps(index: number) {
    const current = data.subscriptions[index]?.subscription
    if (!current?.currentPeriodStart || !current.currentPeriodEnd) return false
    const start = current.currentPeriodStart
    const end = current.currentPeriodEnd
    return data.subscriptions.some(
      ({ subscription: other }, i) =>
        i !== index &&
        other.currentPeriodStart &&
        other.currentPeriodEnd &&
        start < other.currentPeriodEnd &&
        other.currentPeriodStart < end,
    )
  }
  return (
    <AdminPage
      title={m.admin_workspace_details()}
      actions={
        <>
          {templateConfig.credits.enabled && (
            <Button asChild size="sm">
              <Link to="/admin/credits" search={{ offset: 0, workspaceId: data.workspace.id }}>
                {ADMIN_COPY.adjustCredits}
              </Link>
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/workspaces" search={{ offset: 0 }}>
              {m.admin_back_to_workspaces()}
            </Link>
          </Button>
        </>
      }
    >
      <DetailList
        fields={[
          { label: m.admin_name(), value: data.workspace.name },
          { label: m.admin_id(), value: data.workspace.id },
          { label: m.admin_slug(), value: data.workspace.slug },
          {
            label: m.admin_status(),
            value: data.workspace.deletedAt ? m.admin_deleted() : m.admin_active(),
          },
          {
            label: m.admin_deleted_at(),
            value: data.workspace.deletedAt ? formatDateTime(data.workspace.deletedAt) : null,
          },
          ...(data.entitlements
            ? [{ label: m.admin_entitlement_plan(), value: data.entitlements.key }]
            : []),
          ...(data.balance
            ? [
                { label: m.admin_available_credits(), value: data.balance.available },
                { label: m.admin_held_credits(), value: data.balance.held },
                { label: m.admin_credit_debt(), value: data.balance.debt },
              ]
            : []),
        ]}
      />
      {data.workspace.deletedAt && (
        <div className={panelClass('danger', 'max-w-xl')}>
          <p className="text-sm">{m.admin_restore_within_the_30_day_retention_period_only()} </p>
          <CheckboxField
            label={m.admin_i_confirm_restoring_this_workspace()}
            disabled={!ready}
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <Button
            className="w-fit"
            disabled={!ready || busy || !confirmed}
            onClick={() => void restore()}
          >
            {m.admin_restore_workspace()}
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <AdminSection title={m.admin_members()}>
        {data.members.length ? (
          <ul className="grid gap-2">
            {data.members.map((m) => (
              <li key={m.id} className="break-all rounded-md border px-3 py-2 text-sm">
                <Link to="/admin/users/$id" params={{ id: m.userId }} className="underline">
                  {m.email}
                </Link>{' '}
                · {m.role}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState />
        )}
      </AdminSection>
      {data.entitlements && (
        <AdminSection title={m.admin_subscriptions_and_overlapping_periods()}>
          <p className="text-muted-foreground text-sm">
            {m.admin_all_subscription_periods_are_shown_effective_entitlements_use()}
          </p>
          {data.subscriptions.length ? (
            <ul className="grid gap-2">
              {data.subscriptions.map(({ subscription: sub, planName }, index) => (
                <li key={sub.id} className="break-words rounded-md border px-3 py-2 text-sm">
                  {planName} · {sub.provider} · {sub.status} · {sub.id}
                  <br />
                  {m.admin_period()}{' '}
                  {sub.currentPeriodStart
                    ? formatDateTime(sub.currentPeriodStart)
                    : m.admin_unconfirmed()}{' '}
                  —{' '}
                  {sub.currentPeriodEnd
                    ? formatDateTime(sub.currentPeriodEnd)
                    : m.admin_unconfirmed()}
                  {overlaps(index) && <strong> {m.admin_overlapping_period()}</strong>}
                  {sub.pastDueSince && (
                    <p>
                      {m.admin_past_due_since()} {formatDateTime(sub.pastDueSince)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState />
          )}
        </AdminSection>
      )}
      {data.balance && (
        <>
          <AdminSection title={m.admin_credit_batches()}>
            {batches.items.length ? (
              <ul className="grid gap-2">
                {batches.items.map((batch) => (
                  <li key={batch.id} className="break-words rounded-md border px-3 py-2 text-sm">
                    {batch.id} · {batch.source} · {batch.status} {m.admin_remaining()}{' '}
                    {batch.remaining} / {batch.amount} {m.admin_expires()}{' '}
                    {batch.expiresAt ? formatDateTime(batch.expiresAt) : m.admin_never()}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )}
            {batches.nextCursor && (
              <Button
                className="w-fit"
                variant="outline"
                size="sm"
                disabled={!ready || busy}
                onClick={() => void more('batches')}
              >
                {m.admin_older_batches()}
              </Button>
            )}
          </AdminSection>
          <AdminSection title={m.admin_recent_credit_ledger()}>
            {ledger.items.length ? (
              <ul className="grid gap-2">
                {ledger.items.map((entry) => (
                  <li key={entry.id} className="break-words rounded-md border px-3 py-2 text-sm">
                    {formatDateTime(entry.createdAt)} · {entry.type} · {entry.delta} · {entry.id}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )}
            {ledger.nextCursor && (
              <Button
                className="w-fit"
                variant="outline"
                size="sm"
                disabled={!ready || busy}
                onClick={() => void more('ledger')}
              >
                {m.admin_older_ledger_entries()}
              </Button>
            )}
          </AdminSection>
        </>
      )}
    </AdminPage>
  )
}
