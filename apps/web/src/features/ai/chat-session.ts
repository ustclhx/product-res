import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useSyncExternalStore } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { trackEvent } from '../analytics/track.ts'
import {
  type ChatMessageStatus,
  type ChatUIMessage,
  chatRequestBody,
  mergeStoredReply,
  messageText,
  requestStopResponseSchema,
  type StoredMessage,
  stopResponseSchema,
  streamingMessageId,
  titleFromText,
  toChatMessages,
} from './conversation.ts'
import { getChatMessage, renameConversation } from './conversations.functions.ts'
import type { MessageFeedbackValue } from './feedback.ts'
import type { PickerModel } from './model-picker.ts'
import { getFollowUps, setMessageFeedback } from './subject-chat.functions.ts'

/**
 * 一个对话的客户端状态（openspec add-ai-chat-components design D6、D7）：AI SDK 的 `Chat` 实例
 * （消息与正在进行的流）加上界面状态（草稿、模型、Thinking 开关、标题、停止结果、推荐追问、评分）。
 *
 * 状态放在组件树之外：嵌入式外壳（EmbeddedChat）关闭时卸载内容，再打开时消息、生成中的回复与草稿都还在；
 * 关闭期间流由 `Chat` 实例继续消费，不调用 stop。持有者（ChatPage、SubjectChat）卸载即离开页面时调用 `dispose()`。
 * `ChatThread` 与 `ChatComposer` 经 `useChat({ chat })` 与 `useChatSessionState` 读取同一个实例。
 */

export interface ChatSessionState {
  readonly draft: string
  readonly modelId: string | undefined
  readonly thinking: boolean
  readonly title: string
  /** 停止接口返回的消息状态，覆盖流中的状态显示 */
  readonly ended: Readonly<Record<string, ChatMessageStatus>>
  readonly stopError: string | null
  /** 最近一条回复的后续推荐问题；只在界面上显示，不进入历史 */
  readonly followUps: { readonly messageId: string; readonly questions: readonly string[] } | null
  readonly feedback: Readonly<Record<string, MessageFeedbackValue>>
  /** 正在新建对话（还没有对话时第一次发送） */
  readonly starting: boolean
  readonly startError: string | null
  /** 已点停止、停止接口还没有返回（状态播报直接报「已停止」） */
  readonly stopping: boolean
}

export interface ChatSessionOptions {
  readonly slug: string
  /** 已有对话的 ID；不传时第一次发送前调用 `start` 新建 */
  readonly conversationId?: string | undefined
  readonly title: string
  readonly storedMessages?: readonly StoredMessage[]
  readonly models: readonly PickerModel[]
  /** 默认计费模型 key（对象对话）；不可用时回落到第一个模型 */
  readonly defaultModelKey?: string | null | undefined
  readonly initialFeedback?: Readonly<Record<string, MessageFeedbackValue>>
  readonly readOnly: boolean
  /** 新建对话并返回 ID；还没有对话且为 undefined 时不能发送（如临时令牌已过期） */
  readonly start?: (() => Promise<string>) | undefined
  /** 新建对话成功（SubjectChat 据此更新历史列表与缓存） */
  readonly onStarted?: ((id: string) => void) | undefined
  /** 与已保存消息对齐的读取间隔，默认 `RECONCILE_DELAYS_MS`；测试可调 */
  readonly reconcileDelays?: readonly number[]
}

/**
 * 回复结束后读取已保存消息的间隔（毫秒），读到结束状态即停：正常完成与出错时服务端在关闭流之前已结算，
 * 停止时停止接口返回前已结算，第一次读取通常就够；断开或本地结算失败时消息仍为 streaming，
 * 按退避再读几次（最长约 7.5 秒），仍未结束则保留本地内容。
 */
export const RECONCILE_DELAYS_MS: readonly number[] = [0, 500, 1000, 2000, 4000]

let sequence = 0

export class ChatSession {
  readonly chat: Chat<ChatUIMessage>
  readonly slug: string
  readonly readOnly: boolean
  conversationId: string | undefined
  #models: readonly PickerModel[]
  #disposed = false
  #state: ChatSessionState
  readonly #listeners = new Set<() => void>()
  readonly #start: (() => Promise<string>) | undefined
  readonly #onStarted: ((id: string) => void) | undefined
  readonly #reconcileDelays: readonly number[]
  /** 本轮发送的请求 ID：收到 start 事件（回复 ID）之前点停止时据此通知服务端 */
  #requestId: string | undefined

