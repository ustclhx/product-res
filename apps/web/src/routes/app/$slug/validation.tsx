import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/validation')({
  head: () => ({ meta: [{ title: '算法验证' }] }),
  component: () => (
    <PagePlaceholder
      title="算法验证"
      milestone="M5"
      description="回测命中率、算法准备度和权重拟合建议。"
    />
  ),
})
