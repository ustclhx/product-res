import { createFileRoute } from '@tanstack/react-router'
import { requireActivatedPage } from '../../../features/workspace/activation.tsx'
import { WorkspaceSettings } from '../../../features/workspace/components.tsx'
import { loadWorkspacePage } from '../../../features/workspace/load-page.ts'

export const Route = createFileRoute('/app/$slug/settings')({
  // 成员、邀请与席位需要最新数据：总是重新获取，并顺带刷新布局缓存
  beforeLoad: async ({ params }) => ({
    workspacePage: requireActivatedPage(await loadWorkspacePage(params.slug, { fresh: true })),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  component: WorkspaceSettingsPage,
})

function WorkspaceSettingsPage() {
  const page = Route.useLoaderData()
  return (
    <>
      <WorkspaceSettings page={page} />
      {!page.workspace.isPersonal && !page.readOnly && page.role === 'owner' ? (
        <a className="text-destructive underline" href={`/app/${page.workspace.slug}/delete`}>
          Delete team workspace
        </a>
      ) : null}
    </>
  )
}
