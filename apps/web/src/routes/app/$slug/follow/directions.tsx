import { createFileRoute } from '@tanstack/react-router'
import { getDirectionsPage } from '../../../../features/follow/directions.functions.ts'
import { DirectionsPage } from '../../../../features/follow/directions-page.tsx'

export const Route = createFileRoute('/app/$slug/follow/directions')({
  head: () => ({ meta: [{ title: '选品方向与店铺池' }] }),
  loader: ({ params }) => getDirectionsPage({ data: { slug: params.slug } }),
  staleTime: 0,
  component: DirectionsRoute,
})

function DirectionsRoute() {
  const { slug } = Route.useParams()
  return <DirectionsPage slug={slug} initial={Route.useLoaderData()} />
}
