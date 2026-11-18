import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Sidebar,
  type SidebarCollapsible,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  type SidebarLabels,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '../src/components/sidebar.tsx'

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
// 让 motion 走 JS 动画（逐帧写 style），便于断言动画在推进
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

const labels: SidebarLabels = {
  title: '侧栏导航',
  expand: '展开侧栏',
  collapse: '收起侧栏',
  rail: '调整宽度或收起侧栏',
  railResize: '拖动调整宽度',
  railCollapse: '点击收起',
}

function Icon({ size = 16 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} />
}

interface NavProps {
  collapsible?: SidebarCollapsible
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onBilling?: () => void
  shortcut?: string | null
}

function Nav({ collapsible = 'icon', onBilling, ...provider }: NavProps) {
  return (
    <SidebarProvider labels={labels} {...provider}>
      <Sidebar collapsible={collapsible}>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>工作区</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={Icon} isActive>
                  概览
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton icon={Icon}>成员</SidebarMenuButton>
                <SidebarMenuBadge>3</SidebarMenuBadge>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Icon}
                  {...(onBilling !== undefined && { onClick: onBilling })}
                >
                  账单
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>设置</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={Icon} tooltip="空间设置">
                  设置
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  )
}

const shell = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement
const menuButton = (name: string) => screen.getByRole('button', { name })
// 图标栏收起时边缘拖拽条也叫「展开侧栏」，按 data-sidebar 取触发按钮
const trigger = () => document.querySelector('[data-sidebar="trigger"]') as HTMLButtonElement

/** 窄屏：useIsMobile 的 max-width 查询命中，其余（减少动态效果）不命中 */
function mockNarrowViewport() {
  const original = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    if (!query.includes('max-width')) return original(query)
    return {
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList
  })
}