  constructor(options: ChatSessionOptions) {
    this.slug = options.slug
    this.#reconcileDelays = options.reconcileDelays ?? RECONCILE_DELAYS_MS
    this.readOnly = options.readOnly
    this.conversationId = options.conversationId
    this.#models = options.models
    this.#start = options.start
    this.#onStarted = options.onStarted
    const model =
      options.models.find((item) => item.key === options.defaultModelKey) ?? options.models[0]
    this.#state = {
      draft: '',
      modelId: model?.id,
      thinking: templateConfig.ai.text.thinking.default === 'on',
      title: options.title,
      ended: {},
      stopError: null,
      followUps: null,
      feedback: options.initialFeedback ?? {},
      starting: false,
      startError: null,
      stopping: false,
    }
    const transport = new DefaultChatTransport<ChatUIMessage>({
      api: '/api/ai/chat',
      // 发送时读取当前的模型与 Thinking 开关
      prepareSendMessagesRequest: ({ messages }) => ({
        body: chatRequestBody({
          slug: this.slug,
          modelId: this.#state.modelId ?? '',
          conversationId: this.conversationId ?? '',
          messages,
          ...(this.canToggleThinking ? { thinking: this.#state.thinking } : {}),
          ...(this.#requestId ? { requestId: this.#requestId } : {}),
        }),
      }),
    })
    sequence += 1
    this.chat = new Chat<ChatUIMessage>({
      id: options.conversationId ?? `new-chat-${sequence}`,
      messages: toChatMessages(options.storedMessages ?? []),
      transport,
      onFinish: ({ messages, isError, isAbort }) => this.#finished(messages, isError, isAbort),
    })
  }

  get state(): ChatSessionState {
    return this.#state
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  readonly getState = () => this.#state

  set(next: Partial<ChatSessionState>) {
    this.#state = { ...this.#state, ...next }
    for (const listener of this.#listeners) listener()
  }

  get models(): readonly PickerModel[] {
    return this.#models
  }

  /** 路由数据重新加载后的模型列表；通知订阅者重新渲染（模型选择、预计消耗、能否发送） */
  setModels(models: readonly PickerModel[]) {
    if (models === this.#models) return
    this.#models = models
    this.set({})
  }

  get model(): PickerModel | undefined {
    return this.#models.find((item) => item.id === this.#state.modelId)
  }

  get canToggleThinking(): boolean {
    return Boolean(templateConfig.ai.text.thinking.userToggle && this.model?.supportsThinking)
  }

  get busy(): boolean {
    return this.chat.status === 'submitted' || this.chat.status === 'streaming'
  }

  /** 还没有对话且不能新建（临时令牌已过期）时不能发送 */
  get canSend(): boolean {
    return (
      !this.readOnly && Boolean(this.model) && (this.conversationId !== undefined || !!this.#start)
    )
  }

  /** 发送草稿或给定的文字（推荐问题）；还没有对话时先新建 */
  async submit(value?: string): Promise<void> {
    const fromDraft = value === undefined
    const text = (value ?? this.#state.draft).trim()
    if (!text || !this.canSend || this.busy || this.#state.starting) return
    this.chat.clearError()
    this.set({
      stopError: null,
      followUps: null,
      startError: null,
      ...(fromDraft ? { draft: '' } : {}),
    })
    if (this.conversationId === undefined) {
      this.set({ starting: true })
      try {
        const id = await (this.#start as () => Promise<string>)()
        // 新建期间持有者已卸载（离开页面）：不再发送
        if (this.#disposed) return
        this.conversationId = id
        this.#onStarted?.(id)
      } catch {
        this.set({
          startError: m.subject_chat_start_failed(),
          ...(fromDraft && !this.#state.draft ? { draft: text } : {}),
        })
        return
      } finally {
        this.set({ starting: false })
      }
    }
    if (this.#disposed) return
    trackEvent('generate_start')
    this.#requestId = crypto.randomUUID()
    void this.chat.sendMessage({ text })
  }

  /**
   * 先通知服务端停止上游生成，再中断本地读取（服务端在客户端断开后仍会继续读完模型流）。
   * 已收到 start 事件时按回复 ID 停止；之前（submitted 且还没有回复 ID）按本轮请求 ID 停止，
   * 否则只中断本地读取，服务端会生成并结算完整回复（issue #362）。
   */
  async stop(): Promise<void> {
    const messageId = streamingMessageId(this.chat.messages, this.chat.status)
    const requestId = !messageId && this.busy ? this.#requestId : undefined
    const conversationId = this.conversationId
    this.set({ stopError: null, stopping: true })
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const request = messageId
      ? post(`/api/ai/chat/${messageId}/stop`, { slug: this.slug })
      : requestId && conversationId
        ? post('/api/ai/chat/stop', { slug: this.slug, conversationId, requestId })
        : undefined
    await this.chat.stop()
    if (!request) {
      this.set({ stopping: false })
      return
    }
    let stoppedId = messageId
    try {
      const response = await request
      const json: unknown = await response.json()
      const parsed = stopResponseSchema.safeParse(json)
      if (!response.ok || !parsed.success) throw new Error('stop failed')
      if (!messageId) {
        // 按请求 ID 停止时回复 ID 来自响应；为 null 表示回复没有入库，没有可对齐的消息
        const byRequest = requestStopResponseSchema.safeParse(json)
        if (!byRequest.success) throw new Error('stop failed')
        stoppedId = byRequest.data.messageId ?? undefined
      }
      this.set({
        stopping: false,
        ...(stoppedId ? { ended: { ...this.#state.ended, [stoppedId]: parsed.data.status } } : {}),
      })
    } catch {
      this.set({ stopping: false, stopError: m.chat_ui_stop_failed() })
    }
    // 服务端从客户端停止到真正中止之间可能多生成一段并计费：换成已保存的正文与积分
    if (stoppedId) void this.reconcile(stoppedId)
  }

  /**
   * 回复结束后把本地消息换成已保存的版本（正文、状态、结算积分与模型），界面与保存、计费的内容一致。
   * 消息仍为 streaming 时按 `reconcileDelays` 重读；读取失败或始终未结束时保留本地内容。
   */
  async reconcile(messageId: string): Promise<void> {
    for (const delay of this.#reconcileDelays) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (this.#disposed) return
      let row: Awaited<ReturnType<typeof getChatMessage>>
      try {
        row = await getChatMessage({ data: { slug: this.slug, messageId } })
      } catch {
        continue
      }
      if (this.#disposed || !row) return
      if (row.status === 'streaming') continue
      const index = this.chat.messages.findIndex(
        (message) => message.id === messageId || message.metadata?.messageId === messageId,
      )
      const local = this.chat.messages[index]
      if (!local) return
      const merged = mergeStoredReply(local, row as StoredMessage)
      this.chat.messages = this.chat.messages.map((message, i) => (i === index ? merged : message))
      // 停止接口返回的状态覆盖消息状态；以保存的状态为准
      if (this.#state.ended[messageId])
        this.set({ ended: { ...this.#state.ended, [messageId]: row.status } })
      return
    }
  }

  async saveFeedback(messageId: string, next: MessageFeedbackValue | null): Promise<void> {
    const result = await setMessageFeedback({
      data: {
        slug: this.slug,
        messageId,
        rating: next?.rating ?? null,
        ...(next?.comment ? { comment: next.comment } : {}),
        ...(next?.reason ? { reason: next.reason } : {}),
        ...(next?.shareConversation ? { shareConversation: true } : {}),
      },
    })
    if (!result.ok) throw new Error(result.error)
    const { [messageId]: _, ...rest } = this.#state.feedback
    this.set({ feedback: result.result ? { ...rest, [messageId]: result.result } : rest })
  }

  /** 持有者挂载（含 StrictMode 的重新挂载）时调用，撤销之前的 dispose */
  attach(): void {
    this.#disposed = false
  }

  /** 离开页面：停止本地读取（与 useChat 卸载时的行为一致），之后不再发送 */
  dispose(): void {
    this.#disposed = true
    void this.chat.stop()
  }

  #finished(messages: ChatUIMessage[], isError: boolean, isAbort: boolean) {
    if (!isAbort) trackEvent(isError ? 'generate_fail' : 'generate_success')
    const last = messages.at(-1)
    // 请求被拒（余额不足、限流等）时把这条消息放回草稿，用户处理后可直接再次发送
    if (isError && last?.role === 'user' && !this.#state.draft)
      this.set({ draft: messageText(last) })
    const replyId = last?.metadata?.messageId
    // 结束（完成、出错、断开）后与已保存的消息对齐；停止由 stop() 在停止接口返回后对齐
    if (!isAbort && last?.role === 'assistant' && replyId) void this.reconcile(replyId)
    if (!isError && !isAbort && replyId && templateConfig.ai.text.followUps.enabled)
      void getFollowUps({ data: { slug: this.slug, messageId: replyId } })
        .then((result) => {
          if (result.questions.length)
            this.set({ followUps: { messageId: replyId, questions: result.questions } })
        })
        .catch(() => {})
    // 新建的对话标题为空：首轮回复完成后取首条消息作为标题
    if (isError || isAbort || this.#state.title || !this.conversationId) return
    const first = messages.find((message) => message.role === 'user')
    const title = first ? titleFromText(messageText(first)) : ''
    if (!title) return
    this.set({ title })
    void renameConversation({
      data: { slug: this.slug, conversationId: this.conversationId, title },
    })
  }
}

/** 订阅会话的界面状态 */
export function useChatSessionState(session: ChatSession): ChatSessionState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}
