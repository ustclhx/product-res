// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { fakeChatServer, startReply } from './chat-test-stream.ts'
import type { PickerModel } from './model-picker.ts'
import type { SubjectChatData } from './subject-chat.server.ts'

const state = vi.hoisted(() => ({
  text: {
    thinking: { default: 'off', userToggle: false },
    reasoning: { display: false },
    followUps: { enabled: false },
  },
}))

vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))
vi.mock('../analytics/track.ts', () => ({ trackEvent: vi.fn() }))
vi.mock('./conversations.functions.ts', () => ({
  renameConversation: vi.fn(),
  getChatMessage: vi.fn(async () => null),
}))
vi.mock('../marketing/pricing-snapshot.ts', () => ({ pricingSnapshot: { plans: [] } }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn(),
}))

const model: PickerModel = {
  id: 'm',
  key: 'general',
  pricing: { mode: 'per_call', credits: 2 },
  supportsThinking: false,
}

const data: SubjectChatData & { readOnly: boolean } = {
  subject: {
    type: 'report',
    label: 'Quarterly report',
    title: 'Ask about this report',
    suggestions: ['What changed?'],
    defaultModelKey: null,
  },
  conversation: { id: '01900000-0000-7000-8000-000000000001', title: 'Report chat' },
  conversations: [
    { id: '01900000-0000-7000-8000-000000000001', title: 'Report chat', updatedAt: new Date() },
  ],
  messages: [
    {
      id: 'u0',
      role: 'user',
      parts: [{ type: 'text', text: 'Earlier question' }],
      status: 'completed',
    },
  ],
  feedback: {},
  readOnly: false,
}

const api = vi.hoisted(() => ({
  getSubjectChat: vi.fn(),
  startSubjectConversation: vi.fn(),
}))

vi.mock('./subject-chat.functions.ts', () => ({
  getSubjectChat: api.getSubjectChat,
  startSubjectConversation: api.startSubjectConversation,
  startTemporarySubjectConversation: vi.fn(),
  getFollowUps: vi.fn(async () => ({ questions: [] })),
  setMessageFeedback: vi.fn(),
}))
vi.mock('./model-picker.functions.ts', () => ({ getPickerModels: vi.fn(async () => [model]) }))

import { SubjectChat } from './subject-chat.tsx'

// happy-dom 的 Web Animations 在取消时让 finished 拒绝（未处理）；去掉 animate，motion 改用脚本动画
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

