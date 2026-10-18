import { createFileRoute } from '@tanstack/react-router'
import { getClusterDetail } from '../../../../features/follow/candidates.functions.ts'
import { ClusterPage } from '../../../../features/follow/cluster-page.tsx'

export const Route = createFileRoute('/app/$slug/follow/$clusterId')({
  head: () => ({ meta: [{ title: '商品簇详情' }] }),
  loader: ({ params }) =>
    getClusterDetail({ data: { slug: params.slug, clusterId: params.clusterId } }),
  staleTime: 0,
  component: ClusterRoute,
})

function ClusterRoute() {
  const { slug } = Route.useParams()
  return <ClusterPage slug={slug} data={Route.useLoaderData()} />
}
