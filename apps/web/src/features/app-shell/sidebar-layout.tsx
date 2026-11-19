import {
  Button,
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
  MenuItem,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  Tooltip,
} from '@product-res/ui'
import { ChevronsUpDown, LogOut, Menu, Sparkles, User, X, Zap } from '@product-res/ui/icons'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useMemo, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { authClient } from '../auth/auth-client.ts'
import { DailyCreditsNotice } from '../credits/daily-notice.tsx'
import { LanguageControls } from '../i18n/language-controls.tsx'
import { NotificationBell } from '../notifications/bell.tsx'
import { ThemeToggle } from '../theme/theme-toggle.tsx'
import { activateWorkspace } from '../workspace/client.ts'
import type { WorkspacePage } from '../workspace/components.tsx'
import { AppShellBarContext } from './bar.tsx'
import type { AppNavGroup, AppNavGroupId, AppNavItem } from './nav.ts'
import { activeAppNavId, resolveAppNav } from './registry.ts'
import { rememberSidebarOpen } from './sidebar-state.ts'
import { showUpgradeEntry } from './upgrade.ts'

// 工作台布局（ui.appLayout: 'sidebar'，验收依据 docs/design-system/prototypes/ui-review/Workbench*.dc.html）：
// 侧边栏在 surface-1，展开 248px / 收起为 64px 图标栏；内容区是 8px 外边距的 surface-2 + shadow-2 圆角面板；
// 抽屉断点（768px）以下侧边栏收为抽屉，面板铺满视口。
// 收起时只在图标栏里出现的样式用 in-data-[collapsible=icon]（外壳收起时带 data-collapsible="icon"，
// 抽屉里没有该属性，始终按展开样式渲染）。

const GROUP_LABELS: Record<AppNavGroupId, () => string> = {
  tools: m.app_shell_group_tools,
  content: m.app_shell_group_content,
  settings: m.app_shell_group_settings,
}

/** 名称首字（头像占位） */
function initial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

