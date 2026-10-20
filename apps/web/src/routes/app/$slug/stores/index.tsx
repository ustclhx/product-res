import { createFileRoute } from '@tanstack/react-router'
import { getStoresPage } from '../../../../features/store-tracking/store-tracking.functions.ts'
import { StoresPage } from '../../../../features/store-tracking/stores-page.tsx'
import { m } from '../../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/stores/')({
  head: () => ({ meta: [{ title: m.store_tracking_title() }] }),
  loader: ({ params }) => getStoresPage({ data: { slug: params.slug } }),
  staleTime: 0,
  component: StoresRoute,
})

function StoresRoute() {
  const { slug } = Route.useParams()
  return <StoresPage slug={slug} initial={Route.useLoaderData()} />
}
