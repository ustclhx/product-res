import { createFileRoute } from '@tanstack/react-router'
import { getCandidates } from '../../../../features/follow/candidates.functions.ts'
import { type CandidateSearch, candidateSearch } from '../../../../features/follow/candidates.ts'
import { CandidatesPage } from '../../../../features/follow/candidates-page.tsx'

export const Route = createFileRoute('/app/$slug/follow/')({
  head: () => ({ meta: [{ title: '跟卖选品' }] }),
  // search 全部可选：导航与入口链接不必带参数，缺省为 Amazon、全部方向、第一页
  validateSearch: (search: Record<string, unknown>): Partial<CandidateSearch> =>
    candidateSearch(search),
  loaderDeps: ({ search }) => candidateSearch(search),
  loader: ({ params, deps }) => getCandidates({ data: { slug: params.slug, ...deps } }),
  staleTime: 0,
  component: FollowRoute,
})

function FollowRoute() {
  const { slug } = Route.useParams()
  return <CandidatesPage slug={slug} data={Route.useLoaderData()} />
}
