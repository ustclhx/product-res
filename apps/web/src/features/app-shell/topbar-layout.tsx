import { Link, Outlet } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { DailyCreditsNotice } from '../credits/daily-notice.tsx'
import { NotificationBell } from '../notifications/bell.tsx'
import { type WorkspacePage, WorkspaceSwitcher } from '../workspace/components.tsx'
import { resolveAppNav, TEMPLATE_NAV_IDS } from './registry.ts'

/** 原有顶部布局（ui.appLayout: 'topbar'），结构与文案保持不变；另渲染项目注册的导航条目。
 * 通知入口改为与侧边栏布局相同的铃铛，完整列表在首页 #notifications */
export function TopbarLayout({ page }: { page: WorkspacePage }) {
  // 项目经 registerAppNav 新增的条目排在原有链接之后；模板条目已由上面的固定链接渲染
  const projectItems = resolveAppNav({
    role: page.role,
    readOnly: page.readOnly,
    isPersonal: page.workspace.isPersonal,
  })
    .flatMap((group) => group.items)
    .filter((item) => !(TEMPLATE_NAV_IDS as readonly string[]).includes(item.id))
  return (
    <div className="mx-auto grid max-w-4xl gap-8 p-6">
      <header className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 data-testid="workspace-name" className="text-2xl font-semibold">
            {page.workspace.name}
          </h1>
          <NotificationBell />
        </div>
        <p>{page.workspace.isPersonal ? m.app_personal_workspace() : m.app_team_workspace()}</p>
        <p>{m.app_role({ role: page.role })}</p>
        <p data-testid="current-user">
          {page.user.name} ({page.user.email})
        </p>
        {page.readOnly ? <p role="status">{m.app_readonly()}</p> : null}
        <DailyCreditsNotice result={page.dailyCredits} />
        <WorkspaceSwitcher page={page} />
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
          {projectItems.map((item) => (
            <Link
              key={item.id}
              to={item.to as '/app/$slug'}
              params={{ slug: page.workspace.slug }}
              {...(item.search && { search: item.search as never })}
              className="underline"
            >
              {item.label()}
            </Link>
          ))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
