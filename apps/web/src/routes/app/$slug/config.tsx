import { createFileRoute } from '@tanstack/react-router'
import { getConfigPage } from '../../../features/config/config.functions.ts'
import { ConfigPage } from '../../../features/config/config-page.tsx'

export const Route = createFileRoute('/app/$slug/config')({
  head: () => ({ meta: [{ title: '设置' }] }),
  loader: ({ params }) => getConfigPage({ data: { slug: params.slug } }),
  staleTime: 0,
  component: ConfigRoute,
})

function ConfigRoute() {
  const { slug } = Route.useParams()
  return <ConfigPage slug={slug} initial={Route.useLoaderData()} />
}
