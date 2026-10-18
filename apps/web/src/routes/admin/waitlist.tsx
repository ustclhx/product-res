import { Button, DataTable } from '@product-res/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ADMIN_PAGE_SIZE, adminListPage, adminListSearch } from '../../features/admin/list.ts'
import { AdminPage, adminTableLabels, formatDateTime } from '../../features/admin/ui.tsx'
import { getAdminWaitlist, inviteAdminWaitlist } from '../../features/growth/growth.functions.ts'
import { m } from '../../paraglide/messages.js'
export const Route = createFileRoute('/admin/waitlist')({
  validateSearch: (search) => ({ offset: adminListSearch([])(search).offset }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminWaitlist({ data: deps }),
  component: WaitlistAdmin,
})
function WaitlistAdmin() {
  const data = Route.useLoaderData()
  const { offset } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return (
    <AdminPage title={m.admin_waitlist()}>
      <Button
        className="w-fit"
        disabled={busy || selected.length === 0}
        onClick={async () => {
          setBusy(true)
          try {
            const result = await inviteAdminWaitlist({ data: { ids: selected } })
            setMessage(m.admin_invitations_queued({ count: result.count }))
            setSelected([])
            await router.invalidate()
          } catch {
            setMessage(m.admin_invitations_could_not_all_be_queued_select_the())
          } finally {
            setBusy(false)
          }
        }}
      >
        {m.admin_invite_selected({ count: selected.length })}
      </Button>
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_waitlist()}
        rows={data.rows}
        getRowId={(row) => row.id}
        page={adminListPage(offset, data)}
        onPageChange={(page) => {
          setSelected([])
          void navigate({ search: { offset: page * ADMIN_PAGE_SIZE } })
        }}
        columns={[
          {
            id: 'select',
            header: m.admin_select(),
            cell: (row) => (
              <input
                aria-label={m.admin_select_email({ email: row.email })}
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.includes(row.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id),
                  )
                }
              />
            ),
          },
          { id: 'email', header: m.admin_email(), cell: (row) => row.email },
          { id: 'created', header: m.admin_joined(), cell: (row) => formatDateTime(row.createdAt) },
          {
            id: 'invited',
            header: m.admin_invited(),
            cell: (row) =>
              row.invitedAt ? formatDateTime(row.invitedAt) : m.admin_awaiting_invitation(),
          },
        ]}
      />
    </AdminPage>
  )
}
