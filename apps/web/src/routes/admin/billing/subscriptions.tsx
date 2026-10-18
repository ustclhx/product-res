import { DataTable } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminSubscriptions } from '../../../features/billing/admin.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/subscriptions')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminSubscriptions({ data: deps }),
  component: List,
})
function List() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title={m.admin_subscriptions()}>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_subscriptions()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: m.admin_id(), cell: (row) => row.id },
          { id: 'workspace', header: m.admin_workspace(), cell: (row) => row.workspaceId },
          { id: 'provider', header: m.admin_provider(), cell: (row) => row.provider },
          { id: 'status', header: m.admin_status(), cell: (row) => row.status },
          {
            id: 'cancel',
            header: m.admin_cancellation(),
            cell: (row) =>
              row.cancelAtPeriodEnd ? m.admin_at_period_end() : m.admin_none_scheduled(),
          },
          {
            id: 'start',
            header: m.admin_period_start(),
            cell: (row) =>
              row.currentPeriodStart ? new Date(row.currentPeriodStart).toLocaleString() : '—',
          },
          {
            id: 'end',
            header: m.admin_period_end(),
            cell: (row) =>
              row.currentPeriodEnd ? new Date(row.currentPeriodEnd).toLocaleString() : '—',
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
