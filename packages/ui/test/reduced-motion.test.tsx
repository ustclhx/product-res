import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  Tooltip,
  UiRoot,
} = await import('../src/index.ts')

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())
afterAll(() => vi.unstubAllGlobals())

/** 下一帧：motion 的 JS 动画在 requestAnimationFrame 中推进 */
const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

describe('减少动态效果时无位移动画', () => {
  it('Switch 滑块直接落到终点，不经过中间位置', async () => {
    function Controlled() {
      const [on, setOn] = useState(false)
      return <Switch label="Sync" checked={on} onToggle={() => setOn((v) => !v)} />
    }
    render(
      <UiRoot>
        <Controlled />
      </UiRoot>,
    )
    const control = screen.getByRole('switch', { name: 'Sync' })
    const thumb = control.firstElementChild as HTMLElement
    expect(thumb.style.transform).toContain('translateY(2px)')
    fireEvent.click(control)
    // 34px 轨道 − 16px 滑块 − 两侧各 2px = 14px 行程，终点 x = 2 + 14
    await frame()
    expect(thumb.style.transform).toContain('translateX(16px)')
  })

  it('Tooltip 不滑入，出现的第一帧即在最终位置', async () => {
    render(
      <UiRoot>
        <Tooltip content="Copy link" side="top">
          <Button>Copy</Button>
        </Tooltip>
      </UiRoot>,
    )
    const trigger = screen.getByRole('button', { name: 'Copy' })
    act(() => trigger.focus())
    fireEvent.focus(trigger)
    const panel = (await screen.findAllByText('Copy link'))[0] as HTMLElement
    await frame()
    // 正常动效下此时约为 translateY(3.97px)，正在滑入
    const y = /translateY\(([-\d.]+)px\)/.exec(panel.style.transform)?.[1]
    expect(Number(y ?? 0)).toBe(0)
  })

  it('AlertDialog 不缩放：打开后第一帧 scale 已为 1', async () => {
    render(
      <UiRoot>
        <AlertDialog defaultOpen>
          <AlertDialogContent>
            <AlertDialogTitle>确认</AlertDialogTitle>
            <AlertDialogDescription>说明</AlertDialogDescription>
            <AlertDialogCancel>取消</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      </UiRoot>,
    )
    const dialog = await screen.findByRole('alertdialog')
    await frame()
    expect(dialog.style.transform).not.toMatch(/scale\(0\.9/)
    expect(dialog.style.transform).toContain('translateX(-50%)')
  })

  it('Dialog 不缩放；Select 弹层不下滑', async () => {
    render(
      <UiRoot>
        <Dialog defaultOpen>
          <DialogContent closeLabel="关闭">
            <DialogTitle>标题</DialogTitle>
            <Select>
              <SelectTrigger placeholder="选择套餐" aria-label="套餐" />
              <SelectContent>
                <SelectItem index={0} value="free">
                  Free
                </SelectItem>
              </SelectContent>
            </Select>
          </DialogContent>
        </Dialog>
      </UiRoot>,
    )
    const dialog = await screen.findByRole('dialog')
    await frame()
    expect(dialog.style.transform).not.toMatch(/scale\(0\.9/)

    const trigger = screen.getByRole('combobox', { name: '套餐' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const listbox = await screen.findByRole('listbox')
    await frame()
    // 弹层外层的 motion.div 在正常动效下从 translateY(var(--popup-enter-y)) scaleY(0.96) 开始
    const panel = listbox.closest('[style*="transform"]') as HTMLElement | null
    expect(panel?.style.transform ?? 'none').not.toMatch(/scaleY\(0\.9/)
  })
})
