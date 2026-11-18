import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Combobox,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  type ComboboxProps,
} from '../src/components/combobox.tsx'

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
// motion 在有 Element.animate 时走 WAAPI，happy-dom 的实现不推进；删掉后走 JS 动画，与 motion-features.test.tsx 一致
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

const fruits = [
  { value: 'apple', label: '苹果 Apple' },
  { value: 'apricot', label: '杏 Apricot' },
  { value: 'banana', label: '香蕉 Banana' },
]

type SingleProps = Pick<
  ComboboxProps<(typeof fruits)[number]>,
  'value' | 'defaultValue' | 'onValueChange' | 'name'
>

function Single(props: SingleProps & { error?: string; clearable?: boolean }) {
  const { error, clearable, ...root } = props
  return (
    <Combobox items={fruits} {...root}>
      {clearable ? (
        <ComboboxInput
          placeholder="搜索水果"
          aria-label="水果"
          clearable
          clearLabel="清除"
          {...(error && { error })}
        />
      ) : (
        <ComboboxInput placeholder="搜索水果" aria-label="水果" {...(error && { error })} />
      )}
      <ComboboxContent>
        <ComboboxEmpty>没有匹配项</ComboboxEmpty>
        <ComboboxList>
          {(item) =>
            typeof item === 'string' ? null : (
              <ComboboxItem value={item.value}>{item.label}</ComboboxItem>
            )
          }
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

const input = () => screen.getByRole('combobox', { name: '水果' }) as HTMLInputElement
const optionLabels = () => screen.queryAllByRole('option').map((o) => o.textContent)
const activeOption = () => {
  const id = input().getAttribute('aria-activedescendant')
  return id ? document.getElementById(id)?.textContent : null
}

describe('Combobox', () => {
  it('渲染输入框：占位文字、折叠状态，错误文字经 aria-describedby 关联', () => {
    render(<Single error="必填" />)
    const field = input()
    expect(field.placeholder).toBe('搜索水果')
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe('必填')
    // 字段框的边框取 --field-border 之外的实色错误边框，焦点环为 2px 描边加间隙
    const frame = field.parentElement as HTMLElement
    expect(frame.className).toContain('border-destructive')
    expect(frame.className).toContain('has-[input:focus-visible]:outline-2')
    // 展开按钮不可 Tab、对辅助技术隐藏，不需要多语言名称
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('输入时过滤列表，并高亮第一项', async () => {
    render(<Single />)
    fireEvent.change(input(), { target: { value: 'ap' } })
    await screen.findByRole('listbox')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(optionLabels()).toEqual(['苹果 Apple', '杏 Apricot'])
    expect(activeOption()).toBe('苹果 Apple')
  })

  it('上下键移动 aria-activedescendant，越过末尾回到输入框再绕回', async () => {
    render(<Single />)
    const field = input()
    field.focus()
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    await screen.findByRole('listbox')
    expect(activeOption()).toBe('苹果 Apple')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(activeOption()).toBe('杏 Apricot')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(activeOption()).toBe('香蕉 Banana')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.hasAttribute('aria-activedescendant')).toBe(false)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(activeOption()).toBe('苹果 Apple')
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(field.hasAttribute('aria-activedescendant')).toBe(false)
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(activeOption()).toBe('香蕉 Banana')
  })

  it('ArrowUp 打开时高亮最后一项', async () => {
    render(<Single />)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    await screen.findByRole('listbox')
    expect(activeOption()).toBe('香蕉 Banana')
  })

  it('非受控：Enter 选中高亮项，字段显示其文字并收起', async () => {
    const onValueChange = vi.fn()
    render(<Single onValueChange={onValueChange} name="fruit" />)
    const field = input()
    fireEvent.change(field, { target: { value: 'ban' } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('banana')
    expect(field.value).toBe('香蕉 Banana')
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect((document.querySelector('input[name="fruit"]') as HTMLInputElement).value).toBe('banana')
    // 再次打开时列出全部项，已选项带勾和 aria-selected
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(optionLabels()).toHaveLength(3)
    const picked = screen.getAllByRole('option').find((o) => o.textContent === '香蕉 Banana')
    expect(picked?.getAttribute('aria-selected')).toBe('true')
  })

  it('受控：Enter 交给调用方更新，外部改值时字段同步', async () => {
    function Controlled() {
      const [value, setValue] = useState('apple')
      return (
        <>
          <Single value={value} onValueChange={setValue} />
          <button type="button" onClick={() => setValue('apricot')}>
            外部改值
          </button>
          <output>{value}</output>
        </>
      )
    }
    render(<Controlled />)
    const field = input()
    expect(field.value).toBe('苹果 Apple')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    await screen.findByRole('listbox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(document.querySelector('output')?.textContent).toBe('banana')
    expect(field.value).toBe('香蕉 Banana')
    fireEvent.click(screen.getByRole('button', { name: '外部改值' }))
    expect(field.value).toBe('杏 Apricot')
  })

  it('Esc 收起并把字段恢复为已选项', async () => {
    render(<Single defaultValue="apple" />)
    const field = input()
    fireEvent.change(field, { target: { value: 'xyz' } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.value).toBe('苹果 Apple')
  })

  it('点击选项选中，指针按下不夺走输入框焦点', async () => {
    render(<Single />)
    const field = input()
    field.focus()
    fireEvent.click(field)
    await screen.findByRole('listbox')
    const option = screen.getAllByRole('option')[1] as HTMLElement
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(field.value).toBe('杏 Apricot')
    expect(document.activeElement).toBe(field)
  })

  it('无匹配项时显示调用方传入的空结果文字', async () => {
    render(<Single />)
    fireEvent.change(input(), { target: { value: 'zzz' } })
    await screen.findByRole('listbox')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('没有匹配项')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('清除按钮使用调用方传入的名称，清空选择', () => {
    const onValueChange = vi.fn()
    render(<Single clearable defaultValue="apple" onValueChange={onValueChange} />)
    const clear = screen.getByRole('button', { name: '清除' })
    fireEvent.click(clear)
    expect(onValueChange).toHaveBeenCalledWith('')
    expect(input().value).toBe('')
    expect(document.activeElement).toBe(input())
  })

  it('onCreate：无精确匹配时末尾出现创建行，文字由 createLabel 提供', async () => {
    function Creatable() {
      const [items, setItems] = useState(fruits)
      const [value, setValue] = useState('')
      return (
        <Combobox
          items={items}
          value={value}
          onValueChange={setValue}
          onCreate={(q) => {
            const made = { value: q.toLowerCase(), label: q }
            setItems((list) => [...list, made])
            return made
          }}
          createLabel={(q) => `新建「${q}」`}
        >
          <ComboboxInput placeholder="搜索水果" aria-label="水果" />
          <ComboboxContent>
            <ComboboxEmpty>没有匹配项</ComboboxEmpty>
            <ComboboxList>
              {(item) =>
                typeof item === 'string' ? null : (
                  <ComboboxItem value={item.value}>{item.label}</ComboboxItem>
                )
              }
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )
    }
    render(<Creatable />)
    const field = input()
    fireEvent.change(field, { target: { value: 'Mango' } })
    await screen.findByRole('listbox')
    expect(optionLabels()).toEqual(['新建「Mango」'])
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('Mango')
  })

  it('多选：点选切换、标签带调用方的移除名称，Backspace 删除最后一个', async () => {
    const onValueChange = vi.fn()
    function Multi() {
      const [value, setValue] = useState<string[]>(['apple'])
      return (
        <Combobox
          items={fruits}
          multiple
          value={value}
          onValueChange={(next) => {
            onValueChange(next)
            setValue(next)
          }}
          name="fruits"
        >
          <ComboboxChips
            placeholder="添加水果"
            aria-label="水果"
            chipsLabel="已选水果"
            removeLabel={(label) => `移除 ${label}`}
          />
          <ComboboxContent>
            <ComboboxEmpty>没有匹配项</ComboboxEmpty>
            <ComboboxList>
              {(item) =>
                typeof item === 'string' ? null : (
                  <ComboboxItem value={item.value}>{item.label}</ComboboxItem>
                )
              }
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )
    }
    render(<Multi />)
    const field = input()
    expect(screen.getByRole('toolbar', { name: '已选水果' })).toBeTruthy()
    // 已有标签时不显示占位文字
    expect(field.placeholder).toBe('')
    fireEvent.click(field)
    await screen.findByRole('listbox')
    fireEvent.click(screen.getAllByRole('option')[2] as HTMLElement)
    expect(onValueChange).toHaveBeenLastCalledWith(['apple', 'banana'])
    // 未输入时点选不收起，便于继续添加
    expect(field.getAttribute('aria-expanded')).toBe('true')
    expect(
      screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(2)
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[name="fruits"]')].map((i) => i.value),
    ).toEqual(['apple', 'banana'])

    fireEvent.click(screen.getByRole('button', { name: '移除 苹果 Apple', hidden: true }))
    expect(onValueChange).toHaveBeenLastCalledWith(['banana'])
    fireEvent.keyDown(field, { key: 'Backspace' })
    expect(onValueChange).toHaveBeenLastCalledWith([])
    await wait(400)
    expect(field.placeholder).toBe('添加水果')
  })

  it('无 UiRoot 时弹层与勾的动画也在推进（m.* 都在 MotionFeatures 之下）', async () => {
    render(<Single defaultValue="apple" />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const listbox = await screen.findByRole('listbox')
    // 结构：Popover Content（asChild）= motion.div > Elevated > ScrollArea > … > listbox
    const popup = listbox.closest('[data-side]') as HTMLElement
    await frame()
    await frame()
    expect(popup.style.opacity).not.toBe('0')
    await wait(500)
    expect(popup.style.opacity).toBe('1')
    expect(popup.style.transform).toBe('none')

    // 新勾选的一项：pathLength 0 → 1（motion 写成 stroke-dasharray 的第一段）
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    await wait(300)
    const checked = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')
    expect(checked?.textContent).toBe('杏 Apricot')
    expect(checked?.querySelector('path')?.getAttribute('stroke-dasharray')).toMatch(/^1(px)? /)
  })
})
