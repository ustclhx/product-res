import { createFileRoute, Outlet } from '@tanstack/react-router'
import { WorkbenchShell } from '../../../features/workbench/shell.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug')({
  beforeLoad: async ({ params }) => ({
    workspacePage: await getWorkspacePage({ data: { slug: params.slug } }),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.workspace.name} · Workspace` }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: () => (
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