export function SidebarLayout({
  page,
  defaultOpen,
}: {
  page: WorkspacePage
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // 路由声明 staticData.shellTitle = false 时（对话页）页面自己渲染带标题的头部，顶部条不再显示标题，避免两行标题
  const hideTitle = useRouterState({
    select: (state) => state.matches.some((match) => match.staticData.shellTitle === false),
  })
  const slug = page.workspace.slug
  const groups = useMemo(
    () =>
      resolveAppNav({
        role: page.role,
        readOnly: page.readOnly,
        isPersonal: page.workspace.isPersonal,
      }),
    [page.role, page.readOnly, page.workspace.isPersonal],
  )
  const activeId = activeAppNavId(groups, pathname, slug)
  const activeItem = groups.flatMap((group) => group.items).find((item) => item.id === activeId)
  // 顶部条插槽：页面经 <AppShellBar> 放入标题、操作与进度条（bar.tsx）
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  const [progressSlot, setProgressSlot] = useState<HTMLElement | null>(null)
  const barSlots = useMemo(
    () => ({ title: titleSlot, actions: actionsSlot, progress: progressSlot }),
    [titleSlot, actionsSlot, progressSlot],
  )
  const upgrade = showUpgradeEntry({
    billingEnabled: templateConfig.billing.enabled,
    planKey: page.planKey,
    role: page.role,
    readOnly: page.readOnly,
  })

  return (
    <SidebarProvider
      labels={{
        title: m.app_shell_navigation(),
        expand: m.app_shell_expand(),
        collapse: m.app_shell_collapse(),
        rail: m.app_shell_rail(),
        railResize: m.app_shell_rail_resize(),
        railCollapse: m.app_shell_rail_collapse(),
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        rememberSidebarOpen(next)
      }}
      width="15.5rem"
      widthIcon="4rem"
      widthMobile="18.75rem"
    >
      <Sidebar collapsible="icon" variant="inset" rail={false} className="print:hidden">
        <aside aria-label={m.app_shell_navigation()} className="flex h-full min-h-0 flex-col">
          <SidebarHeader className="gap-4 px-3 pt-1 in-data-[collapsible=icon]:items-center">
            <div className="flex h-8 items-center justify-between gap-2 pl-1 in-data-[collapsible=icon]:justify-center in-data-[collapsible=icon]:pl-0">
              <Link
                to="/app/$slug"
                params={{ slug }}
                className="flex min-w-0 items-center gap-2 in-data-[collapsible=icon]:hidden"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="truncate font-semibold text-body">{templateConfig.app.name}</span>
              </Link>
              <SidebarTrigger className="in-data-[mobile=true]:hidden" />
              <SidebarTrigger
                aria-label={m.app_shell_close_nav()}
                className="hidden in-data-[mobile=true]:inline-flex"
              >
                <X />
              </SidebarTrigger>
            </div>
            <WorkspaceEntry page={page} />
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label={m.app_shell_nav_label()} className="flex flex-col">
              {groups.map((group) => (
                <NavGroup key={group.id} group={group} slug={slug} activeId={activeId} />
              ))}
            </nav>
          </SidebarContent>
          <SidebarFooter className="gap-2 px-3 pb-1 in-data-[collapsible=icon]:items-center">
            {upgrade ? <UpgradeEntry slug={slug} /> : null}
            <AccountEntry user={page.user} />
            {/* 窄屏顶栏放不下语言与主题切换，改放在抽屉底部；桌面侧边栏不显示 */}
            <div className="hidden flex-wrap items-center gap-2 px-2 in-data-[mobile=true]:flex">
              {templateConfig.i18n.enabled ? <LanguageControls placement="bare" /> : null}
              <ThemeToggle />
            </div>
          </SidebarFooter>
        </aside>
      </Sidebar>
      {/* 打印只输出正文：侧边栏、顶部条与抽屉触发器隐藏，面板去掉外边距与阴影 */}
      <SidebarInset as="div" className="print:m-0 print:rounded-none print:shadow-none">
        <AppShellBarContext.Provider value={barSlots}>
          <header className="relative flex h-14 shrink-0 items-center gap-2 border-border border-b pr-4 pl-2 md:pl-6 print:hidden">
            <SidebarTrigger aria-label={m.app_shell_open_nav()} className="md:hidden">
              <Menu />
            </SidebarTrigger>
            {/* 页面标题（h1）：默认为当前导航项名称；页面经 AppShellBar 放入标题时 CSS 隐藏默认标题。
                路由声明 shellTitle: false 时不渲染（页面自己的头部是 h1） */}
            {hideTitle ? (
              <span className="flex-1" />
            ) : (
              <h1 className="flex min-w-0 flex-1 items-center font-semibold text-title">
                <span ref={setTitleSlot} className="peer contents" />
                <span className="truncate peer-[:not(:empty)]:hidden" data-testid="app-page-title">
                  {activeItem ? activeItem.label() : page.workspace.name}
                </span>
              </h1>
            )}
            <div ref={setActionsSlot} className="flex shrink-0 items-center gap-2 empty:hidden" />
            <NotificationBell />
            <div className="flex items-center gap-3 max-sm:hidden">
              {templateConfig.i18n.enabled ? <LanguageControls placement="bare" /> : null}
              <ThemeToggle />
            </div>
            {/* 顶部条底边的进度条位置（AppShellBar 的 progress） */}
            <div ref={setProgressSlot} className="absolute inset-x-0 bottom-0" />
          </header>
          <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:pb-10">
            {page.readOnly ? <p role="status">{m.app_readonly()}</p> : null}
            <DailyCreditsNotice result={page.dailyCredits} />
            <div className="min-w-0">
              <Outlet />
            </div>
          </main>
        </AppShellBarContext.Provider>
      </SidebarInset>
    </SidebarProvider>
  )
}

function NavGroup({
  group,
  slug,
  activeId,
}: {
  group: AppNavGroup
  slug: string
  activeId: string | null
}) {
  return (
    <SidebarGroup>
      {/* 收起为图标栏时隐藏分组标题，组间只留分组内边距（16px） */}
      <SidebarGroupLabel className="in-data-[collapsible=icon]:hidden">
        {GROUP_LABELS[group.id]()}
      </SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              icon={item.icon}
              isActive={item.id === activeId}
              render={<NavLink item={item} slug={slug} />}
            >
              {item.label()}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

/** 注册表条目的 to 是生成路由树中的路径；交给 Link 时按父路由收窄，免去逐条的 search 类型 */
function NavLink({
  item,
  slug,
  ...props
}: {
  item: AppNavItem
  slug: string
  children?: ReactNode
}) {
  return (
    <Link
      {...props}
      to={item.to as '/app/$slug'}
      params={{ slug }}
      // 当前项由 activeAppNavId 统一计算；Link 自带的前缀匹配会让父路径（工作台首页）一直带 aria-current，只保留完全相同时
      activeOptions={{ exact: true, includeSearch: false }}
      {...(item.search && { search: item.search as never })}
    />
  )
}

/** 名称 + 副标题的两行文字块，收起为图标栏时隐藏 */
function EntryText({
  title,
  caption,
  testId,
}: {
  title: string
  caption: ReactNode
  testId?: string
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col text-left in-data-[collapsible=icon]:hidden">
      <span className="truncate font-medium" data-testid={testId}>
        {title}
      </span>
      <span className="truncate text-caption text-muted-foreground">{caption}</span>
    </span>
  )
}

const ENTRY_BLOCK =
  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-body in-data-[collapsible=icon]:size-9 in-data-[collapsible=icon]:justify-center in-data-[collapsible=icon]:p-0'
const ENTRY_BUTTON = `${ENTRY_BLOCK} outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring)`

function WorkspaceEntry({ page }: { page: WorkspacePage }) {
  const [error, setError] = useState('')
  const { workspace } = page
  // 空间类型单独成段，便于读屏与测试按完整文字定位
  const caption = workspace.isPersonal ? (
    m.app_personal_workspace()
  ) : (
    <>
      <span>{m.app_team_workspace()}</span>
      {' · '}
      <span>{m.app_shell_workspace_members({ count: page.memberCount })}</span>
    </>
  )
  const badge = (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-active font-semibold text-caption">
      {initial(workspace.name)}
    </span>
  )
  // 单空间（未开启团队）时只展示当前空间；开启后可在菜单中切换
  if (!page.multiTenant || page.spaces.length < 2) {
    return (
      <div className={ENTRY_BLOCK}>
        {badge}
        <EntryText title={workspace.name} caption={caption} testId="workspace-name" />
      </div>
    )
  }
  const label = m.app_shell_change_workspace({ name: workspace.name })
  return (
    <>
      <DropdownMenu>
        <DropdownTrigger
          render={
            <button type="button" aria-label={label} className={ENTRY_BUTTON}>
              {badge}
              <EntryText title={workspace.name} caption={caption} testId="workspace-name" />
              <ChevronsUpDown
                size={16}
                aria-hidden="true"
                className="shrink-0 text-muted-foreground in-data-[collapsible=icon]:hidden"
              />
            </button>
          }
        />
        <DropdownContent
          align="start"
          checkedIndex={page.spaces.findIndex((s) => s.id === workspace.id)}
        >
          {page.spaces.map((space, index) => (
            <MenuItem
              key={space.id}
              index={index}
              label={
                space.isPersonal ? `${space.name} · ${m.app_personal_workspace()}` : space.name
              }
              checked={space.id === workspace.id}
              onSelect={() => {
                if (space.id === workspace.id) return
                setError('')
                activateWorkspace(space).catch(() => setError(m.app_shell_switch_failed()))
              }}
            />
          ))}
        </DropdownContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}

/** 底部升级入口：展开时为卡片，收起为图标按钮（名称放进提示） */
function UpgradeEntry({ slug }: { slug: string }) {
  return (
    <>
      <div className="flex flex-col gap-2.5 rounded-xl bg-card p-3 shadow-surface-2 in-data-[collapsible=icon]:hidden">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-semibold text-body">
            <Zap size={14} aria-hidden="true" />
            {m.app_shell_upgrade_title()}
          </span>
          <span className="text-caption text-muted-foreground">{m.app_shell_upgrade_desc()}</span>
        </div>
        <Button asChild size="sm">
          <Link to="/app/$slug/billing" params={{ slug }}>
            {m.app_shell_upgrade_cta()}
          </Link>
        </Button>
      </div>
      <Tooltip side="right" content={m.app_shell_upgrade_title()}>
        <Link
          to="/app/$slug/billing"
          params={{ slug }}
          aria-label={m.app_shell_upgrade_title()}
          className="hidden size-9 items-center justify-center rounded-lg text-foreground outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) in-data-[collapsible=icon]:flex"
        >
          <Zap size={16} aria-hidden="true" />
        </Link>
      </Tooltip>
    </>
  )
}

function AccountEntry({ user }: { user: WorkspacePage['user'] }) {
  const [error, setError] = useState('')
  const displayName = user.name || user.email
  async function signOut() {
    setError('')
    try {
      const result = await authClient().signOut()
      if (result.error) throw new Error(result.error.message)
      window.location.assign('/login')
    } catch {
      setError(m.app_shell_sign_out_failed())
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownTrigger
          render={
            <button
              type="button"
              aria-label={m.app_shell_account_menu({ name: displayName })}
              className={ENTRY_BUTTON}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-active font-semibold text-caption">
                {initial(displayName)}
              </span>
              <span
                className="flex min-w-0 flex-1 flex-col text-left in-data-[collapsible=icon]:hidden"
                data-testid="current-user"
              >
                <span className="truncate font-medium">{displayName}</span>
                <span className="truncate text-caption text-muted-foreground">{user.email}</span>
              </span>
            </button>
          }
        />
        <DropdownContent side="top" align="start">
          <DropdownLabel>{user.email}</DropdownLabel>
          <MenuItem
            index={0}
            icon={User}
            label={m.app_shell_account_settings()}
            render={<Link to="/account" />}
          />
          <DropdownSeparator />
          <MenuItem
            index={1}
            icon={LogOut}
            label={m.app_shell_sign_out()}
            onSelect={() => void signOut()}
          />
        </DropdownContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
