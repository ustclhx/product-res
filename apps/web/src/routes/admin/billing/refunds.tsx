import { Button, DataTable, Input } from '@product-res/ui'
import {
  createFileRoute,
  notFound as featureNotFound,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import {
  AdminPage,
  adminTableLabels,
  Field,
  panelClass,
  Textarea,
} from '../../../features/admin/ui.tsx'
import {
  completeAdminRefund,
  getAdminRefunds,
  retryAdminRefundEmail,
  reviewAdminRefund,
} from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/refunds')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminRefunds({ data: deps }),
  errorComponent: () => <p role="alert">{m.admin_refund_data_is_unavailable_please_reload()}</p>,
  component: Refunds,
})
function Refunds() {
  const { rows, hasMore } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage
      title={m.admin_refund_reviews()}
      description={
        <>
          {m.admin_original_and_remaining_credits_include_held_or_revoked()} <br />
          {m.admin_a_full_refund_revokes_all_remaining_credits_for()}
        </>
      }
    >
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_refund_requests()}
        rows={rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'review', header: m.admin_refund_review(), cell: (row) => <Refund row={row} /> },
        ]}
        page={adminListPage(search.offset, { hasMore })}
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
type RefundRow = Awaited<ReturnType<typeof getAdminRefunds>>['rows'][number]
function Refund({ row }: { row: RefundRow }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [cents, setCents] = useState('')
  const [refundId, setRefundId] = useState('')
  const [proof, setProof] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function act(
    action: () => Promise<{ ok: true; status: string } | { ok: false; error: string }>,
  ) {
    setBusy(true)
    try {
      const result = await action()
      setMessage(
        result.ok
          ? result.status
          : m.admin_action_unavailable_the_decision_may_already_be_saved({ error: result.error }),
      )
      await router.invalidate()
    } catch {
      setMessage(m.admin_action_unavailable_reload_to_check_saved_status_before())
    } finally {
      setBusy(false)
    }
  }
  function review(decision: 'approve' | 'reject', approvedAmount?: number) {
    return act(() =>
      reviewAdminRefund({
        data: {
          requestId: row.id,
          decision,
          reviewNote: note,
          ...(approvedAmount === undefined ? {} : { approvedAmount }),
        },
      }),
    )
  }
  return (
    <article aria-label={m.admin_refund({ id: row.id })} className="grid min-w-0 gap-3 py-2">
      <h3 className="break-all font-semibold">
        {m.admin_refund_label()} {row.id}
      </h3>
      <div className="grid gap-1 break-words text-sm">
        <p>
          {m.admin_workspace_label()}{' '}
          <Link to="/admin/workspaces/$id" params={{ id: row.workspaceId }} className="underline">
            {row.workspaceId}
          </Link>{' '}
          · {row.provider} {m.admin_status_inline()} {row.status}
        </p>
        <p>
          {m.admin_reason_label()} {row.reason}
        </p>
        <p>
          {m.admin_requested()}{' '}
          {row.requestedAmount === null
            ? m.admin_full_remaining_payment()
            : adminMoney(row.requestedAmount, row.currency)}{' '}
          {m.admin_remaining_refundable()} {adminMoney(row.remainingRefundable, row.currency)}
        </p>
        <p>
          {m.admin_approved()}{' '}
          {row.approvedAmount === null
            ? m.admin_none()
            : adminMoney(row.approvedAmount, row.currency)}{' '}
          {m.admin_review_note()} {row.reviewNote || m.admin_none()}
        </p>
        <p>
          {m.admin_original_credits()} {row.originalCredits} {m.admin_remaining_credits()}{' '}
          {row.remainingCredits}
        </p>
      </div>
      {!row.providerAvailable && (
        <p className="text-muted-foreground text-sm">
          {m.admin_provider_not_configured_approval_manual_completion_and_api()}
        </p>
      )}
      {row.status === 'pending' && (
        <fieldset disabled={busy} className={panelClass('default', 'max-w-2xl')}>
          <legend className="px-1 font-medium text-sm">{m.admin_review_decision()}</legend>
          <Field label={m.admin_review_note_field()} htmlFor={`${row.id}-note`}>
            <Textarea
              id={`${row.id}-note`}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Button
              type="button"
              disabled={!row.providerAvailable || row.remainingRefundable <= 0}
              onClick={() => review('approve')}
            >
              {m.admin_approve_full_refund()}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!note.trim()}
              onClick={() => review('reject')}
            >
              {m.admin_reject_refund()}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={m.admin_partial_amount_usd_cents()} htmlFor={`${row.id}-cents`}>
              <Input
                id={`${row.id}-cents`}
                className="w-48"
                type="number"
                min="1"
                max={row.remainingRefundable}
                step="1"
                value={cents}
                onChange={(event) => setCents(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={
                !row.providerAvailable ||
                !Number.isInteger(Number(cents)) ||
                Number(cents) <= 0 ||
                Number(cents) >= row.remainingRefundable
              }
              onClick={() => review('approve', Number(cents))}
            >
              {m.admin_approve_partial_refund()}
            </Button>
          </div>
        </fieldset>
      )}
      {row.status === 'approved' && row.providerAvailable && !row.manualAvailable && (
        <Button
          type="button"
          className="w-fit"
          disabled={busy}
          onClick={() =>
            act(() =>
              reviewAdminRefund({
                data: {
                  requestId: row.id,
                  decision: 'approve',
                  reviewNote: row.reviewNote ?? '',
                  ...(row.approvedAmount === null ? {} : { approvedAmount: row.approvedAmount }),
                },
              }),
            )
          }
        >
          {m.admin_retry_approved_refund_api()}
        </Button>
      )}
      {row.status === 'approved' && row.manualAvailable && (
        <fieldset disabled={busy} className={panelClass('default', 'max-w-2xl')}>
          <legend className="px-1 font-medium text-sm">
            {m.admin_manual_platform_completion()}
          </legend>
          <Field label={m.admin_platform_refund_id()} htmlFor={`${row.id}-refund-id`}>
            <Input
              id={`${row.id}-refund-id`}
              value={refundId}
              maxLength={2000}
              onChange={(event) => setRefundId(event.target.value)}
            />
          </Field>
          <Field label={m.admin_platform_proof()} htmlFor={`${row.id}-proof`}>
            <Textarea
              id={`${row.id}-proof`}
              value={proof}
              maxLength={2000}
              onChange={(event) => setProof(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            className="w-fit"
            disabled={!refundId.trim() || !proof.trim()}
            onClick={() =>
              act(() =>
                completeAdminRefund({
                  data: { requestId: row.id, providerRefundId: refundId, proof },
                }),
              )
            }
          >
            {m.admin_mark_manual_refund_complete()}
          </Button>
        </fieldset>
      )}
      {row.status !== 'pending' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() => act(() => retryAdminRefundEmail({ data: { requestId: row.id } }))}
        >
          {m.admin_retry_refund_email()}
        </Button>
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
    </article>
  )
}
