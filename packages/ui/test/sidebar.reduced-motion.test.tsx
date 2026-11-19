import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 系统开启「减少动态效果」，并且视口为窄屏（抽屉模式由各用例的 narrow 决定）。motion 首次使用时读取并缓存
// 减少动态效果的媒体查询，所以单独成文件、在导入组件前设置
const viewport = vi.hoisted(() => {
  const state = { narrow: false }
  window.matchMedia = ((query: string) => ({
    matches:
      query.includes('prefers-reduced-motion') || (state.narrow && query.includes('max-width')),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  return state
})

const {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} = await import('../src/components/sidebar.tsx')
const { UiRoot } = await import('../src/components/ui-root.tsx')

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  viewport.narrow = false
})

/** 下一帧：motion 的 JS 动画在 requestAnimationFrame 中推进 */
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

const labels = {
  title: '侧栏导航',
  expand: '展开侧栏',
  collapse: '收起侧栏',
  rail: '调整宽度或收起侧栏',
  railResize: '拖动调整宽度',
  railCollapse: '点击收起',
}

function Nav() {
  return (
    <UiRoot>
      <SidebarProvider labels={labels}>
        <Sidebar collapsible="icon">
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>概览</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>
    </UiRoot>
  )
}

describe('减少动态效果时无位移动画', () => {
  it('收起：外壳宽度直接落到图标栏宽度，不经过中间值', async () => {
    render(<Nav />)
    const shell = document.querySelector('[data-slot="sidebar"]') as HTMLElement
    expect(shell.style.width).toBe('16rem')
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    await frame()
    expect(shell.style.width).toBe('3rem')
  })

  it('移动抽屉：面板出现的第一帧即在终点，不滑入', async () => {
    viewport.narrow = true
    render(<Nav />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    const dialog = await screen.findByRole('dialog', { name: '侧栏导航' })
    await frame()
    expect(dialog.style.transform).not.toMatch(/translateX\(-/)
  })
})
