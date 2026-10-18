import { Button, DataTable } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import {
  AdminPage,
  adminTableLabels,
  CheckboxField,
  panelClass,
} from '../../../features/admin/ui.tsx'
import {
  getAdminPlans,
  saveAdminPlanModels,
} from '../../../features/billing/admin-plans.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/plans')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminPlans({ data: deps }),
  errorComponent: () => <p role="alert">{m.admin_plan_data_is_unavailable_please_reload()}</p>,
  component: Plans,
})

type Data = Awaited<ReturnType<typeof getAdminPlans>>

function Plans() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage
      title={m.admin_plan_model_access()}
      description={
        <>
          {m.admin_saved_model_access_applies_to_the_next_request()} <br />
          {m.admin_credit_packs_only_grant_credits_their_model_selections()}
        </>
      }
    >
      <DataTable
        labels={adminTableLabels()}
        label={m.admin_plans()}
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'key',
            header: m.admin_key(),
            cell: (row) => (
              <a href={`#plan-${row.id}`} className="underline">
                {row.key}
              </a>
            ),
          },
          { id: 'name', header: m.admin_name(), cell: (row) => row.name },
          { id: 'type', header: m.admin_type(), cell: (row) => row.type },
          {
            id: 'active',
            header: m.admin_status(),
            cell: (row) => (row.active ? m.admin_active() : m.admin_inactive()),
          },
          {
            id: 'models',
            header: m.admin_models(),
            cell: (row) => row.models.join(', ') || m.admin_none(),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[{ id: 'q', label: m.admin_search_plans() }]}
        filterValues={{ q: search.q }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) => void navigate({ search: filtersToSearch(['q'], values) })}
      />
      {data.rows.map((plan) => (
        <PlanEditor key={plan.id} plan={plan} models={data.models} />
      ))}
    </AdminPage>
  )
}

function PlanEditor({ plan, models }: { plan: Data['rows'][number]; models: Data['models'] }) {
  const router = useRouter()
  const [selected, setSelected] = useState(plan.models)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  // SSR 展示表单时尚无事件处理器，完成 hydration 后再允许编辑和保存。
  useEffect(() => setReady(true), [])
  const currentKeys = new Set(models.map((model) => model.key))
  const historical = plan.models.filter((key) => key !== '*' && !currentKeys.has(key))
  const options = [
    { key: '*', label: m.admin_all_models() },
    ...models.map((model) => ({
      key: model.key,
      label: `${model.key}${model.enabled ? '' : m.admin_disabled_suffix()}`,
    })),
    ...historical.map((key) => ({ key, label: m.admin_historical_model_missing({ key: key }) })),
  ]
  async function save() {
    setBusy(true)
    setMessage('')
    try {
      const result = await saveAdminPlanModels({ data: { id: plan.id, models: selected } })
      if (!result.ok) {
        setMessage(result.error)
        return
      }
      await router.invalidate()
      setMessage(m.admin_saved())
    } catch {
      setMessage(m.admin_save_unavailable_reload_and_retry())
    } finally {
      setBusy(false)
    }
  }
  return (
    <article
      aria-label={m.admin_plan({ key: plan.key })}
      id={`plan-${plan.id}`}
      className={panelClass()}
    >
      <h3 className="font-semibold text-lg">
        {plan.name} ({plan.key})
      </h3>
      {plan.type === 'credit_pack' && (
        <p className="text-muted-foreground text-sm">
          {m.admin_credit_pack_these_selections_do_not_grant_model()}
        </p>
      )}
      {historical.length > 0 && (
        <p role="alert" className="text-destructive text-sm">
          {m.admin_historical_model_keys_are_missing_they_remain_selected({
            keys: historical.join(', '),
          })}
        </p>
      )}
      <fieldset disabled={busy || !ready} className="grid min-w-0 gap-2 sm:grid-cols-2">
        <legend className="mb-2 font-medium text-sm">{m.admin_allowed_models()}</legend>
        {options.map((option) => (
          <CheckboxField
            key={option.key}
            label={option.label}
            className="break-all"
            checked={selected.includes(option.key)}
            onChange={(event) =>
              setSelected((current) =>
                event.target.checked
                  ? [...current, option.key]
                  : current.filter((key) => key !== option.key),
              )
            }
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || !ready} onClick={() => void save()}>
          {m.admin_save_model_access()}
        </Button>
        <p role="status" className="text-sm">
          {message}
        </p>
      </div>
    </article>
  )
}
