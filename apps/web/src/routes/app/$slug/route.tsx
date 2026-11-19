import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { NotificationsProvider } from '../../../features/notifications/store.tsx'
import { WorkbenchShell } from '../../../features/workbench/shell.tsx'
import {
  AccountPendingPage,
  isAccountPending,
  pendingSpaces,
  requireActivatedPage,
} from '../../../features/workspace/activation.tsx'
import { loadWorkspacePage, primeWorkspacePage } from '../../../features/workspace/load-page.ts'
import { m } from '../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug')({
  // 未开通账号（add-beta-access-gate）在这里中断，子路由 loader 不会调用被 403 拦截的接口。
  // beforeLoad 每次导航都会重跑；浏览器内按 slug 短缓存，切 tab 不再串行等待这次往返
  // （授权仍由各 Server Function 的 withWorkspace 强制，见 docs/frontend-navigation.md）
  beforeLoad: async ({ params }) => ({
    workspacePage: requireActivatedPage(await loadWorkspacePage(params.slug)),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.workspace.name} · Workspace` }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: ({ data }) =>
    isAccountPending(data) ? (
      <AccountPendingPage otherSpaces={pendingSpaces(data)} />
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
  const { slug } = Route.useParams()
  // 水合时 beforeLoad 不在客户端运行，用 SSR 数据填充缓存（已有条目时不覆盖）
  useEffect(() => primeWorkspacePage(slug, page), [slug, page])
  // 选品工作台固定使用项目自己的 WorkbenchShell（固定侧栏 + 顶栏 + 转移横幅），不按
  // ui.appLayout 选择模板的 SidebarLayout / TopbarLayout。顶栏铃铛与首页通知区共用
  // NotificationsProvider 的通知数据与 30 秒轮询，按空间重建。
  return (
    <NotificationsProvider key={page.workspace.slug} slug={page.workspace.slug}>
      <WorkbenchShell page={page}>
        <Outlet />
      </WorkbenchShell>
    </NotificationsProvider>
  )
}
