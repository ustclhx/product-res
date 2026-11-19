// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { fakeChatServer, startReply } from './chat-test-stream.ts'
import type { StoredMessage } from './conversation.ts'
import type { PickerModel } from './model-picker.ts'

const state = vi.hoisted(() => ({
  /** getChatMessage 依次返回的结果；为 Error 时抛出，用尽后返回 null */
  stored: [] as unknown[],
  storedCalls: [] as unknown[],
  text: {
    thinking: { default: 'off', userToggle: false },
    reasoning: { display: false },
    followUps: { enabled: false },
  },
}))

vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))
vi.mock('../analytics/track.ts', () => ({ trackEvent: vi.fn() }))
vi.mock('./conversations.functions.ts', () => ({
  getChatMessage: vi.fn(async (input: unknown) => {
    state.storedCalls.push(input)
    const next = state.stored.shift()
    if (next instanceof Error) throw next
    return next ?? null
  }),
  renameConversation: vi.fn(async () => ({ ok: true })),
  createConversation: vi.fn(),
  setConversationArchived: vi.fn(),
}))
vi.mock('./subject-chat.functions.ts', () => ({
  getFollowUps: vi.fn(async () => ({ questions: [] })),
  setMessageFeedback: vi.fn(),
}))
vi.mock('../marketing/pricing-snapshot.ts', () => ({ pricingSnapshot: { plans: [] } }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

import { ChatPage } from './chat-page.tsx'

const model: PickerModel = {
  id: 'm',
  key: 'deepseek',
  pricing: { mode: 'per_call', credits: 1 },
  supportsThinking: true,
}

function renderPage(
  options: {
    models?: readonly PickerModel[]
    stored?: readonly StoredMessage[]
    readOnly?: boolean
  } = {},
) {
  return render(
    <ChatPage
      slug="personal"
      conversation={{ id: 'c', title: 'Test' }}
      storedMessages={options.stored ?? []}
      models={options.models ?? [model]}
      readOnly={options.readOnly ?? false}
    />,
  )
}

const input = () => screen.getByRole('textbox', { name: m.chat_ui_message() })
const assistantItems = () =>
  within(screen.getByRole('list', { name: m.chat_ui_messages() })).getAllByRole('listitem', {
    name: m.chat_ui_assistant(),
  })

async function send(text: string) {
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.keyDown(input(), { key: 'Enter' })
}

const reply = (id: string, text: string, status: StoredMessage['status']): StoredMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  status,
})

// happy-dom 的 Web Animations 在取消时让 finished 拒绝（未处理）；去掉 animate，motion 改用脚本动画
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

beforeEach(() => {
  state.stored = []
  state.storedCalls = []
  overwriteGetLocale(() => baseLocale)
  state.text.thinking.userToggle = false
  state.text.thinking.default = 'off'
  state.text.reasoning.display = false
  window.scrollTo = vi.fn() as typeof window.scrollTo
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  overwriteGetLocale(() => baseLocale)
})

