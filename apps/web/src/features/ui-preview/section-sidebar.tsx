import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  type SidebarLabels,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@product-res/ui'
import { Folder, House, Inbox, Settings, Zap } from '@product-res/ui/icons'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { PreviewSection, Specimen } from './layout.tsx'
import { SAMPLE_PROJECTS } from './sample-data.ts'

/** 侧边栏组件本身（分组、当前项、折叠、移动抽屉）；工作台页面布局属于 tasks 8.3 */
export function SidebarSection() {
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState('home')
  const labels: SidebarLabels = {
    title: m.ui_preview_navigation(),
    expand: m.ui_preview_sidebar_expand(),
    collapse: m.ui_preview_sidebar_collapse(),
    rail: m.ui_preview_sidebar_rail(),
    railResize: m.ui_preview_sidebar_rail_resize(),
    railCollapse: m.ui_preview_sidebar_rail_collapse(),
  }
  const nav = [
    { id: 'home', label: m.ui_preview_nav_home(), icon: House },
    { id: 'inbox', label: m.ui_preview_nav_inbox(), icon: Inbox, badge: '3' },
    { id: 'settings', label: m.ui_preview_nav_settings(), icon: Settings },
  ]
  return (
    <PreviewSection id="sidebar" title="Sidebar" description={m.ui_preview_sidebar_desc()}>
      <Specimen label={m.ui_preview_default()} wide className="block p-0">
        <div className="relative h-96 overflow-hidden rounded-xl">
          <SidebarProvider labels={labels} open={open} onOpenChange={setOpen}>
            <Sidebar collapsible="icon">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>{m.ui_preview_workspace()}</SidebarGroupLabel>
                  <SidebarMenu>
                    {nav.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          icon={item.icon}
                          isActive={active === item.id}
                          tooltip={item.label}
                          onClick={() => setActive(item.id)}
                        >
                          {item.label}
                        </SidebarMenuButton>
                        {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
                <SidebarGroup>
                  <SidebarGroupLabel>{m.ui_preview_projects()}</SidebarGroupLabel>
                  <SidebarMenu>
                    {SAMPLE_PROJECTS.slice(0, 4).map((project) => (
                      <SidebarMenuItem key={project.id}>
                        <SidebarMenuButton
                          icon={Folder}
                          isActive={active === project.id}
                          tooltip={project.name}
                          onClick={() => setActive(project.id)}
                        >
                          {project.name}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>
            <SidebarInset>
              <div className="flex flex-col gap-2 p-4">
                <SidebarTrigger />
                <p className="text-body text-muted-foreground">{m.ui_preview_sidebar_desc()}</p>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </div>
      </Specimen>
      <WorkbenchSpecimen labels={labels} nav={nav} />
    </PreviewSection>
  )
}

/** 工作台用法（tasks 8.3）：inset 面板（surface-2 + shadow-2、8px 外边距）、收起为 64px 图标栏、底部升级与账户入口 */
function WorkbenchSpecimen({
  labels,
  nav,
}: {
  labels: SidebarLabels
  nav: { id: string; label: string; icon: typeof House }[]
}) {
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState('home')
  const [owner] = SAMPLE_PROJECTS
  return (
    <Specimen label={m.app_shell_preview_label()} wide className="block p-0">
      <div className="relative h-96 overflow-hidden rounded-xl bg-background">
        <SidebarProvider
          labels={labels}
          open={open}
          onOpenChange={setOpen}
          width="15.5rem"
          widthIcon="4rem"
        >
          <Sidebar collapsible="icon" variant="inset" rail={false}>
            <SidebarHeader className="px-3 in-data-[collapsible=icon]:items-center">
              <div className="flex h-8 items-center justify-between pl-1 in-data-[collapsible=icon]:justify-center in-data-[collapsible=icon]:pl-0">
                <span className="truncate font-semibold in-data-[collapsible=icon]:hidden">
                  {owner?.name}
                </span>
                <SidebarTrigger />
              </div>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>{m.ui_preview_workspace()}</SidebarGroupLabel>
                <SidebarMenu>
                  {nav.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        icon={item.icon}
                        isActive={active === item.id}
                        onClick={() => setActive(item.id)}
                      >
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="px-3 in-data-[collapsible=icon]:items-center">
              <div className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-surface-2 in-data-[collapsible=icon]:hidden">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Zap size={14} aria-hidden="true" />
                  {m.app_shell_upgrade_title()}
                </span>
                <Button size="sm">{m.app_shell_upgrade_cta()}</Button>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 in-data-[collapsible=icon]:px-0">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-active font-semibold text-caption">
                  {owner?.owner.charAt(0)}
                </span>
                <span className="truncate in-data-[collapsible=icon]:hidden">{owner?.owner}</span>
              </div>
            </SidebarFooter>
          </Sidebar>
          <SidebarInset>
            <div className="flex h-14 items-center border-border border-b px-6 font-semibold">
              {nav.find((item) => item.id === active)?.label}
            </div>
            <p className="p-6 text-body text-muted-foreground">{m.ui_preview_sidebar_desc()}</p>
          </SidebarInset>
        </SidebarProvider>
      </div>
    </Specimen>
  )
}
