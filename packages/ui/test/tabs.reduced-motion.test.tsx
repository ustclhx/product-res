import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Home, User } from 'lucide-react'
import { useState } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

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

const { Tabs, TabsItem } = await import('../src/components/tabs.tsx')

// 假布局：第 i 个标签 left = 4 + 100i，宽 80（见 tabs.test.tsx）
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
// 标签文字的测量宽度（折叠标签动画的目标宽度）也取 40
define('offsetWidth', (el) => (indexOf(el) === null ? 40 : 80))
define('offsetHeight', (el) => (indexOf(el) === null ? 0 : 36))
define('offsetParent', (el) => el.parentElement)
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

function Controlled({ activeLabel = false }: { activeLabel?: boolean }) {
  const [selected, setSelected] = useState(0)
  return (
    <Tabs
      aria-label="分区"
      selectedIndex={selected}
      onSelect={setSelected}
      activeLabel={activeLabel}
    >
      <TabsItem index={0} label="概览" icon={Home} />
      <TabsItem index={1} label="账户" icon={User} />
      <TabsItem index={2} label="偏好" />
    </Tabs>
  )
}

describe('Tabs 减少动态效果时无位移动画', () => {
  it('选中药丸直接落到新标签，不经过中间位置', async () => {
    render(<Controlled />)
    await frame()
    await frame()
    const pill = document.querySelector<HTMLElement>('[data-slot="tabs-indicator"]')
    expect(pill?.style.left).toBe('4px')
    const third = screen.getAllByRole('tab')[2] as HTMLElement
    act(() => third.focus())
    fireEvent.keyDown(third, { key: 'Enter' })
    await frame()
    // 正常动效下此时约在 4px 与 204px 之间
    expect(pill?.style.left).toBe('204px')
  })

  it('activeLabel 折叠标签直接展开到终宽', async () => {
    render(<Controlled activeLabel />)
    await frame()
    const second = screen.getByRole('tab', { name: '账户' })
    act(() => second.focus())
    fireEvent.keyDown(second, { key: 'Enter' })
    await frame()
    await wait(0)
    await frame()
    const label = second.querySelector<HTMLElement>('span.overflow-hidden')
    expect(label?.style.width).toBe('40px')
  })
})
