import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  type CommandMenuItemData,
  type CommandMenuLabels,
  CommandMenuList,
  CommandMenuTabs,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
} from '../src/components/command-menu.tsx'
import { frame, waitForAnimation } from './animation.ts'

// happy-dom 不做布局：给行（data-fluid-hover-index）一个纵向排列的假布局，第 i 行 top = 4 + 40i、高 36，
// 让 useFluidHover 能发布位置、高亮能动起来
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
define('offsetLeft', (el) => (indexOf(el) === null ? 0 : 4))
define('offsetTop', (el) => {
  const i = indexOf(el)
  return i === null ? 0 : 4 + i * 40
})
define('offsetWidth', (el) => (indexOf(el) === null ? 0 : 300))
define('offsetHeight', (el) => (indexOf(el) === null ? 0 : 36))
define('offsetParent', (el) => el.parentElement)

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())
afterAll(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(proto, key, descriptor)
    else Reflect.deleteProperty(proto, key)
  }
})

const labels: CommandMenuLabels = {
  placeholder: '搜索命令',
  suggestions: '建议',
  tabs: '筛选结果',
  selectHint: '选择',
  tabsHint: '切换',
  closeHint: '关闭',
}

const items: CommandMenuItemData[] = [
  { value: 'new', label: '新建项目', group: '项目', shortcut: 'mod+n' },
  { value: 'open', label: '打开项目', action: '打开', group: '项目', keywords: ['open'] },
  { value: 'archived', label: '归档项目', group: '项目', disabled: true },
  { value: 'settings', label: '设置', description: '偏好与账户', group: '导航' },
]

const highlighted = () =>
  screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')

function Inline({ onSelect }: { onSelect?: (item: CommandMenuItemData) => void }) {
  return (
    <CommandMenu items={items} labels={labels} {...(onSelect && { onSelect })}>
      <CommandMenuInput />
      <CommandMenuList>
        <CommandMenuEmpty>没有结果</CommandMenuEmpty>
      </CommandMenuList>
      <CommandMenuFooter />
    </CommandMenu>
  )
}

