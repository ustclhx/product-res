// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import type { ChatUIMessage } from './conversation.ts'

const state = vi.hoisted(() => ({ text: { reasoning: { display: true } } }))
vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))

import { ChatMessageView, registerToolRenderer, toolCallState } from './message-parts.tsx'
import { resetToolRenderers } from './tool-renderers.ts'

// happy-dom 的 Web Animations 在取消时让 finished 拒绝（未处理）；去掉 animate，motion 改用脚本动画
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

const assistant = (parts: ChatUIMessage['parts']): ChatUIMessage => ({
  id: 'a',
  role: 'assistant',
  parts,
})

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  state.text.reasoning.display = true
  resetToolRenderers()
})

afterEach(() => {
  cleanup()
  overwriteGetLocale(() => baseLocale)
})

describe('推理', () => {
  const message = assistant([
    { type: 'reasoning', text: 'Private thought' },
    { type: 'text', text: 'Answer' },
  ])

  it('展示开启时默认折叠，展开按钮标明状态', () => {
    render(<ChatMessageView message={message} live={false} status={undefined} />)
    const toggle = screen.getByRole('button', { name: m.chat_ui_reasoning() })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Answer')).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Private thought')).toBeTruthy()
  })

  it('展示关闭时没有推理区块', () => {
    state.text.reasoning.display = false
    const { container } = render(
      <ChatMessageView message={message} live={false} status={undefined} />,
    )
    expect(screen.queryByRole('button', { name: m.chat_ui_reasoning() })).toBeNull()
    expect(container.textContent).not.toContain('Private thought')
  })
})

describe('工具调用', () => {
  const tool = (state: 'output-error' | 'output-available'): ChatUIMessage['parts'][number] =>
    state === 'output-error'
      ? {
          type: 'tool-search_reports',
          toolCallId: 'call_1',
          state,
          input: { query: 'secret internal id 42' },
          errorText: 'upstream stack trace',
        }
      : {
          type: 'tool-search_reports',
          toolCallId: 'call_1',
          state,
          input: { query: 'secret internal id 42' },
          output: { count: 3 },
        }

  it('未注册的工具只显示通用标签与状态，不含内部名称、参数与错误详情', () => {
    const { container } = render(
      <ChatMessageView
        message={assistant([tool('output-error')])}
        live={false}
        status={undefined}
      />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain(m.chat_ui_tool())
    expect(text).toContain(m.chat_ui_tool_error())
    expect(text).not.toContain('search_reports')
    expect(text).not.toContain('secret internal id')
    expect(text).not.toContain('upstream stack trace')
    // 没有详情时不是可展开的按钮
    expect(container.querySelector('button[aria-expanded]')).toBeNull()
  })

  it('已注册的工具显示显示名，详情可展开', () => {
    registerToolRenderer('search_reports', {
      label: () => 'Search reports',
      render: (call) => <span>{`Found ${(call.output as { count: number }).count} reports`}</span>,
    })
    render(
      <ChatMessageView
        message={assistant([tool('output-available')])}
        live={false}
        status={undefined}
      />,
    )
    const toggle = screen.getByRole('button', { name: /Search reports/ })
    expect(toggle.textContent).toContain(m.chat_ui_tool_done())
    fireEvent.click(toggle)
    expect(screen.getByText('Found 3 reports')).toBeTruthy()
  })

  it('AI SDK 工具状态映射为四态', () => {
    expect(toolCallState('input-streaming')).toBe('pending')
    expect(toolCallState('input-available')).toBe('running')
    expect(toolCallState('output-available')).toBe('done')
    expect(toolCallState('output-error')).toBe('error')
    expect(toolCallState('output-denied')).toBe('error')
  })
})

describe('其他内容', () => {
  it('未知 part 被忽略，其余部分正常显示', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const message = assistant([
      { type: 'step-start' },
      { type: 'source-url', sourceId: 's', url: 'https://product.ezarouter.cc/leak' },
      { type: 'data-retry', data: { n: 1 } },
      { type: 'text', text: 'Visible answer' },
      // 未来 SDK 版本的新类型
      { type: 'future-part', payload: 'raw' } as unknown as ChatUIMessage['parts'][number],
    ])
    const { container } = render(
      <ChatMessageView message={message} live={false} status={undefined} />,
    )
    expect(container.textContent).toContain('Visible answer')
    expect(container.textContent).not.toContain('example.com/leak')
    expect(container.textContent).not.toContain('raw')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('等待首个输出时显示思考中指示，正文到达后消失', () => {
    const { container, rerender } = render(
      <ChatMessageView message={assistant([])} live status={undefined} />,
    )
    expect(container.querySelector('[data-thinking-indicator]')?.textContent).toContain(
      m.chat_ui_status_thinking(),
    )
    rerender(
      <ChatMessageView
        message={assistant([{ type: 'text', text: 'Hello' }])}
        live
        status={undefined}
      />,
    )
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull()
    // 流式中正文末尾有光标标记
    expect(container.querySelector('[data-chat-streaming]')).toBeTruthy()
  })

  it('自动重试期间显示重试中，旧推理不再显示', () => {
    const message = assistant([
      { type: 'reasoning', text: 'Discarded thought' },
      { type: 'data-retry', data: { n: 1 } },
    ])
    const { container } = render(<ChatMessageView message={message} live status={undefined} />)
    expect(container.textContent).toContain(m.chat_ui_status_retrying())
    expect(container.textContent).not.toContain('Discarded thought')
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull()
  })

  it('回复正文以 Markdown 渲染，原始 HTML 不产生元素', () => {
    const { container } = render(
      <ChatMessageView
        message={assistant([
          { type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>x()</script>' },
        ])}
        live={false}
        status={undefined}
      />,
    )
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })
})
