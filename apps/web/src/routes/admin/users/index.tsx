import { DataTable } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../../features/admin/ui.tsx'
import { getAdminUsers } from '../../../features/admin/users.functions.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/admin/users/')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminUsers({ data: deps }),
  component: Users,
})
function Users() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title={m.admin_users()}>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_users()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'email',
            header: m.admin_email(),
            cell: (row) => (
              <Link to="/admin/users/$id" params={{ id: row.id }} className="underline">
                {row.email}
              </Link>
            ),
          },
          { id: 'name', header: m.admin_name(), cell: (row) => row.name },
          { id: 'id', header: m.admin_id(), cell: (row) => row.id },
          { id: 'role', header: m.admin_role(), cell: (row) => row.role ?? 'user' },
          {
            id: 'ban',
            header: m.admin_ban_status(),
            cell: (row) => (row.banned ? m.admin_banned() : m.admin_active()),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[
          { id: 'q', label: m.admin_search_users(), placeholder: m.admin_email_name_or_id() },
        ]}
        filterValues={{ q: search.q }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) => void navigate({ search: filtersToSearch(['q'], values) })}
      />
    </AdminPage>
  )
}
