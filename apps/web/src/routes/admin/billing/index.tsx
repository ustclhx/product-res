import { DataTable } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminBilling } from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminBilling({ data: deps }),
  errorComponent: () => <p role="alert">{m.admin_billing_data_is_unavailable_please_reload()}</p>,
  component: BillingAdmin,
})
function BillingAdmin() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title={m.admin_billing_administration()}>
      <div className="grid gap-2 rounded-lg border bg-card p-4 text-sm">
        <p>
          <span className="text-muted-foreground">{m.admin_payment_mode()}</span>{' '}
          <span className="font-medium">{data.mode}</span>
        </p>
        <ul className="grid gap-1">
          {data.readiness.map((item) => (
            <li key={item.id} className="break-words">
              {item.id}:{' '}
              <span className={item.available ? 'text-success' : 'text-muted-foreground'}>
                {item.available
                  ? m.admin_configured()
                  : m.admin_unavailable_provider_is_not_configured()}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_payments()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'workspace', header: m.admin_workspace(), cell: (row) => row.workspaceId },
          { id: 'provider', header: m.admin_provider(), cell: (row) => row.provider },
          {
            id: 'amount',
            header: m.admin_payment_amount(),
            cell: (row) => adminMoney(row.amount, row.currency),
          },
          {
            id: 'refunded',
            header: m.admin_refunded(),
            cell: (row) => adminMoney(row.refundedAmount, row.currency),
          },
          { id: 'status', header: m.admin_status(), cell: (row) => row.status },
          { id: 'kind', header: m.admin_kind(), cell: (row) => row.kind },
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