describe('Thinking 开关', () => {
  it('仅模板允许且模型支持时显示，初始值遵循模板默认', () => {
    renderPage()
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    state.text.thinking.userToggle = true
    state.text.thinking.default = 'on'
    renderPage()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    cleanup()
    renderPage({ models: [{ ...model, supportsThinking: false }] })
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it.each([true, false])('模型可控=%s 时请求体只携带允许的 thinking', async (supportsThinking) => {
    state.text.thinking.userToggle = true
    state.text.thinking.default = 'on'
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    renderPage({ models: [{ ...model, supportsThinking }] })
    await send('hi')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const body = server.streams[0]?.body
    expect(body).toMatchObject({ modelId: 'm', message: { parts: [{ type: 'text', text: 'hi' }] } })
    if (supportsThinking) expect(body).toHaveProperty('thinking', true)
    else expect(body).not.toHaveProperty('thinking')
  })
})

describe('消息状态', () => {
  it('停止后显示已停止且保留已生成的正文，输入区换回发送', async () => {
    const server = fakeChatServer({ stopStatus: 'aborted' })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Write a story')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => {
      startReply(stream, 'r1')
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: 'Partial answer' })
    })
    await waitFor(() => expect(assistantItems()[0]?.textContent).toContain('Partial answer'))
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_stop() }))
    await waitFor(() => expect(server.stops).toEqual(['/api/ai/chat/r1/stop']))
    await waitFor(() =>
      expect(assistantItems()[0]?.textContent).toContain(m.chat_ui_status_stopped()),
    )
    expect(assistantItems()[0]?.textContent).toContain('Partial answer')
    expect(screen.getByRole('button', { name: m.chat_ui_send() })).toBeTruthy()
    expect(stream.aborted).toBe(true)
  })

  it('收到 start 之前停止：按本轮请求 ID 通知服务端（issue #362）', async () => {
    const server = fakeChatServer({ stopStatus: 'aborted' })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Write a story')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    const requestId = stream.body.requestId
    expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_stop() }))
    await waitFor(() => expect(server.stops).toEqual(['/api/ai/chat/stop']))
    expect(server.stopBodies[0]).toEqual({ slug: 'personal', conversationId: 'c', requestId })
    await waitFor(() => expect(screen.getByRole('button', { name: m.chat_ui_send() })).toBeTruthy())
    expect(stream.aborted).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()

    // 下一轮使用新的请求 ID
    await send('Another one')
    await waitFor(() => expect(server.streams).toHaveLength(2))
    expect(server.streams[1]?.body.requestId).not.toBe(requestId)
  })

  it('停止接口失败时提示可能仍在后台生成', async () => {
    const server = fakeChatServer({ stopFails: true })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Write a story')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => {
      startReply(stream, 'r1')
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: 'Partial' })
    })
    await waitFor(() => expect(assistantItems()[0]?.textContent).toContain('Partial'))
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_stop() }))
    expect((await screen.findByRole('alert')).textContent).toContain(m.chat_ui_stop_failed())
    expect(stream.aborted).toBe(true)
  })

  it('失败与未完成的历史回复显示状态与说明，正文保留', () => {
    renderPage({
      stored: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Q1' }], status: 'completed' },
        reply('a1', 'Half of it', 'failed'),
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Q2' }], status: 'completed' },
        reply('a2', 'Cut off', 'streaming'),
      ],
    })
    const [failed, incomplete] = assistantItems()
    expect(failed?.textContent).toContain('Half of it')
    expect(failed?.textContent).toContain(m.chat_ui_status_failed())
    expect(failed?.textContent).toContain(m.chat_ui_status_failed_detail())
    expect(incomplete?.textContent).toContain('Cut off')
    expect(incomplete?.textContent).toContain(m.chat_ui_status_incomplete())
  })

  it('中文界面的状态文字为中文', () => {
    overwriteGetLocale(() => 'zh')
    renderPage({ stored: [reply('a1', '回答', 'failed'), reply('a2', '回答', 'aborted')] })
    const [failed, stopped] = assistantItems()
    expect(failed?.textContent).toContain('失败')
    expect(stopped?.textContent).toContain('已停止')
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
  })
})

describe('复制回复', () => {
  it('写入回复的 Markdown 原文并播报', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderPage({ stored: [reply('a1', '**Bold** and `code`', 'completed')] })
    const item = assistantItems()[0]
    if (!item) throw new Error('no reply')
    fireEvent.click(within(item).getByRole('button', { name: m.chat_ui_copy_reply() }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('**Bold** and `code`'))
    await waitFor(() => expect(item.textContent).toContain(m.chat_ui_copied()))
  })
})

describe('只读空间与错误', () => {
  it('只读空间不能发送', () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    renderPage({ readOnly: true })
    expect((input() as HTMLTextAreaElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: m.chat_ui_send() }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(server.streams).toHaveLength(0)
    expect(screen.getByText(m.chat_ui_read_only())).toBeTruthy()
  })

  it('余额不足：输入区上方显示原因与数值，弹出余额不足弹窗，可再次打开', async () => {
    const server = fakeChatServer({
      reject: {
        status: 402,
        json: {
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Insufficient credits',
            details: { estimatedCredits: 8, availableCredits: 2 },
          },
        },
      },
    })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Too expensive')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(m.chat_error_insufficient_credits())
    expect(alert.textContent).toContain(
      m.billing_credit_guide_amounts({ estimatedCredits: '8', availableCredits: '2' }),
    )
    expect(within(alert).queryByRole('link', { name: m.chat_ui_go_billing() })).toBeNull()
    await screen.findByRole('dialog')
    // 被拒的消息放回草稿（弹窗为模态，页面其余部分对读屏隐藏，直接取元素）
    expect(document.querySelector('textarea')?.value).toBe('Too expensive')
  })

  it('欠费保留账单入口，不显示余额数值', async () => {
    const server = fakeChatServer({
      reject: {
        status: 402,
        json: {
          error: { code: 'CREDIT_DEBT', details: { estimatedCredits: 8, availableCredits: 2 } },
        },
      },
    })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Hello')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('link', { name: m.chat_ui_go_billing() })).toBeTruthy()
    expect(alert.textContent).not.toContain(m.chat_ui_credits_reopen())
  })
})

