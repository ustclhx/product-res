import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/archive')({
  head: () => ({ meta: [{ title: '选品档案库' }] }),
  component: () => (
    <PagePlaceholder
      title="选品档案库"
      milestone="M3"
      description="已决定的线索、品类研究报告和 30 天回看。"
    />
  ),
})