describe('CommandMenu（Fluid default/command-menu）', () => {
  it('渲染搜索框、分组与行；文案全部来自 labels', async () => {
    render(<Inline />)
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    expect(input.getAttribute('placeholder')).toBe('搜索命令')
    expect(screen.getByRole('group', { name: '项目' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '导航' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByText('选择')).toBeTruthy()
    // 不在对话框内、没有标签栏时不显示「关闭」「切换」提示
    expect(screen.queryByText('关闭')).toBeNull()
    expect(screen.queryByText('切换')).toBeNull()
    await frame()
    // 第一行默认高亮，搜索框经 aria-activedescendant 指向它
    expect(highlighted()?.textContent).toContain('新建项目')
    expect(input.getAttribute('aria-activedescendant')).toBe(highlighted()?.id)
  })

  it('输入过滤，无匹配时显示 Empty', async () => {
    render(<Inline />)
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    fireEvent.change(input, { target: { value: 'open' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['打开项目'])
    fireEvent.change(input, { target: { value: '偏好' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['设置偏好与账户'])
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('没有结果')
    // 内联时 Esc 清空输入
    fireEvent.keyDown(input, { key: 'Escape' })
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('上下键移动高亮（跳过禁用行、两端循环），Enter 执行回调', async () => {
    const onSelect = vi.fn()
    const itemSelect = vi.fn()
    const withHandler = items.map((item) =>
      item.value === 'settings' ? { ...item, onSelect: itemSelect } : item,
    )
    render(
      <CommandMenu items={withHandler} labels={labels} onSelect={onSelect}>
        <CommandMenuInput />
        <CommandMenuList />
        <CommandMenuFooter />
      </CommandMenu>,
    )
    const input = screen.getByRole('combobox')
    await frame()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted()?.textContent).toBe('打开项目')
    // 底部 Enter 提示用行的 action
    expect(
      document.querySelector('[data-slot="command-menu-footer-action"]')?.textContent,
    ).toContain('打开')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted()?.textContent).toContain('设置')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted()?.textContent).toContain('新建项目')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(highlighted()?.textContent).toContain('设置')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(itemSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'settings' }))
    fireEvent.keyDown(input, { key: 'Home' })
    expect(highlighted()?.textContent).toContain('新建项目')
    fireEvent.keyDown(input, { key: 'End' })
    expect(highlighted()?.textContent).toContain('设置')
  })

  it('没有输入时 suggestions 列在 labels.suggestions 分组下', () => {
    render(
      <CommandMenu items={items} labels={labels} suggestions={['settings']}>
        <CommandMenuInput />
        <CommandMenuList />
      </CommandMenu>,
    )
    const group = screen.getByRole('group', { name: '建议' })
    expect(group.textContent).toContain('设置')
  })

  it('标签栏用 labels.tabs 命名，搜索框中 ← → 切换标签', () => {
    function WithTabs() {
      const [tab, setTab] = useState('all')
      return (
        <CommandMenu items={items} labels={labels}>
          <CommandMenuInput />
          <CommandMenuTabs
            tabs={[
              { value: 'all', label: '全部' },
              { value: 'nav', label: '导航' },
            ]}
            value={tab}
            onValueChange={setTab}
          />
          <CommandMenuList />
          <CommandMenuFooter />
          <output data-testid="tab">{tab}</output>
        </CommandMenu>
      )
    }
    render(<WithTabs />)
    expect(screen.getByRole('tablist', { name: '筛选结果' })).toBeTruthy()
    expect(screen.getByText('切换')).toBeTruthy()
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(screen.getByTestId('tab').textContent).toBe('nav')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(screen.getByTestId('tab').textContent).toBe('all')
  })

  it('对话框：快捷键打开，Enter 执行并关闭；Esc 关闭后焦点回到打开前的元素', async () => {
    const onSelect = vi.fn()
    render(
      <>
        <button type="button">外部按钮</button>
        <CommandMenuDialog title="命令面板" description="搜索要执行的命令">
          <CommandMenu items={items} labels={labels} onSelect={onSelect}>
            <CommandMenuInput />
            <CommandMenuList />
            <CommandMenuFooter />
          </CommandMenu>
        </CommandMenuDialog>
      </>,
    )
    const opener = screen.getByRole('button', { name: '外部按钮' })
    act(() => opener.focus())
    fireEvent.keyDown(opener, { key: 'k', code: 'KeyK', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: '命令面板' })
    // 不显示关闭按钮（DialogContent showCloseButton={false}），对话框内显示 Esc 提示
    expect(dialog.querySelector('button[data-slot="button"]')).toBeNull()
    expect(screen.getByText('关闭')).toBeTruthy()
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    await frame()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'new' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))

    // 再次打开，Esc 关闭
    fireEvent.keyDown(opener, { key: 'k', code: 'KeyK', metaKey: true })
    const input2 = await screen.findByRole('combobox', { name: '搜索命令' })
    await waitFor(() => expect(document.activeElement).toBe(input2))
    fireEvent.keyDown(input2, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('不包 UiRoot 时高亮在行间滑动（m.* 在 MotionFeatures 之下）', async () => {
    render(<Inline />)
    const input = screen.getByRole('combobox')
    await waitForAnimation(() =>
      expect(document.querySelector('[data-slot="fluid-hover-highlight"]')).toBeTruthy(),
    )
    const fill = document.querySelector<HTMLElement>('[data-slot="fluid-hover-highlight"]')
    expect(fill).toBeTruthy()
    const y = () => Number(/translateY\(([-\d.]+)px\)/.exec(fill?.style.transform ?? '')?.[1] ?? 0)
    await waitForAnimation(() => expect(y()).toBe(4))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitForAnimation(() => expect(y()).toBe(44))
  })
})

describe('快捷键解析与键帽', () => {
  it('mod 在 Mac 上为 ⌘、其他平台为 Ctrl；匹配 ⌘ 或 Ctrl', () => {
    expect(formatShortcut('mod+shift+p', true)).toEqual(['⌘', '⇧', 'P'])
    expect(formatShortcut('mod+shift+p', false)).toEqual(['Ctrl', 'Shift', 'P'])
    expect(formatShortcut('⌘K', true)).toEqual(['⌘', 'K'])
    const parsed = parseShortcut('mod+k')
    const press = { key: 'k', code: 'KeyK', altKey: false, shiftKey: false }
    expect(matchesShortcut({ ...press, metaKey: true, ctrlKey: false }, parsed)).toBe(true)
    expect(matchesShortcut({ ...press, metaKey: false, ctrlKey: true }, parsed)).toBe(true)
    expect(matchesShortcut({ ...press, metaKey: false, ctrlKey: false }, parsed)).toBe(false)
  })
})
