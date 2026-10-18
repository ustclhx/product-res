import { DataTable } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminPurchases } from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/purchases')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminPurchases({ data: deps }),
  component: List,
})
function List() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title={m.admin_one_time_purchases()}>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_one_time_purchases()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: m.admin_id(), cell: (row) => row.id },
          { id: 'workspace', header: m.admin_workspace(), cell: (row) => row.workspaceId },
          { id: 'provider', header: m.admin_provider(), cell: (row) => row.provider },
          { id: 'status', header: m.admin_status(), cell: (row) => row.status },
          {
            id: 'amount',
            header: m.admin_payment_amount(),
            cell: (row) => adminMoney(row.amount, row.currency),
          },
          {
            id: 'paid',
            header: m.admin_paid_at(),
            cell: (row) => (row.paidAt ? new Date(row.paidAt).toLocaleString() : '—'),
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
