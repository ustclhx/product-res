import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/category')({
  head: () => ({ meta: [{ title: '品牌选品' }] }),
  component: () => (
    <PagePlaceholder
      title="品牌选品"
      milestone="M4"
      description="品类洞察：搜索趋势、新品、差评痛点、竞品矩阵与差异化建议。"
    />
  ),
})
