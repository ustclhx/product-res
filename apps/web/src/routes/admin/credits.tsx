import { newId } from '@product-res/shared'
import { Button, DataTable, Input } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { adjustCredits, getAdminCredits } from '../../features/admin/credits.functions.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import {
  AdminPage,
  adminTableLabels,
  Field,
  formatDateTime,
  Panel,
  Textarea,
} from '../../features/admin/ui.tsx'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'

export const Route = createFileRoute('/admin/credits')({
  beforeLoad: () => {
    if (!templateConfig.credits.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminCredits({ data: deps }),
  component: Credits,
})
function Credits() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [reason, setReason] = useState('')
  const [adjustmentId, setAdjustmentId] = useState(newId)
  const [pending, setPending] = useState<Parameters<typeof adjustCredits>[0]['data'] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(input: Parameters<typeof adjustCredits>[0]['data']) {
    setPending(input)
    setBusy(true)
    try {
      const result = await adjustCredits({ data: input })
      if (result.ok) {
        setMessage(
          result.replayed ? m.admin_adjustment_already_applied() : m.admin_adjustment_applied(),
        )
        setPending(null)
        setAdjustmentId(newId())
        setReason('')
      } else {
        setMessage(m.admin_adjustment_unavailable({ error: result.error }))
        setPending(null)
        setAdjustmentId(newId())
      }
      await router.invalidate()
    } catch {
      setMessage(m.admin_request_failed_retry_the_same_adjustment_to_check())
    } finally {
      setBusy(false)
    }
  }
  return (
    <AdminPage
      title={m.admin_credit_adjustments()}
      description={m.admin_grant_or_revoke_credits_for_one_workspace_filter()}
    >
      {data.balance && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{m.admin_available()}</dt>
            <dd className="font-medium">{data.balance.available}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{m.admin_held()}</dt>
            <dd className="font-medium">{data.balance.held}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">{m.admin_debt()}</dt>
            <dd className="font-medium">{data.balance.debt}</dd>
          </div>
        </dl>
      )}
      {pending ? (
        <Button
          type="button"
          className="w-fit"
          disabled={busy}
          onClick={() => void submit(pending)}
        >
          {m.admin_retry_same_adjustment()}
        </Button>
      ) : (
        <Panel className="max-w-2xl">
          <fieldset disabled={busy || !search.workspaceId} className="grid min-w-0 gap-4">
            <legend className="mb-3 font-semibold">{m.admin_add_credits()}</legend>
            {!search.workspaceId && (
              <p className="text-muted-foreground text-sm">
                {m.admin_enter_a_workspace_id_in_the_filter_below()}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={m.admin_amount()} htmlFor="credit-amount">
                <Input
                  id="credit-amount"
                  type="number"
                  min="1"
                  step="1"
                  max="2147483647"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </Field>
              <Field label={m.admin_expiration_optional()} htmlFor="credit-expires">
                <Input
                  id="credit-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </Field>
            </div>
            <Field
              label={m.admin_reason()}
              htmlFor="credit-reason"
              description={m.admin_required_for_grants_and_for_revoking_a_batch()}
            >
              <Textarea
                id="credit-reason"
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={
                !reason.trim() ||
                !Number.isInteger(Number(amount)) ||
                Number(amount) <= 0 ||
                Number(amount) > 2_147_483_647
              }
              onClick={() => {
                if (search.workspaceId)
                  void submit({
                    kind: 'grant',
                    adjustmentId,
                    workspaceId: search.workspaceId,
                    amount: Number(amount),
                    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                    reason,
                  })
              }}
            >
              {m.admin_add_credits()}
            </Button>
          </fieldset>
        </Panel>
      )}
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_credit_batches()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: m.admin_batch(), cell: (row) => row.id },
          { id: 'source', header: m.admin_source(), cell: (row) => row.source },
          {
            id: 'amount',
            header: m.admin_amount_remaining(),
            cell: (row) => `${row.amount} / ${row.remaining}`,
          },
          {
            id: 'expiration',
            header: m.admin_expiration(),
            cell: (row) => (row.expiresAt ? formatDateTime(row.expiresAt) : m.admin_never()),
          },
          { id: 'status', header: m.admin_status(), cell: (row) => row.status },
          {
            id: 'revoke',
            header: m.admin_revoke_remaining(),
            cell: (row) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || Boolean(pending) || !reason.trim() || row.status !== 'active'}
                onClick={() => {
                  if (
                    window.confirm(m.admin_revoke_remaining_credits_in_batch({ batchId: row.id }))
                  )
                    void submit({
                      kind: 'revoke',
                      adjustmentId,
                      workspaceId: row.workspaceId,
                      grantId: row.id,
                      reason,
                    })
                }}
              >
                {m.admin_revoke_batch()}
              </Button>
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
