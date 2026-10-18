import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { withWorkspace } from '../../server/middleware.ts'

// /app 只做重定向（specs/workspace-tenancy「统一的空间 URL」）：
// 活跃空间（仍是成员时）→ 个人空间（缺失时补建）；未登录由 withSession 重定向到 /login。
const getDefaultWorkspaceSlug = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .handler(({ context }) => context.workspace.slug)

export const Route = createFileRoute('/app/')({
  loader: async () => {
    const slug = await getDefaultWorkspaceSlug({ data: {} })
    throw redirect({ to: '/app/$slug', params: { slug } })
  },
})
