import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../../../features/workbench/placeholder.tsx'

export const Route = createFileRoute('/app/$slug/data')({
  head: () => ({ meta: [{ title: '数据中心' }] }),
  component: () => (
    <PagePlaceholder
      title="数据中心"
      milestone="M1"
      description="数据源状态、同步记录、数据预览、文件导入、数据质量和额度用量。"
    />
  ),
})
