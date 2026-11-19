import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Dropdown,
  DropdownContent,
  DropdownEmpty,
  DropdownLabel,
  DropdownMenu,
  DropdownSearch,
  DropdownSeparator,
  DropdownSub,
  DropdownSubContent,
  DropdownSubTrigger,
  DropdownTrigger,
  MenuItem,
} from '../src/components/dropdown.tsx'

// Radix 的弹层依赖这些浏览器 API，happy-dom 未实现
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
// happy-dom 的 Web Animations 在卸载时抛出 AbortError；去掉后 motion 退回到 JS 驱动的动画
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
const key = (k: string) => fireEvent.keyDown(document.activeElement as Element, { key: k })

function ActionsMenu({ onSelect }: { onSelect: (label: string) => void }) {
  const labels = ['Rename', 'Duplicate', 'Archive', 'Delete']
  return (
    <DropdownMenu>
      <DropdownTrigger>Actions</DropdownTrigger>
      <DropdownContent>
        <DropdownLabel>File</DropdownLabel>
        {labels.slice(0, 3).map((label, i) => (
          <MenuItem key={label} index={i} label={label} onSelect={() => onSelect(label)} />
        ))}
        <DropdownSeparator />
        <MenuItem index={3} label="Delete" onSelect={() => onSelect('Delete')} />
      </DropdownContent>
    </DropdownMenu>
  )
}

async function openWith(trigger: HTMLElement, k: 'Enter' | ' ' | 'ArrowDown') {
  act(() => trigger.focus())
  fireEvent.keyDown(trigger, { key: k })
  const menu = await screen.findByRole('menu')
  // 打开后两帧内把焦点交给第一个可用项
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' })),
  )
  return menu
}

