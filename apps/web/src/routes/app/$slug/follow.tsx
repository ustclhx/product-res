import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/follow')({
  head: () => ({ meta: [{ title: '跟卖选品' }] }),
  component: () => (
    <PagePlaceholder
      title="跟卖选品"
      milestone="M2"
      description="候选列表、选品方向与店铺池、商品簇详情和核算。"
    />
  ),
})
