import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/')({
  head: () => ({ meta: [{ title: '工作台' }] }),
  component: () => (
    <PagePlaceholder
      title="工作台"
      milestone="M3"
      description="待决定队列、节点倒计时、数据同步与额度状态、最近动态。"
    />
  ),
})
