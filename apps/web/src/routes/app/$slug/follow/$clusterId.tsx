import { createFileRoute } from '@tanstack/react-router'
import { getClusterDetail } from '../../../../features/follow/candidates.functions.ts'
import { ClusterPage } from '../../../../features/follow/cluster-page.tsx'

export const Route = createFileRoute('/app/$slug/follow/$clusterId')({
  head: () => ({ meta: [{ title: '商品簇详情' }] }),
  // tab=costing 打开“核算”标签（工作台队列等入口可直接链接）；缺省为概览
  validateSearch: (search: Record<string, unknown>): { tab?: 'costing' } =>
    search.tab === 'costing' ? { tab: 'costing' } : {},
  loader: ({ params }) =>
    getClusterDetail({ data: { slug: params.slug, clusterId: params.clusterId } }),
  staleTime: 0,
  component: ClusterRoute,
})

function ClusterRoute() {
  const { slug } = Route.useParams()
  const { tab } = Route.useSearch()
  return <ClusterPage slug={slug} data={Route.useLoaderData()} tab={tab ?? 'overview'} />
}
