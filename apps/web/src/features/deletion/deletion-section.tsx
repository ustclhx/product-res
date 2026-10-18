import { useEffect, useState } from 'react'
import { authClient } from '../auth/auth-client.ts'
import { removeAccount, removeWorkspace } from './deletion.functions.ts'

export function DeletionSection({
  workspace,
  supportEmail,
  refundReminder,
}: {
  workspace?: { id: string; name: string }
  supportEmail: string
  refundReminder?: { eligibleCount: number; pendingCount: number; billingHref: string }
}) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(false)
  const [blocked, setBlocked] = useState<{ id: string; name: string; slug: string }[]>([])
  const label = workspace ? workspace.name : 'DELETE'
  async function submit() {
    setBusy(true)
    setError('')
    try {
      const result = workspace
        ? await removeWorkspace({ data: { workspaceId: workspace.id } })
        : await removeAccount()
      if (result.ok) {
        window.location.assign(workspace ? '/app' : '/login')
        return
      }
      setCompleted(result.deletionCompleted)
      setError(
        result.deletionCompleted
          ? 'Deletion completed. Access has been removed; cached credentials are awaiting automatic cleanup.'
          : result.message,
      )
      setBlocked(result.workspaces)
    } catch {
      setError('Deletion could not be completed. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  async function signInAgain() {
    setBusy(true)
    try {
      const result = await authClient().signOut()
      if (result.error) throw new Error(result.error.message)
      window.location.assign('/login?redirect=%2Faccount')
    } catch {
      setError('Could not sign out. Please try again before signing in.')
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-3 rounded-lg border border-destructive p-6">
      <h2 className="font-semibold text-xl">
        {workspace ? 'Delete team workspace' : 'Delete account'}
      </h2>
      <p>
        {workspace
          ? 'All members will lose access immediately. Workspace content is retained for 30 days before cleanup.'
          : 'Your personal workspace will be deleted and your identity and sign-in credentials removed. Sign out and sign in again within ten minutes before deleting.'}
      </p>
      <p>
        Deletion cancels subscriptions immediately without issuing a refund. Review refundable
        payments before deleting; pending requests remain reviewable using their saved contact
        email.
        <a className="underline" href={`mailto:${supportEmail}`}>
          contact support
        </a>{' '}
        before deleting if you need help with a payment.
      </p>
      {refundReminder && (
        <p>
          {refundReminder.eligibleCount} payments in the refund window;{' '}
          {refundReminder.pendingCount} pending requests.{' '}
          <a className="underline" href={refundReminder.billingHref}>
            Review billing and refund requests
          </a>
        </p>
      )}
      {!workspace && (
        <button
          type="button"
          className="underline text-left"
          disabled={!hydrated || busy || completed}
          onClick={signInAgain}
        >
          Sign out and sign in again
        </button>
      )}
      <label className="grid gap-2">
        Type {label} to confirm
        <input
          className="rounded border p-2"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          disabled={!hydrated || busy || completed}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {completed && (
        <a className="underline" href={workspace ? '/app' : '/login'}>
          Continue
        </a>
      )}
      {blocked.length > 0 && (
        <ul>
          {blocked.map((item) => (
            <li key={item.id}>
              <a className="underline" href={`/app/${item.slug}`}>
                {item.name}
              </a>
              : transfer ownership or delete this team first.
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="rounded bg-destructive p-2 text-destructive-foreground disabled:opacity-50"
        disabled={!hydrated || busy || completed || confirmation !== label}
        onClick={() => void submit()}
      >
        {busy ? 'Deleting…' : workspace ? 'Delete workspace' : 'Delete account'}
      </button>
    </section>
  )
}
