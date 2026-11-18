import { createFileRoute } from '@tanstack/react-router'
import { getWorkbenchHome } from '../../../features/costing/decisions.functions.ts'
import { WorkbenchHome } from '../../../features/costing/home-page.tsx'
import { NotificationCenter } from '../../../features/notifications/center.tsx'

export const Route = createFileRoute('/app/$slug/')({
  head: () => ({ meta: [{ title: '工作台' }] }),
  loader: ({ params }) => getWorkbenchHome({ data: { slug: params.slug } }),
  staleTime: 0,
  component: HomeRoute,
})

// 选品工作台首页沿用项目自己的待决定队列；模板的通知区放在上方，作为顶栏铃铛
// 「查看全部通知」的落点（#notifications），还没有任何通知时不渲染。
function HomeRoute() {
  const { slug } = Route.useParams()
  return (
    <div className="flex flex-col gap-6">
      {/* empty:hidden 去掉通知区不渲染时占位的间距 */}
      <div className="empty:hidden print:hidden">
        <NotificationCenter hideWhenEmpty />
      </div>
      <WorkbenchHome slug={slug} initial={Route.useLoaderData()} />
    </div>
  )
}
