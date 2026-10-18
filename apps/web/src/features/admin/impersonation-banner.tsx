import { Button } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { stopAdminImpersonation } from './impersonation.functions.ts'

export function ImpersonationBanner({
  viewer,
}: {
  viewer: { userEmail: string; adminEmail: string } | null
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!viewer) return null
  async function stop() {
    setBusy(true)
    try {
      await stopAdminImpersonation()
      window.location.assign('/admin/users?offset=0')
    } catch {
      setError(m.admin_unable_to_stop_impersonating_please_retry())
      setBusy(false)
    }
  }
  return (
    <aside
      role="status"
      aria-label={m.admin_impersonation()}
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b bg-amber-100 p-3 text-amber-950"
    >
      <span>
        {m.admin_impersonating_administrator_sensitive_actions_are_disabled({
          userEmail: viewer.userEmail,
          adminEmail: viewer.adminEmail,
        })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!ready || busy}
        className="border-amber-900/30 bg-amber-50 text-amber-950 hover:bg-amber-200"
        onClick={() => void stop()}
      >
        {m.admin_stop_impersonating()}
      </Button>
      {error && <span role="alert">{error}</span>}
    </aside>
  )
}
