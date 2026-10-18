import { createFileRoute } from '@tanstack/react-router'
import { ArchivePage } from '../../../features/costing/archive-page.tsx'
import { archiveFilters, getArchivePage } from '../../../features/costing/decisions.functions.ts'

export const Route = createFileRoute('/app/$slug/archive')({
  head: () => ({ meta: [{ title: '选品档案库' }] }),
  // 筛选条件放在 URL 中，刷新与分享链接时保留；非法值直接忽略
  validateSearch: (search) => {
    const parsed = archiveFilters.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => getArchivePage({ data: { slug: params.slug, filters: deps } }),
  staleTime: 0,
  component: ArchiveRoute,
})

function ArchiveRoute() {
  const { slug } = Route.useParams()
  return <ArchivePage slug={slug} data={Route.useLoaderData()} search={Route.useSearch()} />
}