describe('DropdownMenu（Fluid radix/dropdown）', () => {
  it('Enter / Space / ArrowDown 都能打开，渲染菜单、分组标题与分隔线', async () => {
    for (const k of ['Enter', ' ', 'ArrowDown'] as const) {
      const { unmount } = render(<ActionsMenu onSelect={() => {}} />)
      const trigger = screen.getByRole('button', { name: 'Actions' })
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
      const menu = await openWith(trigger, k)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getAllByRole('menuitem').map((el) => el.getAttribute('aria-label'))).toEqual([
        'Rename',
        'Duplicate',
        'Archive',
        'Delete',
      ])
      expect(menu.textContent).toContain('File')
      expect(screen.getByRole('separator')).toBeTruthy()
      unmount()
    }
  })

  it('上下键移动、Home / End 跳到首尾，Enter 选中触发 onSelect 并关闭', async () => {
    const onSelect = vi.fn()
    render(<ActionsMenu onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await openWith(trigger, 'Enter')
    const item = (name: string) => screen.getByRole('menuitem', { name })

    key('ArrowDown')
    await waitFor(() => expect(document.activeElement).toBe(item('Duplicate')))
    key('ArrowUp')
    await waitFor(() => expect(document.activeElement).toBe(item('Rename')))
    key('End')
    await waitFor(() => expect(document.activeElement).toBe(item('Delete')))
    key('Home')
    await waitFor(() => expect(document.activeElement).toBe(item('Rename')))
    key('ArrowDown')
    await waitFor(() => expect(document.activeElement).toBe(item('Duplicate')))

    key('Enter')
    expect(onSelect).toHaveBeenCalledWith('Duplicate')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // 退场动画播完后卸载，焦点回到触发器
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('Esc 关闭且焦点回到触发器', async () => {
    const onOpenChange = vi.fn()
    render(
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownTrigger>Actions</DropdownTrigger>
        <DropdownContent>
          <MenuItem index={0} label="Rename" />
        </DropdownContent>
      </DropdownMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await openWith(trigger, 'Enter')
    key('Escape')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('未传 render 的触发器带 2px 描边加 2px 间隙焦点环；disabled 时不可打开', () => {
    render(
      <DropdownMenu disabled>
        <DropdownTrigger>Actions</DropdownTrigger>
        <DropdownContent>
          <MenuItem index={0} label="Rename" />
        </DropdownContent>
      </DropdownMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger.className).toContain('focus-visible:outline-2')
    expect(trigger.className).toContain('focus-visible:outline-offset-2')
    expect(trigger.className).toContain('focus-visible:outline-(--focus-ring)')
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('render 属性把任意元素作为触发器', async () => {
    render(
      <DropdownMenu>
        <DropdownTrigger render={<button type="button" className="custom" />}>x</DropdownTrigger>
        <DropdownContent>
          <MenuItem index={0} label="Rename" />
        </DropdownContent>
      </DropdownMenu>,
    )
    const trigger = document.querySelector('button.custom') as HTMLElement
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await openWith(trigger, 'Enter')
  })

  it('子菜单：ArrowRight 打开并聚焦首项，ArrowLeft 关闭并回到触发行', async () => {
    const onSelect = vi.fn()
    render(
      <DropdownMenu>
        <DropdownTrigger>Actions</DropdownTrigger>
        <DropdownContent>
          <MenuItem index={0} label="Rename" />
          <DropdownSub>
            <DropdownSubTrigger index={1} label="Move to" />
            <DropdownSubContent>
              <MenuItem index={0} label="Inbox" onSelect={() => onSelect('Inbox')} />
              <MenuItem index={1} label="Archive" />
            </DropdownSubContent>
          </DropdownSub>
        </DropdownContent>
      </DropdownMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await openWith(trigger, 'Enter')
    key('ArrowDown')
    const subTrigger = screen.getByRole('menuitem', { name: 'Move to' })
    await waitFor(() => expect(document.activeElement).toBe(subTrigger))
    expect(subTrigger.getAttribute('aria-haspopup')).toBe('menu')

    key('ArrowRight')
    await waitFor(() => expect(subTrigger.getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Inbox' })),
    )

    key('ArrowLeft')
    await waitFor(() => expect(subTrigger.getAttribute('aria-expanded')).toBe('false'))
    await waitFor(() => expect(document.activeElement).toBe(subTrigger))
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1))

    // 再次打开子菜单并选中：整个菜单关闭
    key('ArrowRight')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Inbox' })),
    )
    key('Enter')
    expect(onSelect).toHaveBeenCalledWith('Inbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('复选项：menuitemcheckbox 的 aria-checked 跟随状态，切换时菜单保持打开，勾画出', async () => {
    function Columns() {
      const [checked, setChecked] = useState<number[]>([0])
      const toggle = (i: number) =>
        setChecked((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i].sort()))
      return (
        <DropdownMenu>
          <DropdownTrigger>Columns</DropdownTrigger>
          <DropdownContent checkedIndices={checked}>
            {['Name', 'Email', 'Plan'].map((label, i) => (
              <MenuItem
                key={label}
                index={i}
                label={label}
                checked={checked.includes(i)}
                onSelect={() => toggle(i)}
              />
            ))}
          </DropdownContent>
        </DropdownMenu>
      )
    }
    render(<Columns />)
    const trigger = screen.getByRole('button', { name: 'Columns' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menu')
    const item = (name: string) => screen.getByRole('menuitemcheckbox', { name })
    expect(item('Name').getAttribute('aria-checked')).toBe('true')
    expect(item('Email').getAttribute('aria-checked')).toBe('false')

    await waitFor(() => expect(document.activeElement).toBe(item('Name')))
    key('ArrowDown')
    await waitFor(() => expect(document.activeElement).toBe(item('Email')))
    key(' ')
    expect(item('Email').getAttribute('aria-checked')).toBe('true')
    // 多选切换不关闭菜单
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // 勾从 pathLength 0 画到 1（motion 写成 stroke-dasharray 的第一段）
    await wait(300)
    expect(item('Email').querySelector('path')?.getAttribute('stroke-dasharray')).toMatch(
      /^1(px)? /,
    )

    fireEvent.click(item('Name'))
    expect(item('Name').getAttribute('aria-checked')).toBe('false')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('单选：checkedIndex 驱动 menuitemradio 的 aria-checked', async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownTrigger>Sort</DropdownTrigger>
        <DropdownContent checkedIndex={1}>
          <MenuItem index={0} label="Newest" checked={false} />
          <MenuItem index={1} label="Oldest" checked />
        </DropdownContent>
      </DropdownMenu>,
    )
    await screen.findByRole('menu')
    expect(screen.getByRole('menuitemradio', { name: 'Oldest' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Newest' }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('搜索：打开即聚焦搜索框，输入过滤菜单项，无结果显示 DropdownEmpty，方向键进入列表', async () => {
    const fruits = ['Apple', 'Banana', 'Cherry']
    function Searchable() {
      const [q, setQ] = useState('')
      const shown = fruits.filter((f) => f.toLowerCase().includes(q.toLowerCase()))
      return (
        <DropdownMenu>
          <DropdownTrigger>Fruit</DropdownTrigger>
          <DropdownContent>
            <DropdownSearch value={q} onValueChange={setQ} placeholder="搜索水果" />
            {shown.map((f, i) => (
              <MenuItem key={f} index={i} label={f} />
            ))}
            {shown.length === 0 && <DropdownEmpty>没有结果</DropdownEmpty>}
          </DropdownContent>
        </DropdownMenu>
      )
    }
    render(<Searchable />)
    const trigger = screen.getByRole('button', { name: 'Fruit' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const search = await screen.findByRole('searchbox', { name: '搜索水果' })
    expect(search.getAttribute('placeholder')).toBe('搜索水果')
    await waitFor(() => expect(document.activeElement).toBe(search))

    fireEvent.change(search, { target: { value: 'an' } })
    expect(screen.getAllByRole('menuitem').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Banana',
    ])
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('没有结果')

    fireEvent.change(search, { target: { value: '' } })
    // 搜索框内输入不被菜单的 typeahead 截走；↓ 进入第一项，↑ 从第一项回到搜索框
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const apple = screen.getByRole('menuitem', { name: 'Apple' })
    expect(document.activeElement).toBe(apple)
    key('ArrowUp')
    expect(document.activeElement).toBe(search)
    // 焦点在行上时输入字符会转进搜索框
    act(() => apple.focus())
    key('c')
    expect(document.activeElement).toBe(search)
    expect((search as HTMLInputElement).value).toBe('c')
  })

  it('openOnHover：鼠标停留打开，移出触发器与菜单后关闭', async () => {
    render(
      <DropdownMenu>
        <DropdownTrigger openOnHover delay={10} closeDelay={10}>
          Hover
        </DropdownTrigger>
        <DropdownContent>
          <MenuItem index={0} label="Rename" />
        </DropdownContent>
      </DropdownMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'Hover' })
    fireEvent.pointerOver(trigger, { pointerType: 'mouse' })
    // 等待状态而不是固定时长：完整并行测试负载下计时器可能晚于 30ms 触发
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
    // 悬停打开只是预览，不抢焦点
    expect(document.activeElement).not.toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.pointerOut(trigger, { pointerType: 'mouse' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  })
})

describe('Dropdown（内联面板）', () => {
  it('role="group" 面板，方向键 / Home / End 循环移动，Enter 触发 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <Dropdown aria-label="视图">
        {['List', 'Board', 'Calendar'].map((label, i) => (
          <MenuItem key={label} index={i} label={label} onSelect={() => onSelect(label)} />
        ))}
      </Dropdown>,
    )
    expect(screen.getByRole('group', { name: '视图' })).toBeTruthy()
    const item = (name: string) => screen.getByRole('menuitem', { name })
    // 第一项是唯一的 Tab 停靠点
    expect(item('List').tabIndex).toBe(0)
    expect(item('Board').tabIndex).toBe(-1)
    act(() => item('List').focus())
    key('ArrowDown')
    expect(document.activeElement).toBe(item('Board'))
    key('End')
    expect(document.activeElement).toBe(item('Calendar'))
    key('ArrowDown')
    expect(document.activeElement).toBe(item('List'))
    key('ArrowUp')
    expect(document.activeElement).toBe(item('Calendar'))
    key('Home')
    expect(document.activeElement).toBe(item('List'))
    key('Enter')
    expect(onSelect).toHaveBeenCalledWith('List')
  })

  it('禁用项不触发 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <Dropdown aria-label="视图">
        <MenuItem index={0} label="List" disabled onSelect={onSelect} />
      </Dropdown>,
    )
    const item = screen.getByRole('menuitem', { name: 'List' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item)
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('m.* 都在 MotionFeatures 之下（不包 UiRoot 时动画推进）', () => {
  it('弹层淡入、内联面板中新勾选的勾画出', async () => {
    function Inline() {
      const [checked, setChecked] = useState<number | undefined>(undefined)
      return (
        <Dropdown aria-label="排序" {...(checked !== undefined && { checkedIndex: checked })}>
          <MenuItem
            index={0}
            label="Newest"
            checked={checked === 0}
            onSelect={() => setChecked(0)}
          />
        </Dropdown>
      )
    }
    render(
      <>
        <Inline />
        <DropdownMenu defaultOpen>
          <DropdownTrigger>Actions</DropdownTrigger>
          <DropdownContent>
            <MenuItem index={0} label="Rename" />
          </DropdownContent>
        </DropdownMenu>
      </>,
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Newest' }))
    const menu = await screen.findByRole('menu')
    await frame()
    await frame()
    // role="menu" 落在本包的 motion.div 上（Radix Content asChild）
    expect(menu.style.opacity).not.toBe('0')
    await wait(500)
    expect(menu.style.opacity).toBe('1')
    const path = screen.getByRole('menuitemradio', { name: 'Newest' }).querySelector('path')
    expect(path?.getAttribute('stroke-dasharray')).toMatch(/^1(px)? /)
  })
})

describe('SSR', () => {
  it('内联面板与关闭的弹出菜单都能在服务端渲染', () => {
    const html = renderToString(
      <>
        <Dropdown aria-label="视图" checkedIndex={0}>
          <DropdownLabel>Layout</DropdownLabel>
          <MenuItem index={0} label="List" checked />
          <MenuItem index={1} label="Board" checked={false} />
        </Dropdown>
        <DropdownMenu>
          <DropdownTrigger>Actions</DropdownTrigger>
          <DropdownContent>
            <DropdownSearch value="" onValueChange={() => {}} placeholder="搜索" />
            <MenuItem index={0} label="Rename" />
          </DropdownContent>
        </DropdownMenu>
      </>,
    )
    expect(html).toMatch(/role="group"[^>]*aria-label="视图"/)
    expect(html).toMatch(/role="menuitemradio" aria-checked="true"[^>]*aria-label="List"/)
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>Actions<\/button>/)
    expect(html).not.toContain('role="menu"')
  })
})
