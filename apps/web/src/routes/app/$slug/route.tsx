import { createFileRoute, Outlet } from '@tanstack/react-router'
import { WorkbenchShell } from '../../../features/workbench/shell.tsx'
import {
  AccountPendingPage,
  isAccountPending,
  requireActivatedPage,
} from '../../../features/workspace/activation.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug')({
  // 未开通账号（add-beta-access-gate）在这里中断，子路由 loader 不会调用被 403 拦截的接口
  beforeLoad: async ({ params }) => ({
    workspacePage: requireActivatedPage(await getWorkspacePage({ data: { slug: params.slug } })),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.workspace.name} · Workspace` }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: ({ data }) =>
    isAccountPending(data) ? (
      <AccountPendingPage />
    ) : (
      <main>
        <h1>{m.app_workspace_not_found()}</h1>
        <p>{m.app_workspace_no_access()}</p>
        <a href="/app">{m.app_go_workspace()}</a>
      </main>
    ),
})

function WorkspaceLayout() {
  const page = Route.useLoaderData()
  return (
    <WorkbenchShell page={page}>
      <Outlet />
    </WorkbenchShell>
  )
}
