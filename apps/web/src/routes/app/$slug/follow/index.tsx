import { createFileRoute, Link } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/follow/')({
  head: () => ({ meta: [{ title: '跟卖选品' }] }),
  component: FollowRoute,
})

function FollowRoute() {
  const { slug } = Route.useParams()
  return (
    <div className="grid gap-4">
      <Link
        to="/app/$slug/follow/directions"
        params={{ slug }}
        className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-[13px] hover:border-primary"
        data-testid="follow-directions-link"
      >
        <span className="grid gap-0.5">
          <span className="font-medium">选品方向与店铺池</span>
          <span className="text-xs text-muted-foreground">
            配置平台站点、类目、关键词、关联节点和对标店铺，候选列表按方向生成。
          </span>
        </span>
        <span className="text-primary">管理 →</span>
      </Link>
      <PagePlaceholder title="跟卖候选" milestone="M2" description="候选列表、商品簇详情和核算。" />
    </div>
  )
}
