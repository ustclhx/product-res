import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 系统开启「减少动态效果」。motion 在首次使用时读取并缓存这一媒体查询，所以单独成文件、在导入组件前设置
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

const { DropdownContent, DropdownMenu, DropdownTrigger, MenuItem } = await import(
  '../src/components/dropdown.tsx'
)
const { UiRoot } = await import('../src/components/ui-root.tsx')

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

describe('减少动态效果时 Dropdown 弹层无位移 / 缩放', () => {
  it('打开后第一帧不下滑、不缩放', async () => {
    render(
      <UiRoot>
        <DropdownMenu>
          <DropdownTrigger>Actions</DropdownTrigger>
          <DropdownContent>
            <MenuItem index={0} label="Rename" />
          </DropdownContent>
        </DropdownMenu>
      </UiRoot>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    await frame()
    // 正常动效下 motion.div 从 translateY(var(--popup-enter-y)) scaleY(0.96) 开始
    expect(menu.style.transform).not.toMatch(/scaleY\(0\.9/)
    expect(menu.style.transform).not.toContain('--popup-enter-y')
  })
})
