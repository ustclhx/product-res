import { createFileRoute } from '@tanstack/react-router'
import { getDataCenter } from '../../../features/data-center/data-center.functions.ts'
import { DataCenterPage } from '../../../features/data-center/page.tsx'

export const Route = createFileRoute('/app/$slug/data')({
  head: () => ({ meta: [{ title: '数据中心' }] }),
  loader: ({ params }) => getDataCenter({ data: { slug: params.slug } }),
  staleTime: 0,
  component: DataRoute,
})

function DataRoute() {
  const { slug } = Route.useParams()
  return <DataCenterPage slug={slug} initial={Route.useLoaderData()} />
}
