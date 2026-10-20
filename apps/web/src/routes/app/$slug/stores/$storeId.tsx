import { createFileRoute } from '@tanstack/react-router'
import { StoreDetailPage } from '../../../../features/store-tracking/store-detail-page.tsx'
import { getStoreDetail } from '../../../../features/store-tracking/store-tracking.functions.ts'
import { m } from '../../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/stores/$storeId')({
  head: () => ({ meta: [{ title: m.store_tracking_title() }] }),
  loader: ({ params }) => getStoreDetail({ data: { slug: params.slug, id: params.storeId } }),
  staleTime: 0,
  component: StoreDetailRoute,
})

function StoreDetailRoute() {
  const { slug } = Route.useParams()
  const data = Route.useLoaderData()
  // 切换店铺时重新挂载，避免沿用上一个店铺的分页与编辑状态
  return <StoreDetailPage key={data.store.id} slug={slug} initial={data} />
}
