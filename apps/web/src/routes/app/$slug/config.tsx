import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/config')({
  head: () => ({ meta: [{ title: '设置' }] }),
  component: () => (
    <PagePlaceholder
      title="设置"
      milestone="M2"
      description="物流方案、成本参数、节点日历、品牌库与风险规则。"
    />
  ),
})
