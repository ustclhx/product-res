import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getCategoryReport } from '../../../../features/category/category.functions.ts'
import { CategoryReportPage } from '../../../../features/category/report-page.tsx'

export const Route = createFileRoute('/app/$slug/category/$studyId')({
  validateSearch: z.object({ snapshot: z.uuid().optional() }),
  loaderDeps: ({ search }) => ({ snapshot: search.snapshot }),
  loader: ({ params, deps }) =>
    getCategoryReport({
      data: {
        slug: params.slug,
        id: params.studyId,
        ...(deps.snapshot ? { snapshotId: deps.snapshot } : {}),
      },
    }),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `品类洞察 · ${loaderData.study.name}` : '品类洞察' }],
  }),
  staleTime: 0,
  component: CategoryReportRoute,
})

function CategoryReportRoute() {
  const { slug } = Route.useParams()
  return <CategoryReportPage slug={slug} data={Route.useLoaderData()} />
}
