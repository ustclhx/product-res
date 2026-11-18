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

const { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } =
  await import('../src/components/combobox.tsx')
const { UiRoot } = await import('../src/index.ts')

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

describe('减少动态效果时 Combobox 无位移动画', () => {
  it('弹层不下滑、不纵向缩放：打开后第一帧即在最终位置', async () => {
    render(
      <UiRoot>
        <Combobox items={['苹果', '香蕉']}>
          <ComboboxInput placeholder="搜索水果" aria-label="水果" />
          <ComboboxContent>
            <ComboboxEmpty>没有匹配项</ComboboxEmpty>
            <ComboboxList>
              {(item) => <ComboboxItem value={item as string}>{item as string}</ComboboxItem>}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </UiRoot>,
    )
    fireEvent.keyDown(screen.getByRole('combobox', { name: '水果' }), { key: 'ArrowDown' })
    const listbox = await screen.findByRole('listbox')
    await frame()
    // 正常动效下此时为 translateY(var(--popup-enter-y)) scaleY(0.96) 附近，正在展开
    const popup = listbox.closest('[data-side]') as HTMLElement
    expect(popup.style.transform).not.toMatch(/scaleY\(0\.9/)
    expect(popup.style.transform).not.toMatch(/translateY\((?!0px)/)
  })
})
