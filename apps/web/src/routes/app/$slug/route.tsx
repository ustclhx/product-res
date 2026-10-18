import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { NotificationCenter } from '../../../features/notifications/center.tsx'
import { WorkspaceSwitcher } from '../../../features/workspace/components.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

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
    <div className="mx-auto grid max-w-4xl gap-8 p-6">
      <header className="grid gap-4">
        <h1 data-testid="workspace-name" className="text-2xl font-semibold">
          {page.workspace.name}
        </h1>
        <p>{page.workspace.isPersonal ? m.app_personal_workspace() : m.app_team_workspace()}</p>
        <p>{m.app_role({ role: page.role })}</p>
        <p data-testid="current-user">
          {page.user.name} ({page.user.email})
        </p>
        {page.readOnly ? <p role="status">{m.app_readonly()}</p> : null}
        <WorkspaceSwitcher page={page} />
        <NotificationCenter key={page.workspace.slug} slug={page.workspace.slug} />
        <nav className="flex flex-wrap gap-4">
          {templateConfig.billing.enabled &&
          templateConfig.features.publicApi &&
          (page.role === 'owner' || page.role === 'admin') ? (
            <Link
              to="/app/$slug/api-keys"
              search={{ page: 0 }}
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              API Keys
            </Link>
          ) : null}
          {templateConfig.ai.text.enabled && (
            <Link to="/app/$slug/chat" params={{ slug: page.workspace.slug }} className="underline">
              {m.app_chat()}
            </Link>
          )}
          {templateConfig.ai.image || templateConfig.ai.video ? (
            <Link
              to="/app/$slug/tasks"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.media_tasks_title()}
            </Link>
          ) : null}
          {templateConfig.ai.image || templateConfig.ai.video ? (
            <Link
              to="/app/$slug/media/new"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.media_title()}
            </Link>
          ) : null}
          <Link
            to="/app/$slug/settings"
            params={{ slug: page.workspace.slug }}
            className="underline"
          >
            {m.app_workspace_settings()}
          </Link>
          {templateConfig.billing.enabled && (
            <Link
              to="/app/$slug/billing"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.app_billing()}
            </Link>
          )}
          {templateConfig.credits.enabled && (
            <Link
              to="/app/$slug/usage"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.app_usage()}
            </Link>
          )}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
