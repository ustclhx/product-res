import { DataTable } from '@product-res/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getAdminAuditLogs } from '../../features/admin/audit.functions.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import { AdminPage, adminTableLabels } from '../../features/admin/ui.tsx'
import { m } from '../../paraglide/messages.js'

const filters = ['actor', 'workspaceId', 'action', 'from', 'to'] as const
export const Route = createFileRoute('/admin/audit')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(filters)(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminAuditLogs({ data: deps }),
  component: Audit,
})
function Audit() {
  // SSR 按钮在水合完成前不可交互，避免首次点击丢失。
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage
      title={m.admin_audit_log()}
      description={m.admin_dates_use_utc_and_include_both_selected_days()}
    >
      <fieldset disabled={!ready} className="min-w-0">
        <DataTable
          labels={adminTableLabels()}
          label={m.admin_audit_log()}
          rows={data.rows}
          getRowId={(row) => row.log.id}
          columns={[
            {
              id: 'at',
              header: m.admin_time_utc(),
              cell: ({ log }) => log.createdAt.toISOString(),
            },
            {
              id: 'actor',
              header: m.admin_actor(),
              cell: ({ log, actorEmail }) => (
                <span>
                  {actorEmail ?? log.actorUserId ?? m.admin_system()}
                  <br />
                  {log.actorUserId}
                </span>
              ),
            },
            { id: 'space', header: m.admin_workspace(), cell: ({ log }) => log.workspaceId ?? '—' },
            { id: 'action', header: m.admin_action(), cell: ({ log }) => log.action },
            {
              id: 'target',
              header: m.admin_target(),
              cell: ({ log }) => `${log.targetType ?? ''} ${log.targetId ?? ''}`,
            },
            { id: 'ip', header: m.admin_source_ip(), cell: ({ log }) => log.ip ?? '—' },
            {
              id: 'meta',
              header: m.admin_details(),
              cell: ({ log }) => (
                <details>
                  <summary>{m.admin_view_details()}</summary>
                  <pre className="max-w-sm whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(log.meta, null, 2)}
                  </pre>
                </details>
              ),
            },
          ]}
          page={adminListPage(search.offset, data)}
          filters={[
            {
              id: 'actor',
              label: m.admin_actor(),
              placeholder: m.admin_user_id_or_email_actual_admin_id(),
            },
            { id: 'workspaceId', label: m.admin_workspace_id() },
            { id: 'action', label: m.admin_action() },
            { id: 'from', label: m.admin_from_utc(), placeholder: 'YYYY-MM-DD' },
            { id: 'to', label: m.admin_to_utc(), placeholder: 'YYYY-MM-DD' },
          ]}
          filterValues={{
            actor: search.actor,
            workspaceId: search.workspaceId,
            action: search.action,
            from: search.from,
            to: search.to,
          }}
          onPageChange={(page) =>
            void navigate({ search: { ...search, offset: offsetOfPage(page) } })
          }
          onFiltersChange={(values) => void navigate({ search: filtersToSearch(filters, values) })}
        />
      </fieldset>
    </AdminPage>
  )
}
