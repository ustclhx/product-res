import { Button, DataTable } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminWebhooks, replayAdminWebhook } from '../../../features/billing/admin.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/webhooks')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminWebhooks({ data: deps }),
  component: Webhooks,
})
function Webhooks() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function replay(id: string) {
    setBusy(true)
    try {
      const result = await replayAdminWebhook({ data: { webhookEventId: id } })
      setMessage(result.ok ? result.status : m.admin_replay_unavailable({ error: result.error }))
      await router.invalidate()
    } catch {
      setMessage(m.admin_replay_unavailable_reload_to_check_the_saved_record())
    } finally {
      setBusy(false)
    }
  }
  return (
    <AdminPage
      title={m.admin_webhook_events()}
      description={m.admin_events_without_an_associated_workspace_appear_only_when()}
    >
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_webhook_events()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'provider', header: m.admin_provider(), cell: (row) => row.provider },
          { id: 'event', header: m.admin_event(), cell: (row) => row.providerEventId },
          { id: 'type', header: m.admin_type(), cell: (row) => row.type },
          { id: 'status', header: m.admin_status(), cell: (row) => row.status },
          { id: 'attempts', header: m.admin_attempts_label(), cell: (row) => row.attempts },
          {
            id: 'replay',
            header: m.admin_replay(),
            cell: (row) =>
              row.status === 'failed' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !row.replayAvailable}
                  onClick={() => void replay(row.id)}
                >
                  {row.replayAvailable
                    ? m.admin_replay_failed_event()
                    : m.admin_replay_unavailable_provider_not_configured()}
                </Button>
              ) : (
                <span className="text-muted-foreground">
                  {m.admin_only_failed_events_can_be_replayed()}
                </span>
              ),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[{ id: 'workspaceId', label: m.admin_workspace_id() }]}
        filterValues={{ workspaceId: search.workspaceId }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['workspaceId'], values) })
        }
      />
    </AdminPage>
  )
}
