import { createFileRoute } from '@tanstack/react-router'
import { requireActivatedPage } from '../../../features/workspace/activation.tsx'
import { WorkspaceSettings } from '../../../features/workspace/components.tsx'
import { getInviteLinks } from '../../../features/workspace/invite-links.functions.ts'
import { loadWorkspacePage } from '../../../features/workspace/load-page.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/settings')({
  // 成员、邀请与席位需要最新数据：总是重新获取，并顺带刷新布局缓存
  beforeLoad: async ({ params }) => ({
    workspacePage: requireActivatedPage(await loadWorkspacePage(params.slug, { fresh: true })),
  }),
  loader: async ({ context, params }) => ({
    page: context.workspacePage,
    // 邀请链接只对团队空间的 owner / admin 返回列表，其余为 null（不渲染区块）
    inviteLinks: (await getInviteLinks({ data: { slug: params.slug } })).links,
  }),
  staleTime: 0,
  component: WorkspaceSettingsPage,
})

function WorkspaceSettingsPage() {
  const { page, inviteLinks } = Route.useLoaderData()
  return (
    <div className="grid gap-4">
      <WorkspaceSettings page={page} inviteLinks={inviteLinks} />
      {!page.workspace.isPersonal && !page.readOnly && page.role === 'owner' ? (
        <a
          className="text-destructive text-sm underline"
          href={`/app/${page.workspace.slug}/delete`}
        >
          {m.workspace_delete_team()}
        </a>
      ) : null}
    </div>
  )
}
