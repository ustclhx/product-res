import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatMessage,
  InputMessage,
  type InputMessageProps,
  ThinkingIndicator,
  ThinkingStep,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ToolCall,
  type ToolCallState,
} from '../src/chat.ts'
import { waitForAnimation } from './animation.ts'

// happy-dom 的 Web Animations 在取消时抛出未处理的 AbortError；与其他测试一样让 motion 走 JS 动画
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

describe('ThinkingIndicator', () => {
  it('显示传入的文字，圆点不进入可读名称', () => {
    render(<ThinkingIndicator label="正在思考" />)
    const indicator = screen.getByText('正在思考').parentElement as HTMLElement
    expect(indicator.textContent).toBe('正在思考')
    expect(indicator.querySelector('[data-thinking-dots]')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    // 页面另有状态播报区域，指示本身不是实时区域
    expect(indicator.closest('[role="status"], [aria-live]')).toBeNull()
  })

  it('showIcon={false} 时只有文字', () => {
    const { container } = render(<ThinkingIndicator label="正在思考" showIcon={false} />)
    expect(container.querySelector('[data-thinking-dots]')).toBeNull()
  })
})

describe('ThinkingSteps', () => {
  function Steps({ busy = false }: { busy?: boolean }) {
    return (
      <ThinkingSteps>
        <ThinkingStepsHeader busy={busy}>{busy ? '思考中…' : '已思考 6 秒'}</ThinkingStepsHeader>
        <ThinkingStepsContent>
          <ThinkingStep>先取三个渠道的新客数与投放金额。</ThinkingStep>
        </ThinkingStepsContent>
      </ThinkingSteps>
    )
  }

  it('默认折叠，点击后 aria-expanded 切换并显示推理内容', async () => {
    render(<Steps />)
    const trigger = screen.getByRole('button', { name: '已思考 6 秒' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // Radix 只在展开时写 aria-controls；面板是按钮后面的兄弟元素
    const panel = trigger.nextElementSibling as HTMLElement
    expect(panel.hidden).toBe(true)

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.hidden).toBe(false)
    expect(screen.getByText('先取三个渠道的新客数与投放金额。')).toBeTruthy()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // 收起动画结束后才加 hidden
    await waitForAnimation(() => expect(panel.hidden).toBe(true))
  })

  it('busy 时标题前显示三点，按钮名称只有标题文字', () => {
    render(<Steps busy />)
    const trigger = screen.getByRole('button', { name: '思考中…' })
    expect(trigger.querySelector('[data-thinking-dots]')).not.toBeNull()
  })
})

describe('ChatMessage', () => {
  it('用户消息为右侧气泡，助手消息带头像与内容列', () => {
    render(
      <>
        <ChatMessage from="user" entrance={false}>
          问题
        </ChatMessage>
        <ChatMessage from="assistant" entrance={false}>
          回答
        </ChatMessage>
      </>,
    )
    const user = screen.getByText('问题').closest('[data-chat-role]') as HTMLElement
    const assistant = screen.getByText('回答').closest('[data-chat-role]') as HTMLElement
    expect(user.dataset.chatRole).toBe('user')
    // 用户行是查询容器，气泡靠右
    expect(user.className.split(/\s+/)).toEqual(expect.arrayContaining(['@container', 'items-end']))
    expect(user.querySelector('[data-chat-avatar]')).toBeNull()
    // 气泡用 --chat-fill（深色下 --secondary 与卡片同色），宽度与内边距按容器查询
    const bubble = screen.getByText('问题')
    expect(bubble.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-chat-fill', 'max-w-17/20', '@chat-message:max-w-4/5']),
    )
    expect(assistant.dataset.chatRole).toBe('assistant')
    expect(assistant.querySelector('[data-chat-avatar]')?.getAttribute('aria-hidden')).toBe('true')
    // 消息本身不是地标或控件，列表语义由调用方的 <ol> / <li> 提供
    expect(user.getAttribute('role')).toBeNull()
  })

  it('助手消息是查询容器：窄时头像与 leading 同一行、正文通栏在下，宽时头像列 + 内容列', () => {
    render(
      <ChatMessage
        from="assistant"
        entrance={false}
        leading={<button type="button">已思考 6 秒</button>}
        actions={<button type="button">复制回复</button>}
      >
        回答
      </ChatMessage>,
    )
    const message = screen.getByText('回答').closest('[data-chat-role]') as HTMLElement
    const cls = (selector: string) =>
      (message.querySelector(selector) as HTMLElement).className.split(/\s+/)
    expect(message.className.split(/\s+/)).toContain('@container')
    // 头像与 leading 在第一行（容器窄时），宽时 leading 仍在内容列顶部
    expect(cls('[data-chat-avatar-cell]')).toEqual(
      expect.arrayContaining(['col-start-1', 'row-start-1']),
    )
    expect(cls('[data-chat-leading]')).toEqual(
      expect.arrayContaining(['col-start-2', 'row-start-1']),
    )
    expect(
      screen.getByRole('button', { name: '已思考 6 秒' }).closest('[data-chat-leading]'),
    ).not.toBeNull()
    // 正文与操作区：窄时跨两列在第二行，宽（@chat-message:）时只占内容列
    expect(cls('[data-chat-body]')).toEqual(
      expect.arrayContaining([
        'col-span-2',
        'row-start-2',
        '@chat-message:col-span-1',
        '@chat-message:col-start-2',
      ]),
    )
    expect(cls('[data-chat-body]')).not.toContain('@chat-message:row-start-1')
    expect(
      screen.getByRole('button', { name: '复制回复' }).closest('[data-chat-body]'),
    ).not.toBeNull()
    // 头像窄时 24px，宽时 28px；网格窄时居中对齐，宽时顶端对齐
    expect(cls('[data-chat-avatar]')).toEqual(
      expect.arrayContaining(['size-6', '@chat-message:size-7']),
    )
    expect(cls('[data-chat-layout]')).toEqual(
      expect.arrayContaining([
        'items-center',
        '@chat-message:items-start',
        '@chat-message:gap-x-3',
      ]),
    )
  })

  it('没有 leading 时宽版式正文回到第一行，窄版式仍在头像下方', () => {
    render(
      <ChatMessage from="assistant" entrance={false}>
        回答
      </ChatMessage>,
    )
    const body = screen.getByText('回答').closest('[data-chat-body]') as HTMLElement
    expect(body.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['row-start-2', '@chat-message:row-start-1']),
    )
  })

  it('avatar={false} 不显示头像', () => {
    const { container } = render(
      <ChatMessage from="assistant" avatar={false} entrance={false}>
        回答
      </ChatMessage>,
    )
    expect(container.querySelector('[data-chat-avatar]')).toBeNull()
  })

  it('流式中内容区带 data-chat-streaming、末段带 data-chat-tail（光标约定），aria-busy，没有状态徽标', () => {
    render(
      <ChatMessage from="assistant" status="streaming" entrance={false}>
        生成中的正文
      </ChatMessage>,
    )
    const message = screen.getByText('生成中的正文').closest('[data-chat-role]') as HTMLElement
    expect(message.getAttribute('aria-busy')).toBe('true')
    const content = message.querySelector('[data-chat-content]') as HTMLElement
    expect(content.hasAttribute('data-chat-streaming')).toBe(true)
    // 光标只画在 [data-chat-streaming] [data-chat-tail] 之后：纯文本子节点包成的最后一段带标记
    const tail = content.querySelector('[data-chat-tail]') as HTMLElement
    expect(tail.tagName).toBe('P')
    expect(tail.textContent).toBe('生成中的正文')
    expect(message.querySelector('[data-chat-status]')).toBeNull()
  })

  it.each([
    ['aborted', '已停止'],
    ['failed', '失败'],
    ['incomplete', '未完成'],
    ['retrying', '重试中'],
  ] as const)('%s 状态在正文下方显示徽标并保留正文', (status, label) => {
    render(
      <ChatMessage
        from="assistant"
        status={status}
        statusLabel={label}
        statusDetail="说明文字"
        entrance={false}
      >
        已生成的部分
      </ChatMessage>,
    )
    const message = screen.getByText('已生成的部分').closest('[data-chat-role]') as HTMLElement
    const row = message.querySelector(`[data-chat-status="${status}"]`) as HTMLElement
    expect(row.textContent).toBe(`${label}说明文字`)
    expect(message.querySelector('[data-chat-streaming]')).toBeNull()
    // 正文在状态之前
    const content = message.querySelector('[data-chat-content]') as HTMLElement
    expect(content.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('actions 插槽渲染在内容之后', () => {
    render(
      <ChatMessage
        from="assistant"
        entrance={false}
        actions={<button type="button">复制回复</button>}
      >
        回答
      </ChatMessage>,
    )
    const copy = screen.getByRole('button', { name: '复制回复' })
    expect(copy.closest('[data-chat-actions]')).not.toBeNull()
  })

  it('长 URL 与长单词按 overflow-wrap:anywhere 换行，不撑出 390px 容器', () => {
    const longUrl = `https://product.ezarouter.cc/${'a'.repeat(300)}`
    render(
      <div style={{ width: 390 }}>
        <ChatMessage from="user" entrance={false}>
          {longUrl}
        </ChatMessage>
        <ChatMessage from="assistant" entrance={false}>
          {longUrl}
        </ChatMessage>
      </div>,
    )
    for (const node of screen.getAllByText(longUrl)) {
      const wrapper = node.closest('.wrap-anywhere') as HTMLElement
      expect(wrapper).not.toBeNull()
      expect(wrapper.className).toContain('min-w-0')
    }
  })
})

describe('ToolCall', () => {
  const labels = { pending: '准备中', running: '执行中', done: '已完成', error: '出错' }

  it.each(['pending', 'running', 'done', 'error'] as ToolCallState[])(
    '%s 状态显示对应文字，没有详情时不渲染展开按钮',
    (state) => {
      const { container } = render(<ToolCall name="工具" state={state} labels={labels} />)
      expect(container.querySelector(`[data-tool-state="${state}"]`)?.textContent).toBe(
        labels[state],
      )
      expect(screen.queryByRole('button')).toBeNull()
    },
  )

  it('有详情时头部为可折叠按钮，默认收起', () => {
    render(
      <ToolCall name="查询报告数据" state="done" labels={labels}>
        读取了第 3 章
      </ToolCall>,
    )
    const trigger = screen.getByRole('button', { name: /查询报告数据/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('读取了第 3 章')).toBeTruthy()
  })
  it('可展开时卡片占满消息列、名称撑开，展开后头部去掉下圆角', () => {
    render(
      <ToolCall name="查询报告数据" state="done" labels={labels}>
        详情
      </ToolCall>,
    )
    const trigger = screen.getByRole('button', { name: /查询报告数据/ })
    const root = trigger.closest('[data-tool-call]') as HTMLElement
    expect(root.className.split(/\s+/)).toContain('w-full')
    expect(screen.getByText('查询报告数据').className.split(/\s+/)).toContain('flex-1')
    expect(trigger.className).not.toContain('rounded-b-none')
    fireEvent.click(trigger)
    expect(trigger.className.split(/\s+/)).toContain('rounded-b-none')
  })

  it('没有详情时宽度随内容，中性徽标用 --chat-fill', () => {
    const { container } = render(<ToolCall name="工具" state="pending" labels={labels} />)
    const root = container.querySelector('[data-tool-call]') as HTMLElement
    expect(root.className.split(/\s+/)).not.toContain('w-full')
    expect(container.querySelector('[data-tool-state="pending"]')?.className).toContain(
      'bg-chat-fill',
    )
  })

  it('受控 open：点击只回调 onOpenChange，展开状态以 open 为准', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <ToolCall name="查询" state="done" labels={labels} open={false} onOpenChange={onOpenChange}>
        详情
      </ToolCall>,
    )
    const trigger = screen.getByRole('button', { name: /查询/ })
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    rerender(
      <ToolCall name="查询" state="done" labels={labels} open onOpenChange={onOpenChange}>
        详情
      </ToolCall>,
    )
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ThinkingSteps 受控', () => {
  it('受控 open：点击只回调 onOpenChange，展开状态以 open 为准', () => {
    const onOpenChange = vi.fn()
    const steps = (open: boolean) => (
      <ThinkingSteps open={open} onOpenChange={onOpenChange}>
        <ThinkingStepsHeader>已思考</ThinkingStepsHeader>
        <ThinkingStepsContent>
          <ThinkingStep>推理</ThinkingStep>
        </ThinkingStepsContent>
      </ThinkingSteps>
    )
    const { rerender } = render(steps(false))
    const trigger = screen.getByRole('button', { name: '已思考' })
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    rerender(steps(true))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('InputMessage', () => {
  const labels = { message: '消息', send: '发送', stop: '停止生成' }

  function Composer(
    props: Partial<InputMessageProps> & { initial?: string; onSendSpy?: (v: string) => void },
  ) {
    const { initial = '', onSendSpy, ...rest } = props
    const [value, setValue] = useState(initial)
    return (
      <InputMessage
        value={value}
        onValueChange={setValue}
        onSend={(v) => onSendSpy?.(v)}
        placeholder="输入消息"
        labels={labels}
        {...rest}
      />
    )
  }

  const textarea = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement

  it('查询容器在内层：根节点不是 inline-size 容器，在 flex-wrap 父级中高度不被撑大（版式见 ui-preview e2e）', () => {
    const { container } = render(<Composer />)
    const root = container.querySelector('[data-input-message]') as HTMLElement
    expect(root.className.split(/\s+/)).not.toContain('@container')
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'min-w-0']))
    const body = root.querySelector('[data-input-message-body]') as HTMLElement
    expect(body.className.split(/\s+/)).toContain('@container')
    expect(body.contains(textarea())).toBe(true)
  })

  it('Enter 发送去掉首尾空白的内容，Shift+Enter 不发送', () => {
    const onSend = vi.fn()
    render(<Composer initial="  你好  " onSendSpy={onSend} />)
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('你好')
  })

  it('输入法组字中的 Enter 不发送', () => {
    const onSend = vi.fn()
    render(<Composer initial="ni" onSendSpy={onSend} />)
    fireEvent.keyDown(textarea(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(textarea(), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('空内容、disabled、sendDisabled 与生成中都不发送', () => {
    const onSend = vi.fn()
    const { unmount } = render(<Composer initial="   " onSendSpy={onSend} />)
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()

    for (const extra of [{ disabled: true }, { sendDisabled: true }, { busy: true }]) {
      const { unmount: off } = render(<Composer initial="内容" onSendSpy={onSend} {...extra} />)
      fireEvent.keyDown(textarea(), { key: 'Enter' })
      off()
    }
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disabled 时输入框不可编辑，sendDisabled 时仍可编辑', () => {
    const { unmount } = render(<Composer disabled />)
    expect(textarea().disabled).toBe(true)
    unmount()
    render(<Composer sendDisabled />)
    expect(textarea().disabled).toBe(false)
  })

  it('点击发送按钮发送', () => {
    const onSend = vi.fn()
    render(<Composer initial="内容" onSendSpy={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSend).toHaveBeenCalledWith('内容')
  })

  it('busy 时发送换成停止，切换后焦点从按钮移到输入框', () => {
    const onStop = vi.fn()
    function Harness() {
      const [busy, setBusy] = useState(false)
      return (
        <Composer
          initial="内容"
          busy={busy}
          onSendSpy={() => setBusy(true)}
          onStop={() => {
            onStop()
            setBusy(false)
          }}
        />
      )
    }
    render(<Harness />)
    const action = screen.getByRole('button', { name: '发送' })
    act(() => action.focus())
    fireEvent.click(action)
    // 同一个按钮元素换成停止；焦点不留在按钮上
    expect(screen.getByRole('button', { name: '停止生成' })).toBe(action)
    expect(document.activeElement).toBe(textarea())

    // 键盘：Tab 到停止按钮并按 Enter（原生按钮的 Enter 激活为 click）
    act(() => action.focus())
    expect(document.activeElement).toBe(action)
    fireEvent.keyDown(action, { key: 'Enter' })
    fireEvent.click(action)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '发送' })).toBe(action)
    expect(document.activeElement).toBe(textarea())
  })

  it('焦点不在按钮上时切换 busy 不抢焦点', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    const { rerender } = render(<Composer busy={false} />)
    act(() => outside.focus())
    rerender(<Composer busy />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('leading 与 trailing 插槽在底栏两侧，输入框有高度上限', () => {
    render(
      <Composer
        leading={<button type="button">通用模型</button>}
        trailing={<span>预计 4 积分</span>}
      />,
    )
    expect(screen.getByRole('button', { name: '通用模型' })).toBeTruthy()
    expect(screen.getByText('预计 4 积分')).toBeTruthy()
    expect(textarea().className).toContain('max-h-44')
    expect(textarea().className).toContain('field-sizing-content')
    // 没有附件入口
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('没有 onStop 时停止按钮不可用', () => {
    render(<Composer initial="内容" busy />)
    expect((screen.getByRole('button', { name: '停止生成' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('发送后草稿先清空（按钮变为不可用、焦点离开按钮但不触发 blur），busy 再翻转时焦点仍回到输入框', () => {
    const labelsProps = {
      placeholder: '输入消息',
      labels,
      onValueChange: () => {},
      onSend: () => {},
    }
    const { rerender } = render(<InputMessage value="内容" {...labelsProps} />)
    const action = screen.getByRole('button', { name: '发送' })
    act(() => action.focus())
    // 调用方在 onSend 中清空草稿：按钮变为 disabled
    rerender(<InputMessage value="" {...labelsProps} />)
    // 浏览器让被禁用按钮失去焦点时不一定派发 blur；模拟 activeElement 已回到 body 而 blur 未触发
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => document.body,
    })
    try {
      rerender(<InputMessage value="" busy onStop={() => {}} {...labelsProps} />)
    } finally {
      Reflect.deleteProperty(document, 'activeElement')
      if (descriptor) Object.defineProperty(Document.prototype, 'activeElement', descriptor)
    }
    expect(document.activeElement).toBe(textarea())
  })

  it('textareaRef 指向输入框；textareaProps 不能覆盖可读名称', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<Composer textareaRef={ref} textareaProps={{ 'aria-label': '被覆盖', name: 'draft' }} />)
    expect(ref.current).toBe(textarea())
    expect(textarea().getAttribute('name')).toBe('draft')
  })

  it('不可用时用 --chat-fill 底（深色下比卡片亮），内边距按容器查询', () => {
    const { container } = render(<Composer disabled />)
    const root = container.querySelector('[data-input-message]') as HTMLElement
    expect(root.className.split(/\s+/)).toContain('bg-chat-fill')
    // 查询容器在内层 [data-input-message-body]（见上方 flex-wrap 用例）
    expect(textarea().closest('.\\@container')).not.toBeNull()
    expect(textarea().className).toContain('@chat-message:px-3.5')
    expect(textarea().className).not.toMatch(/(^|\s)sm:/)
  })
})
