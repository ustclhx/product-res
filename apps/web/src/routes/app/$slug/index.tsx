import { createFileRoute } from '@tanstack/react-router'
import { getWorkbenchHome } from '../../../features/costing/decisions.functions.ts'
import { WorkbenchHome } from '../../../features/costing/home-page.tsx'

export const Route = createFileRoute('/app/$slug/')({
  head: () => ({ meta: [{ title: '工作台' }] }),
  loader: ({ params }) => getWorkbenchHome({ data: { slug: params.slug } }),
  staleTime: 0,
  component: HomeRoute,
})

function HomeRoute() {
  const { slug } = Route.useParams()
  return <WorkbenchHome slug={slug} initial={Route.useLoaderData()} />
}
