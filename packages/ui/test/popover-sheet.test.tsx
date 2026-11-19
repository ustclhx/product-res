import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '../src/index.ts'
import { waitForAnimation } from './animation.ts'

// Radix 的弹层依赖这些浏览器 API，happy-dom 未实现
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

function Notifications() {
  return (
    <>
      <Button>Elsewhere</Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button>Bell</Button>
        </PopoverTrigger>
        <PopoverContent align="end" aria-labelledby="pop-title">
          <PopoverTitle id="pop-title">通知</PopoverTitle>
          <Button>全部标为已读</Button>
        </PopoverContent>
      </Popover>
    </>
  )
}

describe('Popover（shadcn 结构 + Fluid 弹层外观）', () => {
  it('服务端只输出触发器，触发器声明弹出对话框', () => {
    const html = renderToString(<Notifications />)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('通知')
  })

  it('点击打开为带名称的 dialog，动画推进到不透明；Escape 关闭后焦点回到触发器', async () => {
    render(<Notifications />)
    const trigger = screen.getByRole('button', { name: 'Bell' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '通知' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
    await waitForAnimation(() => expect(dialog.style.opacity).toBe('1'))

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('点击外部空白处关闭，焦点落空时还给触发器；退场期间面板 inert', async () => {
    render(<Notifications />)
    const trigger = screen.getByRole('button', { name: 'Bell' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    // Radix 在打开后的下一轮事件循环才注册外部点击监听
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    ;(document.activeElement as HTMLElement | null)?.blur()
    // 本版 Radix 把左键的外部按下推迟到随后的 click 才关闭
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 })
    fireEvent.click(document.body)
    await waitFor(() => expect(dialog.hasAttribute('inert')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

describe('Popover 触发方式与焦点兜底', () => {
  it('Trigger 支持 render；打开前焦点在 body（Safari 点按钮不聚焦）时，外部点击关闭后焦点还给触发按钮', async () => {
    render(
      <Popover>
        <PopoverTrigger render={<Button>Bell</Button>} />
        <PopoverContent aria-labelledby="t2">
          <PopoverTitle id="t2">通知</PopoverTitle>
          <PopoverClose render={<Button>完成</Button>} />
        </PopoverContent>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Bell' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: '通知' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 })
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Sheet（shadcn 结构 + Fluid mobile-drawer 动效）', () => {
  function BottomSheet() {
    return (
      <Sheet>
        <SheetTrigger asChild>
          <Button>Open</Button>
        </SheetTrigger>
        <SheetContent side="bottom" closeLabel="关闭">
          <SheetTitle>通知</SheetTitle>
          <SheetClose asChild>
            <Button>完成</Button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    )
  }

  it('从底部滑入：模态 dialog、带把手与关闭按钮；Escape 关闭后焦点回到触发器', async () => {
    render(<BottomSheet />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    trigger.focus()
    fireEvent.click(trigger)
    const sheet = await screen.findByRole('dialog', { name: '通知' })
    expect(sheet.getAttribute('aria-modal')).toBe('true')
    expect(sheet.dataset.side).toBe('bottom')
    expect(sheet.querySelector('[aria-hidden="true"].rounded-full')).not.toBeNull()
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
    // 滑入动画推进到原位
    await waitForAnimation(() => expect(sheet.style.transform).toBe('none'))

    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('关闭按钮与 SheetClose 都能关闭', async () => {
    render(<BottomSheet />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(await screen.findByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('没有 Trigger 的受控用法关闭后，焦点回到打开前的元素', async () => {
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Menu</Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="left" showCloseButton={false}>
              <SheetTitle>导航</SheetTitle>
              <SheetClose asChild>
                <Button>完成</Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
        </>
      )
    }
    render(<Controlled />)
    const opener = screen.getByRole('button', { name: 'Menu' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(await screen.findByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

describe('Sheet 的 render、container 与退场遮罩', () => {
  it('Trigger / Close 支持 render；面板渲染到 container；退场时遮罩不拦截点击', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    render(
      <Sheet>
        <SheetTrigger render={<Button>Open</Button>} />
        <SheetContent
          side="bottom"
          showCloseButton={false}
          container={host}
          aria-describedby={undefined}
        >
          <SheetTitle>通知</SheetTitle>
          <SheetClose render={<Button>完成</Button>} />
        </SheetContent>
      </Sheet>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const sheet = await screen.findByRole('dialog', { name: '通知' })
    expect(host.contains(sheet)).toBe(true)
    expect(sheet.hasAttribute('aria-describedby')).toBe(false)
    const overlay = host.querySelector('.fixed.inset-0') as HTMLElement
    expect(overlay.className).not.toContain('pointer-events-none')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(overlay.className).toContain('pointer-events-none'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    host.remove()
  })
})

// 类型用例（由 typecheck 检查）：与 DialogContent 一致，显示关闭按钮时必须传 closeLabel
function SheetContentTypeCases() {
  return (
    <>
      <SheetContent closeLabel="关闭" />
      <SheetContent showCloseButton={false} />
      {/* @ts-expect-error 显示关闭按钮时必须传 closeLabel */}
      <SheetContent />
    </>
  )
}
void SheetContentTypeCases