describe('Sidebar 分组与当前项', () => {
  it('渲染分组标题与菜单，当前项带 aria-current，且是唯一的 Tab 停留点', () => {
    render(<Nav />)
    expect(screen.getByText('工作区')).toBeTruthy()
    expect(screen.getByText('设置', { selector: '[data-sidebar="group-label"] span' })).toBeTruthy()
    expect(screen.getAllByRole('list')).toHaveLength(2)

    const overview = menuButton('概览')
    expect(overview.getAttribute('aria-current')).toBe('page')
    expect(overview.tabIndex).toBe(0)
    for (const name of ['成员', '账单']) {
      const button = menuButton(name)
      expect(button.hasAttribute('aria-current')).toBe(false)
      expect(button.tabIndex).toBe(-1)
    }
    // 行尾徽标在行内
    expect(menuButton('成员').parentElement?.textContent).toContain('3')
  })

  it('菜单内上下键、Home / End 移动焦点，Enter / 点击激活', () => {
    const onBilling = vi.fn()
    render(<Nav onBilling={onBilling} />)
    const overview = menuButton('概览')
    act(() => overview.focus())

    fireEvent.keyDown(overview, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(menuButton('成员'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(menuButton('账单'))
    // 每个 SidebarMenu 是独立的键盘范围：第二组不在其中
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(overview)
    fireEvent.keyDown(overview, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(menuButton('账单'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(overview)

    // 行是原生 <button type="button">：浏览器把 Enter / Space 转成 click
    const billing = menuButton('账单')
    expect(billing.tagName).toBe('BUTTON')
    expect(billing.getAttribute('type')).toBe('button')
    act(() => billing.focus())
    fireEvent.click(billing)
    expect(onBilling).toHaveBeenCalledTimes(1)
  })
})

describe('Sidebar 折叠为图标栏', () => {
  it('触发按钮切换展开 / 收起，名称随状态变化并通知 onOpenChange', () => {
    const onOpenChange = vi.fn()
    render(<Nav onOpenChange={onOpenChange} />)
    expect(shell().dataset.state).toBe('expanded')

    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(shell().dataset.state).toBe('collapsed')
    expect(shell().dataset.collapsible).toBe('icon')

    expect(trigger().getAttribute('aria-label')).toBe('展开侧栏')
    fireEvent.click(trigger())
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(shell().dataset.state).toBe('expanded')
  })

  it('受控 open：只通知调用方，由 props 决定状态', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<Nav open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(shell().dataset.state).toBe('expanded')
    rerender(<Nav open={false} onOpenChange={onOpenChange} />)
    expect(shell().dataset.state).toBe('collapsed')
  })

  it('收起后行名称仍可被读屏读到，聚焦时提示显示名称；分组标题隐藏但保留高度', async () => {
    render(<Nav defaultOpen={false} />)
    expect(shell().dataset.state).toBe('collapsed')
    // 可读名称不变（文字转为仅读屏可见）
    const members = menuButton('成员')
    expect(members.querySelector('.sr-only')?.textContent).toBe('成员')
    expect(members.className).toContain('w-8')
    // 分组标题 invisible（不占读屏、不跳动），徽标隐藏
    expect(screen.getByText('工作区').closest('[data-sidebar="group-label"]')?.className).toContain(
      'invisible',
    )
    expect(document.querySelector('[data-sidebar="menu-badge"]')?.className).toContain('hidden')

    act(() => members.focus())
    fireEvent.focus(members)
    expect(
      (await screen.findAllByText('成员', { selector: '[data-radix-popper-content-wrapper] *' }))
        .length,
    ).toBeGreaterThan(0)

    // 显式 tooltip 优先于行文字
    const settings = menuButton('设置')
    act(() => settings.focus())
    fireEvent.focus(settings)
    expect((await screen.findAllByText('空间设置')).length).toBeGreaterThan(0)
  })

  it('展开时不显示名称提示', async () => {
    render(<Nav />)
    const members = menuButton('成员')
    act(() => members.focus())
    fireEvent.focus(members)
    await wait(300)
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('触发按钮带 aria-expanded，随折叠状态变化', () => {
    render(<Nav />)
    const trigger = document.querySelector('[data-sidebar="trigger"]') as HTMLElement
    expect(trigger.getAttribute('aria-label')).toBe('收起侧栏')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-label')).toBe('展开侧栏')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('快捷键默认关闭（WCAG 2.1.4）', () => {
    render(<Nav />)
    fireEvent.keyDown(document.body, { key: '[' })
    expect(shell().dataset.state).toBe('expanded')
  })

  it('显式开启的裸键 [ 切换；输入框、菜单内、重复与已消费的按键不触发', () => {
    render(
      <>
        <Nav shortcut="[" />
        <input aria-label="搜索" />
        <div role="menu">
          <button type="button">菜单项</button>
        </div>
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText('搜索'), { key: '[' })
    fireEvent.keyDown(screen.getByRole('button', { name: '菜单项' }), { key: '[' })
    fireEvent.keyDown(document.body, { key: '[', repeat: true })
    const consumed = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true })
    consumed.preventDefault()
    act(() => {
      document.body.dispatchEvent(consumed)
    })
    expect(shell().dataset.state).toBe('expanded')
    fireEvent.keyDown(document.body, { key: '[' })
    expect(shell().dataset.state).toBe('collapsed')
    fireEvent.keyDown(document.body, { key: '[', metaKey: true })
    expect(shell().dataset.state).toBe('collapsed')
  })
})

describe('Sidebar 移动端抽屉', () => {
  it('触发按钮打开抽屉，Esc 关闭后焦点回到触发按钮', async () => {
    mockNarrowViewport()
    render(<Nav />)
    const trigger = await screen.findByRole('button', { name: '展开侧栏' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    act(() => trigger.focus())
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '侧栏导航' })
    // 面板自己接住初始焦点，而不是第一行
    expect(document.activeElement).toBe(dialog)
    expect(dialog.dataset.mobile).toBe('true')
    expect(screen.getAllByRole('button', { name: '概览' }).length).toBeGreaterThan(0)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('点击遮罩关闭', async () => {
    mockNarrowViewport()
    render(<Nav />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    await screen.findByRole('dialog', { name: '侧栏导航' })
    const overlay = document.querySelector('[data-sidebar="overlay"]') as HTMLElement
    await wait(20)
    fireEvent.pointerDown(overlay)
    fireEvent.pointerUp(overlay)
    fireEvent.click(overlay)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('m.* 都在 MotionFeatures 之下（不包 UiRoot 时动画会推进）', () => {
  const widthOf = (el: HTMLElement) => Number.parseFloat(el.style.width)

  it('收起时外壳宽度从 16rem 逐帧收到图标栏 3rem', async () => {
    render(<Nav />)
    expect(shell().style.width).toBe('16rem')
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    await frame()
    await frame()
    const mid = widthOf(shell())
    expect(mid).toBeLessThan(16)
    expect(mid).toBeGreaterThan(3)
    await wait(500)
    expect(shell().style.width).toBe('3rem')
  })

  it('抽屉面板从屏外滑入', async () => {
    mockNarrowViewport()
    render(<Nav />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    const dialog = await screen.findByRole('dialog', { name: '侧栏导航' })
    await frame()
    await frame()
    expect(dialog.style.transform).toMatch(/translateX\(-\d/)
    await wait(500)
    expect(dialog.style.transform).toBe('none')
  })
})

describe('SSR', () => {
  it('折叠状态按 props 直接输出，无需客户端修正', () => {
    const collapsed = renderToString(<Nav defaultOpen={false} />)
    expect(collapsed).toMatch(/data-slot="sidebar"[^>]*data-state="collapsed"/)
    expect(collapsed).toMatch(/data-slot="sidebar"[^>]*style="width:3rem"/)
    // 收起时行文字仍在 HTML 中（仅读屏可见），分组标题 invisible
    expect(collapsed).toContain('<span class="sr-only">')
    expect(collapsed).toMatch(/data-sidebar="group-label" class="[^"]*invisible/)

    const expanded = renderToString(<Nav />)
    expect(expanded).toMatch(/data-slot="sidebar"[^>]*data-state="expanded"/)
    expect(expanded).toMatch(/data-slot="sidebar"[^>]*style="width:16rem"/)
    expect(expanded).toContain('aria-current="page"')

    const offcanvas = renderToString(<Nav collapsible="offcanvas" defaultOpen={false} />)
    expect(offcanvas).toMatch(/data-slot="sidebar"[^>]*style="width:0rem"/)
  })

  it('受控 open 与 defaultOpen 一致地决定首帧', () => {
    function Controlled() {
      const [open] = useState(false)
      return <Nav open={open} />
    }
    expect(renderToString(<Controlled />)).toMatch(/data-state="collapsed"/)
  })
})

describe('工作台用法（tasks 8.3）', () => {
  function LinkNav({ closeOnNavigate }: { closeOnNavigate?: boolean }) {
    return (
      <SidebarProvider labels={labels} widthIcon="4rem" defaultOpen={false}>
        <Sidebar
          collapsible="icon"
          variant="inset"
          {...(closeOnNavigate !== undefined && { closeOnNavigate })}
        >
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={Icon} render={<a href="#chat" />}>
                  对话
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>
    )
  }

  it('图标栏宽度可配置，收起的行在栏内居中；图标栏收起时面板不补左边距', () => {
    const html = renderToString(<LinkNav />)
    expect(html).toMatch(/data-slot="sidebar"[^>]*style="width:4rem"/)
    expect(html).toContain('--sidebar-width-icon:4rem')
    expect(html).toMatch(/data-sidebar="menu-button"[^>]*class="[^"]*mx-auto w-8/)
    expect(html).toMatch(/data-collapsible="icon"/)
  })

  it('抽屉里选择链接条目后关闭，焦点回到菜单按钮', async () => {
    mockNarrowViewport()
    render(<LinkNav />)
    await waitFor(() => expect(trigger().getAttribute('aria-haspopup')).toBe('dialog'))
    const opener = trigger()
    act(() => opener.focus())
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: '侧栏导航' })
    const link = dialog.querySelector('a[href="#chat"]') as HTMLAnchorElement
    fireEvent.click(link)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('closeOnNavigate={false} 或带修饰键点击时抽屉保持打开', async () => {
    mockNarrowViewport()
    render(<LinkNav closeOnNavigate={false} />)
    await waitFor(() => expect(trigger().getAttribute('aria-haspopup')).toBe('dialog'))
    fireEvent.click(trigger())
    const dialog = await screen.findByRole('dialog', { name: '侧栏导航' })
    fireEvent.click(dialog.querySelector('a[href="#chat"]') as HTMLAnchorElement)
    await wait(50)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    cleanup()
    render(<LinkNav />)
    await waitFor(() => expect(trigger().getAttribute('aria-haspopup')).toBe('dialog'))
    fireEvent.click(trigger())
    const again = await screen.findByRole('dialog', { name: '侧栏导航' })
    fireEvent.click(again.querySelector('a[href="#chat"]') as HTMLAnchorElement, { metaKey: true })
    await wait(50)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })
})
