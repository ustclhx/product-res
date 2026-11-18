import { act, cleanup, render } from '@testing-library/react'
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

const { CommandMenu, CommandMenuInput, CommandMenuList } = await import(
  '../src/components/command-menu.tsx'
)

// 面板高度跟随内容列（offsetHeight + ResizeObserver）。这里让内容列的高度可控，并手动触发 ResizeObserver
let columnHeight = 200
const observers = new Set<() => void>()
class FakeResizeObserver {
  callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
  }
  observe() {
    observers.add(this.callback)
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.callback)
  }
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

const proto = HTMLElement.prototype
const original = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
Object.defineProperty(proto, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    const isColumn = this.parentElement?.parentElement?.getAttribute('data-slot') === 'command-menu'
    return isColumn ? columnHeight : 0
  },
})
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())
afterAll(() => {
  vi.unstubAllGlobals()
  if (original) Object.defineProperty(proto, 'offsetHeight', original)
  else Reflect.deleteProperty(proto, 'offsetHeight')
})

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

const labels = {
  placeholder: '搜索命令',
  suggestions: '建议',
  tabs: '筛选结果',
  selectHint: '选择',
  tabsHint: '切换',
  closeHint: '关闭',
}

describe('CommandMenu 减少动态效果时面板高度直接跳到终值', () => {
  it('内容变矮后的第一帧即为新高度', async () => {
    const { container } = render(
      <CommandMenu items={[{ value: 'a', label: 'A' }]} labels={labels}>
        <CommandMenuInput />
        <CommandMenuList />
      </CommandMenu>,
    )
    const frameEl = container.querySelector<HTMLElement>('[data-slot="command-menu"] > div')
    await wait(50)
    expect(frameEl?.style.height).toBe('200px')
    columnHeight = 100
    act(() => {
      for (const callback of observers) callback()
    })
    await frame()
    // 正常动效下此时仍在 200px 与 100px 之间（spring.moderate）
    expect(frameEl?.style.height).toBe('100px')
  })
})
