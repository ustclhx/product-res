import { Card, CardContent, CardHeader, CardTitle } from '@product-res/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ADMIN_COPY } from '../../features/admin/copy.ts'
import { getAdminMetrics } from '../../features/admin/metrics.functions.ts'
import { getAdminNavGroups } from '../../features/admin/nav.ts'
import { AdminPage, AdminSection } from '../../features/admin/ui.tsx'

export const Route = createFileRoute('/admin/')({
  // 复用指标看板的 server function（默认最近 7 天）；读取失败时概览仍显示快捷入口
  loader: async () => {
    try {
      return { metrics: await getAdminMetrics({ data: {} }) }
    } catch {
      return { metrics: null }
    }
  },
  component: AdminOverview,
})

const copy = ADMIN_COPY.overview
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)

function AdminOverview() {
  const { metrics } = Route.useLoaderData()
  const groups = getAdminNavGroups().filter((group) => group.label)
  return (
    <AdminPage title={copy.heading} description={copy.description}>
      {metrics ? (
        <div className="grid gap-3">
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              [copy.registrations, metrics.registrations],
              [copy.paidWorkspaces, metrics.latest?.paidWorkspaces ?? '—'],
              [copy.paidConversion, percent(metrics.paidConversion)],
              [copy.creditsConsumed, metrics.creditsConsumed],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border bg-card p-4">
                <dt className="text-muted-foreground text-sm">{label}</dt>
                <dd className="mt-2 font-semibold text-2xl">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-sm">
            {metrics.latest ? copy.metricsRange(metrics.from, metrics.to) : copy.noSummaries}{' '}
            <Link to="/admin/metrics" search={{ offset: 0 }} className="underline">
              {ADMIN_COPY.nav.metrics}
            </Link>
          </p>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {copy.metricsUnavailable}
        </p>
      )}
      <AdminSection title={copy.shortcuts}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {groups.map((group) => (
            <Card key={group.id} className="gap-3 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">{group.label}</CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="grid gap-1 text-sm">
                  {group.items.map(({ label, ...link }) => (
                    <li key={link.to}>
                      <Link {...link} className="underline-offset-4 hover:underline">
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </AdminSection>
    </AdminPage>
  )
}