/** 等对象对话数据加载完成（外壳随之从加载态换成对话视图） */
const loaded = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function desktop() {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

const otherId = '01900000-0000-7000-8000-000000000002'
const other: SubjectChatData & { readOnly: boolean } = {
  ...data,
  conversation: { id: otherId, title: 'Older chat' },
  messages: [
    {
      id: 'u9',
      role: 'user',
      parts: [{ type: 'text', text: 'Older question' }],
      status: 'completed',
    },
  ],
}
const blank: SubjectChatData & { readOnly: boolean } = {
  ...data,
  conversation: null,
  conversations: [],
  messages: [],
}

beforeEach(() => {
  api.getSubjectChat.mockReset()
  api.startSubjectConversation.mockReset()
  api.getSubjectChat.mockImplementation(
    async ({ data: input }: { data: { conversationId?: string } }) =>
      input.conversationId === otherId ? other : data,
  )
  overwriteGetLocale(() => baseLocale)
  desktop()
  window.scrollTo = vi.fn() as typeof window.scrollTo
  Element.prototype.scrollTo = vi.fn() as typeof Element.prototype.scrollTo
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SubjectChat 嵌入式外壳', () => {
  it('panel 关闭再打开后消息与草稿仍在；关闭期间流继续并完成，不停止', async () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    render(<SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog', { name: 'Ask about this report' })
    expect(panel.textContent).toContain('Quarterly report')
    expect(panel.textContent).toContain('Earlier question')

    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'Why did costs rise?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    expect(stream.body).toMatchObject({ conversationId: data.conversation?.id })
    act(() => {
      startReply(stream, 'r1', data.conversation?.id)
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: 'Long requests' })
    })
    await waitFor(() => expect(panel.textContent).toContain('Long requests'))
    // 生成中写下一条草稿，然后关闭面板
    fireEvent.change(input, { target: { value: 'Next question draft' } })
    fireEvent.click(within(panel).getByRole('button', { name: m.chat_ui_close() }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 关闭期间流继续并完成
    await act(async () => {
      stream.send({ type: 'text-delta', id: 't1', delta: ' matter more.' })
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(stream.aborted).toBe(false)
    expect(server.stops).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const reopened = await screen.findByRole('dialog', { name: 'Ask about this report' })
    await waitFor(() => expect(reopened.textContent).toContain('Long requests matter more.'))
    expect(reopened.textContent).toContain('Why did costs rise?')
    expect(
      (within(reopened).getByRole('textbox', { name: m.chat_ui_message() }) as HTMLTextAreaElement)
        .value,
    ).toBe('Next question draft')
    // 生成已结束：输入区为发送按钮
    expect(within(reopened).getByRole('button', { name: m.chat_ui_send() })).toBeTruthy()
  })

  it('卸载（离开页面）时停止本地读取', async () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    const { unmount } = render(
      <SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />,
    )
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog')
    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => startReply(stream, 'r1', data.conversation?.id))
    unmount()
    await waitFor(() => expect(stream.aborted).toBe(true))
  })

  it('第一次发送（推荐问题）新建对话后输入框保留焦点，状态区只播报一次「正在生成」', async () => {
    api.getSubjectChat.mockImplementation(async () => ({
      ...blank,
      conversations: [],
    }))
    api.startSubjectConversation.mockResolvedValue({
      ok: true,
      result: { id: data.conversation?.id },
    })
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    render(<SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog')
    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    const region = panel.querySelector('[data-chat-announcer]')
    if (!region) throw new Error('no status region')
    const writes: string[] = []
    const observer = new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (writes.at(-1) !== text) writes.push(text)
    })
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    fireEvent.click(within(panel).getByRole('button', { name: 'What changed?' }))
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => startReply(stream, 'r1', data.conversation?.id))
    await waitFor(() => expect(region.textContent).toBe(m.chat_ui_announce_generating()))
    // 线程与输入区没有重新挂载：同一个元素、焦点仍在
    expect(panel.querySelector('[data-chat-announcer]')).toBe(region)
    expect(within(panel).getByRole('textbox', { name: m.chat_ui_message() })).toBe(input)
    expect(document.activeElement).toBe(input)
    observer.disconnect()
    expect(writes).toEqual([m.chat_ui_announce_generating()])
  })

  it('新建对话失败时恢复草稿并提示', async () => {
    api.getSubjectChat.mockImplementation(async () => blank)
    api.startSubjectConversation.mockResolvedValue({ ok: false, error: 'FAILED' })
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    render(<SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog')
    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'My question' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(panel.textContent).toContain(m.subject_chat_start_failed()))
    expect((input as HTMLTextAreaElement).value).toBe('My question')
    expect(server.streams).toHaveLength(0)
  })

  it('生成中切换到历史对话，流继续；切回时回复已完成', async () => {
    api.getSubjectChat.mockImplementation(
      async ({ data: input }: { data: { conversationId?: string } }) =>
        input.conversationId === otherId
          ? {
              ...other,
              conversations: [
                ...data.conversations,
                { id: otherId, title: 'Older chat', updatedAt: new Date() },
              ],
            }
          : {
              ...data,
              conversations: [
                ...data.conversations,
                { id: otherId, title: 'Older chat', updatedAt: new Date() },
              ],
            },
    )
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    render(<SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog')
    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'Live question' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => {
      startReply(stream, 'r1', data.conversation?.id)
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: 'First half' })
    })
    await waitFor(() => expect(panel.textContent).toContain('First half'))

    // 用键盘在历史菜单中选中指定对话
    const choose = async (title: string) => {
      const trigger = within(panel).getByRole('button', { name: m.subject_chat_history() })
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'Enter' })
      await screen.findByRole('menu')
      for (let i = 0; i < 6 && !document.activeElement?.textContent?.includes(title); i++) {
        fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      }
      expect(document.activeElement?.textContent).toContain(title)
      fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })
    }
    await choose('Older chat')
    await waitFor(() => expect(api.getSubjectChat).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Older question'))
    expect(panel.textContent).not.toContain('First half')

    await act(async () => {
      stream.send({ type: 'text-delta', id: 't1', delta: ' and the rest.' })
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(stream.aborted).toBe(false)

    await choose('Report chat')
    await waitFor(() => expect(panel.textContent).toContain('First half and the rest.'))
  })
})
