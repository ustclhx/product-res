import { DataTable } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminWorkspaces } from '../../../features/admin/workspaces.functions.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/admin/workspaces/')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q', 'status'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    getAdminWorkspaces({
      data: {
        ...deps,
        status: deps.status === 'active' || deps.status === 'deleted' ? deps.status : undefined,
      },
    }),
  component: Workspaces,
})
function Workspaces() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title={m.admin_workspaces()}>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_workspaces()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'name',
            header: m.admin_name(),
            cell: (row) => (
              <Link to="/admin/workspaces/$id" params={{ id: row.id }} className="underline">
                {row.name}
              </Link>
            ),
          },
          { id: 'id', header: m.admin_id(), cell: (row) => row.id },
          { id: 'slug', header: m.admin_slug(), cell: (row) => row.slug },
          {
            id: 'kind',
            header: m.admin_type(),
            cell: (row) => (row.isPersonal ? m.admin_personal() : m.admin_team()),
          },
          {
            id: 'status',
            header: m.admin_status(),
            cell: (row) => (row.deletedAt ? m.admin_deleted() : m.admin_active()),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filterValues={{ q: search.q, status: search.status }}
        filters={[
          { id: 'q', label: m.admin_search_workspaces(), placeholder: m.admin_name_slug_or_id() },
          {
            id: 'status',
            label: m.admin_status(),
            type: 'select',
            options: [
              { value: '', label: m.admin_all() },
              { value: 'active', label: m.admin_active() },
              { value: 'deleted', label: m.admin_deleted() },
            ],
          },
        ]}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['q', 'status'], values) })
        }
      />
    </AdminPage>
  )
}
