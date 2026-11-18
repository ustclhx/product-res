import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Home, Settings, User } from 'lucide-react'
import { useState } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Tabs, TabsItem, TabsPanel } from '../src/components/tabs.tsx'

// happy-dom 不做布局，offset* 全为 0，useFluidHover 会认为没有布局盒而不发布位置。
// 这里给带 data-fluid-hover-index 的元素一个横向排列的假布局：第 i 个标签 left = 4 + 100i，宽 80。
const proto = HTMLElement.prototype
const originals = Object.fromEntries(
  ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight', 'offsetParent'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(proto, key),
  ]),
)
const indexOf = (el: HTMLElement) => {
  const raw = el.getAttribute('data-fluid-hover-index')
  return raw === null ? null : Number(raw)
}
const define = (key: string, get: (el: HTMLElement) => unknown) =>
  Object.defineProperty(proto, key, {
    configurable: true,
    get(this: HTMLElement) {
      return get(this)
    },
  })
define('offsetLeft', (el) => {
  const i = indexOf(el)
  return i === null ? 0 : 4 + i * 100
})
define('offsetTop', (el) => (indexOf(el) === null ? 0 : 4))
define('offsetWidth', (el) => (indexOf(el) === null ? 0 : 80))
define('offsetHeight', (el) => (indexOf(el) === null ? 0 : 36))
define('offsetParent', (el) => el.parentElement)

Element.prototype.scrollIntoView ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())
afterAll(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(proto, key, descriptor)
    else Reflect.deleteProperty(proto, key)
  }
})

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
const px = (value: string) => Number.parseFloat(value || '0')

function Controlled({
  onSelect,
  activeLabel,
}: {
  onSelect?: (index: number) => void
  activeLabel?: boolean
}) {
  const [selected, setSelected] = useState(0)
  return (
    <>
      <Tabs
        aria-label="设置分区"
        idPrefix="settings"
        selectedIndex={selected}
        onSelect={(index) => {
          setSelected(index)
          onSelect?.(index)
        }}
        {...(activeLabel !== undefined && { activeLabel })}
      >
        <TabsItem index={0} label="概览" icon={Home} />
        <TabsItem index={1} label="账户" icon={User} />
        <TabsItem index={2} label="偏好" icon={Settings} />
      </Tabs>
      {['概览内容', '账户内容', '偏好内容'].map((text, index) => (
        <TabsPanel key={text} index={index} selectedIndex={selected} idPrefix="settings">
          {text}
        </TabsPanel>
      ))}
    </>
  )
}

describe('Tabs（Fluid radix/tabs）', () => {
  it('渲染 tablist / tab / tabpanel 并互相关联', () => {
    render(<Controlled />)
    expect(screen.getByRole('tablist', { name: '设置分区' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['概览概览', '账户账户', '偏好偏好'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.id).toBe('settings-tab-0')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('settings-panel-0')
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe('settings-tab-0')
    expect(panel.textContent).toBe('概览内容')
  })

  it('方向键与 Home/End 移动焦点（手动激活），Enter 选中', async () => {
    const onSelect = vi.fn()
    render(<Controlled onSelect={onSelect} />)
    const [first, second, third] = screen.getAllByRole('tab') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    act(() => first.focus())
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    // Radix 的 roving focus 在 setTimeout 中移动焦点
    await wait(0)
    expect(document.activeElement).toBe(second)
    // 手动激活：方向键只移动焦点
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(second, { key: 'End' })
    await wait(0)
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Home' })
    await wait(0)
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    await wait(0)
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(2)
    expect(third.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('偏好内容')
  })

  it('activeLabel 折叠为仅图标时，未选中标签的可读名称仍是 label', async () => {
    render(<Controlled activeLabel />)
    await frame()
    expect(screen.getByRole('tab', { name: '账户' }).getAttribute('aria-label')).toBe('账户')
    expect(screen.getByRole('tab', { name: '偏好' }).textContent).toBe('')
    // 选中的标签显示文字，不再需要 aria-label
    expect(screen.getByRole('tab', { name: '概览' }).hasAttribute('aria-label')).toBe(false)
  })

  it('键盘焦点显示 2px 描边 + 2px 间隙的焦点环', async () => {
    render(<Controlled />)
    await frame()
    const first = screen.getAllByRole('tab')[0] as HTMLElement
    const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      // happy-dom 不区分键盘与指针焦点，这里把这次聚焦视为键盘焦点
      return selector === ':focus-visible'
    })
    act(() => first.focus())
    matches.mockRestore()
    const ring = document.querySelector('[data-slot="tabs-focus-ring"]')
    expect(ring?.className).toContain('outline-2')
    expect(ring?.className).toContain('outline-offset-2')
    expect(ring?.className).toContain('outline-(--focus-ring)')
  })

  it('不包 UiRoot 时选中药丸滑向新标签（m.* 在 MotionFeatures 之下）', async () => {
    render(<Controlled />)
    await frame()
    await frame()
    const pill = document.querySelector<HTMLElement>('[data-slot="tabs-indicator"]')
    expect(pill).toBeTruthy()
    expect(px(pill?.style.left ?? '')).toBe(4)
    const third = screen.getAllByRole('tab')[2] as HTMLElement
    act(() => third.focus())
    fireEvent.keyDown(third, { key: 'Enter' })
    await frame()
    await frame()
    const midway = px(pill?.style.left ?? '')
    expect(midway).toBeGreaterThan(4)
    expect(midway).toBeLessThan(204)
    await wait(800)
    expect(px(pill?.style.left ?? '')).toBe(204)
  })
})