describe('状态播报', () => {
  it('submitted → streaming（多次正文更新）→ ready 只写入两次：正在生成、已完成', async () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    const { container } = renderPage()
    const region = container.querySelector('[data-chat-announcer]')
    if (!region) throw new Error('no status region')
    expect(region.getAttribute('role')).toBe('status')
    // 消息列表本身不是实时区域
    const writes: string[] = []
    const observer = new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (writes.at(-1) !== text) writes.push(text)
    })
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    await send('Hi')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => {
      startReply(stream, 'r1')
      stream.send({ type: 'text-start', id: 't1' })
    })
    for (const delta of ['One', ' two', ' three'])
      await act(async () => {
        stream.send({ type: 'text-delta', id: 't1', delta })
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
    act(() => {
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
    })
    await waitFor(() => expect(region.textContent).toBe(m.chat_ui_announce_done()))
    observer.disconnect()
    expect(writes).toEqual([m.chat_ui_announce_generating(), m.chat_ui_announce_done()])
    expect(screen.getByRole('list', { name: m.chat_ui_messages() }).getAttribute('aria-live')).toBe(
      null,
    )
  })
})

describe('回复结束后与保存的消息对齐', () => {
  const saved = (
    id: string,
    text: string,
    status: StoredMessage['status'],
    credits: number | null = 3,
  ) => ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    status,
    credits,
    modelKey: 'deepseek',
  })

  async function streamReply(text: string) {
    const server = fakeChatServer({ stopStatus: 'aborted' })
    vi.stubGlobal('fetch', server.fetch)
    renderPage()
    await send('Question')
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => {
      startReply(stream, 'r1')
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: text })
    })
    await waitFor(() => expect(assistantItems()[0]?.textContent).toContain(text))
    return { server, stream }
  }

  const meta = (credits: number) =>
    m.chat_ui_reply_meta({ credits: String(credits), model: 'deepseek' })

  it('完成后不刷新即显示消耗积分与模型', async () => {
    state.stored = [saved('r1', 'Full answer', 'completed')]
    const { stream } = await streamReply('Full answer')
    expect(assistantItems()[0]?.textContent).not.toContain(meta(3))
    act(() => {
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
    })
    await waitFor(() => expect(assistantItems()[0]?.textContent).toContain(meta(3)))
    expect(state.storedCalls).toEqual([{ data: { slug: 'personal', messageId: 'r1' } }])
  })

  it('停止后正文换成服务端保存的版本，状态为已停止', async () => {
    state.stored = [saved('r1', 'Partial answer and the rest saved by the server', 'aborted', 2)]
    const { server, stream } = await streamReply('Partial answer')
    const markdown = assistantItems()[0]?.querySelector('[id]')
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_stop() }))
    await waitFor(() => expect(server.stops).toEqual(['/api/ai/chat/r1/stop']))
    await waitFor(() =>
      expect(assistantItems()[0]?.textContent).toContain('and the rest saved by the server'),
    )
    const item = assistantItems()[0]
    expect(item?.textContent).toContain(m.chat_ui_status_stopped())
    expect(item?.textContent).toContain(meta(2))
    expect(stream.aborted).toBe(true)
    // 正文块原地更新，不重新挂载
    if (markdown) expect(item?.contains(markdown)).toBe(true)
  })

  it('结算尚未完成时按退避重读，结束后显示', async () => {
    state.stored = [saved('r1', 'Answer', 'streaming', null), saved('r1', 'Answer', 'completed', 4)]
    const { stream } = await streamReply('Answer')
    act(() => {
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
    })
    await waitFor(() => expect(assistantItems()[0]?.textContent).toContain(meta(4)), {
      timeout: 2000,
    })
    expect(state.storedCalls).toHaveLength(2)
  })

  it('读取失败时保留本地正文，不报错', async () => {
    state.stored = [new Error('network'), new Error('network')]
    const { stream } = await streamReply('Local answer')
    act(() => {
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
    })
    await waitFor(() => expect(state.storedCalls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    })
    const item = assistantItems()[0]
    expect(item?.textContent).toContain('Local answer')
    expect(item?.textContent).not.toContain(m.chat_ui_status_failed())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
