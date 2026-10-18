import { Button, Input, Label } from '@product-res/ui'
import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { adminListSearch } from '../../features/admin/list.ts'
import { getAdminMetrics } from '../../features/admin/metrics.functions.ts'
import { AdminPage, EmptyState } from '../../features/admin/ui.tsx'
import { m } from '../../paraglide/messages.js'

export const Route = createFileRoute('/admin/metrics')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['from', 'to'])(search),
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  loader: ({ deps }) => getAdminMetrics({ data: deps }),
  component: Metrics,
})
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
function Metrics() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const data = Route.useLoaderData()
  const navigate = Route.useNavigate()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    void navigate({
      search: { offset: 0, from: String(values.get('from')), to: String(values.get('to')) },
    })
  }
  return (
    <AdminPage title={m.admin_business_metrics()}>
      <fieldset disabled={!ready} className="min-w-0">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor="metrics-from">{m.admin_from_utc()}</Label>
            <Input
              key={data.from}
              id="metrics-from"
              name="from"
              type="date"
              defaultValue={data.from}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="metrics-to">{m.admin_to_utc()}</Label>
            <Input
              key={data.to}
              id="metrics-to"
              name="to"
              type="date"
              defaultValue={data.to}
              required
            />
          </div>
          <Button type="submit">{m.admin_apply()}</Button>
        </form>
      </fieldset>
      <p className="text-muted-foreground text-sm">
        {data.latest
          ? m.admin_data_through_exclusive_last_computed({
              dataThrough: data.latest.dataThrough.toISOString(),
              computedAt: data.latest.computedAt.toISOString(),
            })
          : m.admin_no_daily_summaries_yet()}
      </p>
      <p className="text-muted-foreground text-sm">
        {m.admin_daily_summaries_in_this_range_paid_conversion_paid({ count: data.rows.length })}
      </p>
      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          [m.admin_registrations(), data.registrations],
          [m.admin_paid_workspaces(), data.latest?.paidWorkspaces ?? '—'],
          [m.admin_paid_conversion(), percent(data.paidConversion)],
          [m.admin_user_credits_consumed(), data.creditsConsumed],
          [m.admin_platform_overage_absorbed(), data.overageAbsorbed],
          [
            m.admin_text_success_rate(),
            m.admin_attempts({ rate: percent(data.successRate), attempts: data.attempts }),
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{label}</dt>
            <dd className="mt-2 font-semibold text-2xl">{value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="font-semibold text-lg">{m.admin_mrr_monthly_latest_snapshot()}</h3>
      {data.latest && Object.entries(data.latest.mrrByCurrency).length ? (
        <ul className="grid gap-1 text-sm">
          {Object.entries(data.latest.mrrByCurrency).map(([currency, cents]) => (
            <li key={currency}>
              {currency}: {(cents / 100).toFixed(2)}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>{m.admin_no_paid_subscriptions()}</EmptyState>
      )}
      <h3 className="font-semibold text-lg">{m.admin_platform_overage_by_model()}</h3>
      {Object.entries(data.overageByModel).length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr className="border-b">
                <th className="h-10 px-3 font-medium text-muted-foreground">{m.admin_model()}</th>
                <th className="h-10 px-3 font-medium text-muted-foreground">
                  {m.admin_credits_absorbed()}
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.overageByModel)
                .sort((a, b) => b[1] - a[1])
                .map(([model, amount]) => (
                  <tr key={model} className="border-b last:border-0">
                    <td className="px-3 py-2">{model}</td>
                    <td className="px-3 py-2">{amount}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState>{m.admin_no_platform_overage_in_this_range()}</EmptyState>
      )}
    </AdminPage>
  )
}
