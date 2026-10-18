import { createFileRoute } from '@tanstack/react-router'
import { getConfigPage } from '../../../features/config/config.functions.ts'
import { ConfigPage } from '../../../features/config/config-page.tsx'
import { getCostingSettings } from '../../../features/costing/settings.functions.ts'

export const Route = createFileRoute('/app/$slug/config')({
  head: () => ({ meta: [{ title: '设置' }] }),
  loader: async ({ params }) => {
    const [config, costing] = await Promise.all([
      getConfigPage({ data: { slug: params.slug } }),
      getCostingSettings({ data: { slug: params.slug } }),
    ])
    return { config, costing }
  },
  staleTime: 0,
  component: ConfigRoute,
})

function ConfigRoute() {
  const { slug } = Route.useParams()
  const { config, costing } = Route.useLoaderData()
  return <ConfigPage slug={slug} initial={config} costing={costing} />
}
