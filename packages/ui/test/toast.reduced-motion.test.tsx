import { act, cleanup, render } from '@testing-library/react'
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

const { resetToastsForTesting, Toaster, toast } = await import('../src/components/toast.tsx')
const { UiRoot } = await import('../src/components/ui-root.tsx')

Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  act(() => resetToastsForTesting())
})

const labels = { region: '通知', announcement: '通知', close: '关闭' }
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe('减少动态效果时 Toast 只淡入淡出', () => {
  for (const [name, wrap] of [
    ['UiRoot 之下', true],
    ['单独挂载（无 UiRoot）', false],
  ] as const) {
    it(`${name}：进场第一帧无位移无缩放，退场同样无位移`, async () => {
      const toaster = <Toaster labels={labels} position="top-center" />
      render(wrap ? <UiRoot>{toaster}</UiRoot> : toaster)
      act(() => {
        toast('已保存')
      })
      const li = document.querySelector('ol > li') as HTMLElement
      await frame()
      // 正常动效下此时约为 translateY(-7px) scale(0.97)
      expect(li.style.transform).not.toMatch(/translateY\(-?[1-9]/)
      expect(li.style.transform).not.toMatch(/scale\(0\.9/)
      await wait(300)
      expect(li.style.opacity).toBe('1')

      act(() => toast.dismiss())
      await frame()
      expect(li.style.transform).not.toMatch(/translateY\(-?[1-9]/)
      expect(li.style.transform).not.toMatch(/scale\(0\.9/)
    })
  }
})
