import { createFileRoute } from '@tanstack/react-router'
import { getCategoryStudies } from '../../../../features/category/category.functions.ts'
import { CategoryListPage } from '../../../../features/category/list-page.tsx'

export const Route = createFileRoute('/app/$slug/category/')({
  head: () => ({ meta: [{ title: '品类洞察' }] }),
  loader: ({ params }) => getCategoryStudies({ data: { slug: params.slug } }),
  staleTime: 0,
  component: CategoryRoute,
})

function CategoryRoute() {
  const { slug } = Route.useParams()
  return <CategoryListPage slug={slug} initial={Route.useLoaderData()} />
}
