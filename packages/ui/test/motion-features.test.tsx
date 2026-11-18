import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChatMessage,
  InputMessage,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ToolCall,
} from '../src/chat.ts'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tooltip,
} from '../src/index.ts'
import { waitForAnimation } from './animation.ts'

// `m.*` 只有在 LazyMotion（MotionFeatures）之下才有动画能力，之外会静止在 initial 状态且不报错。
// 静态检查（motion-imports.test.ts）只能确认文件里包了 MotionFeatures；这里在不包 UiRoot 的情况下实际渲染
// 每个带动效的组件，断言动画确实在推进，从而保证每个 m.* 元素（包括 SelectItem 这种在 SelectContent 之下
// 渲染的子组件）都处在某个 MotionFeatures 之下。
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 1)

describe('m.* 都在 MotionFeatures 之下（动画会推进）', () => {
  it('Dialog 与 AlertDialog 的面板从 0.97 放大到 1', async () => {
    render(
      <>
        <Dialog defaultOpen>
          <DialogContent showCloseButton={false}>
            <DialogTitle>标题</DialogTitle>
          </DialogContent>
        </Dialog>
        <AlertDialog defaultOpen>
          <AlertDialogContent>
            <AlertDialogTitle>确认</AlertDialogTitle>
            <AlertDialogDescription>说明</AlertDialogDescription>
            <AlertDialogCancel>取消</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      </>,
    )
    // 两个模态框同时打开时彼此 aria-hidden，查询时包含隐藏元素
    const panels = [
      screen.getByRole('dialog', { hidden: true }),
      screen.getByRole('alertdialog', { hidden: true }),
    ]
    for (const panel of panels) expect(scaleOf(panel)).toBeLessThan(1)
    await waitForAnimation(() => {
      for (const panel of panels) expect(scaleOf(panel)).toBe(1)
    })
  })

  it('Tooltip 淡入滑入', async () => {
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    )
    const copy = screen.getByRole('button', { name: 'Copy' })
    act(() => copy.focus())
    fireEvent.focus(copy)
    const tip = (await screen.findAllByText('Copy link'))[0] as HTMLElement
    await waitForAnimation(() => {
      expect(tip.style.opacity).toBe('1')
      expect(tip.style.transform).toBe('none')
    })
  })

  it('Select 弹层展开、选中项与 Checkbox 的勾画出', async () => {
    render(
      <>
        <Select defaultValue="free">
          <SelectTrigger placeholder="选择套餐" aria-label="套餐" />
          <SelectContent>
            <SelectItem index={0} value="free">
              Free
            </SelectItem>
          </SelectContent>
        </Select>
        <Checkbox aria-label="同意" />
      </>,
    )
    // Select 弹层打开后其余内容被 aria-hidden，先操作复选框
    const box = screen.getByRole('checkbox', { name: '同意' })
    fireEvent.click(box)
    const trigger = screen.getByRole('combobox', { name: '套餐' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const listbox = await screen.findByRole('listbox')
    // role="listbox" 落在 Radix 的 Content 上，其第一个子元素是本包的 motion.div
    const popup = listbox.firstElementChild as HTMLElement
    await waitForAnimation(() => {
      expect(popup.style.opacity).toBe('1')
      // pathLength 0 → 1：motion 把它写成 stroke-dasharray 的第一段
      for (const path of [box.querySelector('path'), listbox.querySelector('path')]) {
        expect(path?.getAttribute('stroke-dasharray')).toMatch(/^1(px)? /)
      }
    })
  })

  it('对话组件：ChatMessage 入场、ThinkingSteps 与 ToolCall 展开、InputMessage 图标', async () => {
    render(
      <>
        <ChatMessage from="assistant">回答</ChatMessage>
        <ThinkingIndicator label="正在思考" />
        <ThinkingSteps>
          <ThinkingStepsHeader>已思考 6 秒</ThinkingStepsHeader>
          <ThinkingStepsContent>
            <ThinkingStep>推理</ThinkingStep>
          </ThinkingStepsContent>
        </ThinkingSteps>
        <ToolCall
          name="查询报告数据"
          state="done"
          labels={{ pending: '准备中', running: '执行中', done: '已完成', error: '出错' }}
        >
          详情
        </ToolCall>
        <InputMessage
          value=""
          onValueChange={() => {}}
          onSend={() => {}}
          placeholder="输入消息"
          labels={{ message: '消息', send: '发送', stop: '停止' }}
        />
      </>,
    )
    const message = screen.getByText('回答').closest('[data-chat-role]') as HTMLElement
    const steps = screen.getByRole('button', { name: '已思考 6 秒' })
    const tool = screen.getByRole('button', { name: /查询报告数据/ })
    fireEvent.click(steps)
    fireEvent.click(tool)
    const chevrons = [steps, tool].map(
      (button) => button.querySelector('span[aria-hidden="true"]:last-child') as HTMLElement,
    )
    const step = screen.getByText('推理').parentElement as HTMLElement
    await waitForAnimation(() => {
      expect(message.style.opacity).toBe('1')
      expect(step.style.opacity).toBe('1')
      for (const chevron of chevrons) expect(chevron.style.transform).toContain('rotate(90deg)')
    })
  })
})
