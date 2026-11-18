import { useChat } from '@ai-sdk/react'
import { Button, cn } from '@product-res/ui'
import { ArrowDown, Check, Copy, Sparkle } from '@product-res/ui/icons'
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { m } from '../../paraglide/messages.js'
import { formatNumber, MessageFeedback, SuggestionChips } from './chat-extras.tsx'
import type { ChatSession } from './chat-session.ts'
import { useChatSessionState } from './chat-session.ts'
import {
  type ChatMessageStatus,
  type ChatUIMessage,
  messageRetrying,
  messageText,
} from './conversation.ts'
import { ChatMessageView } from './message-parts.tsx'

/** 流式更新的节流间隔（design D4）：降低长回复的重渲染频率 */
export const CHAT_THROTTLE_MS = 50
/** 距离底部小于该值视为「在底部」，新内容到达时跟随滚动 */
const FOLLOW_THRESHOLD_PX = 96

export interface ChatThreadProps {
  readonly session: ChatSession
  /** 对话还没有消息时的推荐问题 */
  readonly openingSuggestions?: readonly string[]
  /** 没有消息时显示的内容；不传时为对话页的空态 */
  readonly empty?: ReactNode
  /** 推荐问题发送后把焦点交给输入框（按钮随即不可用，焦点不会落到页面开头） */
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>
  /** 「回到最新」按钮的位置（对话页放在吸底的输入区上方）；不传时在消息列底部吸附 */
  readonly jumpContainer?: HTMLElement | null
  /** 嵌入式外壳中：只滚动外壳自己的消息区，永远不滚动宿主页面 */
  readonly embedded?: boolean
  /** 回复的消耗说明是否带模型名（对话页；嵌入式只显示积分） */
  readonly metaWithModel?: boolean
  readonly className?: string
}

/** 回复状态播报的阶段：只在阶段变化时写入状态区（design D6），不逐字朗读正文 */
type Phase = 'generating' | 'retrying' | 'done' | 'stopped' | 'failed'

const PHASE_TEXT: Record<Phase, () => string> = {
  generating: () => m.chat_ui_announce_generating(),
  retrying: () => m.chat_ui_announce_retrying(),
  done: () => m.chat_ui_announce_done(),
  stopped: () => m.chat_ui_announce_stopped(),
  failed: () => m.chat_ui_announce_failed(),
}

export function replyPhase(input: {
  busy: boolean
  retrying: boolean
  error: boolean
  /** 用户点了停止、停止接口还没有返回 */
  stopping: boolean
  ended: ChatMessageStatus | undefined
  previous: Phase | null
}): Phase | null {
  if (input.busy) return input.retrying ? 'retrying' : 'generating'
  // 只有生成过才播报结束；首屏的历史消息不播报
  if (input.previous === null) return null
  if (input.error || input.ended === 'failed') return 'failed'
  if (input.stopping || input.ended === 'aborted') return 'stopped'
  if (input.previous === 'generating' || input.previous === 'retrying') return 'done'
  return input.previous
}

/** 最近的纵向滚动容器；页面本身滚动时为 null（窗口） */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return null
}

function distanceToBottom(scroller: HTMLElement | null) {
  if (scroller) return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  const root = document.scrollingElement ?? document.documentElement
  return root.scrollHeight - window.scrollY - window.innerHeight
}

function scrollToBottom(scroller: HTMLElement | null, smooth = false) {
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto'
  if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior })
  else
    window.scrollTo({
      top: (document.scrollingElement ?? document.documentElement).scrollHeight,
      behavior,
    })
}

/** 「复制回复」：复制回复的 Markdown 原文，成功或失败短暂显示并向读屏播报 */
export function CopyReplyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 1500)
  }
  const feedback =
    state === 'copied' ? m.chat_ui_copied() : state === 'failed' ? m.chat_ui_copy_failed() : ''
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground"
        aria-label={m.chat_ui_copy_reply()}
        data-copy-reply=""
        onClick={() => void copy()}
      >
        {state === 'copied' ? (
          <Check aria-hidden className="size-3.5" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-3.5" strokeWidth={1.5} />
        )}
      </Button>
      {/* 可见反馈与读屏播报共用一个礼貌级实时区域（不用 role="status"：评分组件在同一行另有状态区） */}
      <span
        aria-live="polite"
        data-copy-feedback=""
        className={cn(
          'text-caption',
          state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          !feedback && 'sr-only',
        )}
      >
        {feedback}
      </span>
    </>
  )
}

/** 历史回复的消耗说明：结算积分（与模型）；流式回复刷新后才有 */
function replyMeta(message: ChatUIMessage, withModel: boolean): string | undefined {
  const credits = message.metadata?.credits
  if (credits === undefined) return undefined
  const model = message.metadata?.modelKey
  return withModel && model
    ? m.chat_ui_reply_meta({ credits: formatNumber(credits), model })
    : m.chat_ui_reply_credits({ credits: formatNumber(credits) })
}

/** 对话页没有消息时的空态（设计稿 Main.dc.html 的 empty） */
export function ChatEmptyState({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 pt-16 text-center md:pt-30">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <Sparkle className="size-4.5" strokeWidth={2} />
      </span>
      <h2 className="mt-1.5 font-semibold text-title">{m.chat_ui_empty_title()}</h2>
      <p className="max-w-104 text-muted-foreground">{m.chat_ui_empty_description()}</p>
      {children}
    </div>
  )
}

/**
 * 消息列表（design D6）：消息、推荐问题与状态播报。与 ChatComposer 读同一个会话，
 * 对话页与嵌入式外壳（SubjectChat）共用。用户位于底部附近时新内容到达才跟随滚动；
 * 生成中上翻阅读时显示「回到最新」。
 */
export function ChatThread({
  session,
  openingSuggestions = [],
  empty,
  inputRef,
  jumpContainer,
  metaWithModel = false,
  embedded = false,
  className,
}: ChatThreadProps) {
  const { messages, status, error } = useChat<ChatUIMessage>({
    chat: session.chat,
    experimental_throttle: CHAT_THROTTLE_MS,
  })
  const state = useChatSessionState(session)
  const busy = status === 'submitted' || status === 'streaming'
  const model = session.model
  const last = messages.at(-1)
  const canSend = session.canSend && !state.starting

  // 首屏已有的消息不播放入场动效
  const initialIds = useRef<Set<string> | null>(null)
  if (initialIds.current === null)
    initialIds.current = new Set(session.chat.messages.map((message) => message.id))

  // 状态播报：阶段变化时才写入
  const [phase, setPhase] = useState<Phase | null>(null)
  const retrying = busy && last?.role === 'assistant' && messageRetrying(last)
  const lastId = last?.metadata?.messageId
  const next = replyPhase({
    busy,
    retrying,
    error: Boolean(error),
    stopping: state.stopping,
    ended: lastId ? state.ended[lastId] : undefined,
    previous: phase,
  })
  if (next !== phase) setPhase(next)

  // 跟随滚动。滚动容器在第一次需要时解析（布局副作用早于普通副作用执行）；嵌入式线程找不到容器时不滚动窗口，
  // 否则宿主页面会被拉到底部
  const listRef = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLElement | null | undefined>(undefined)
  const following = useRef(true)
  const [away, setAway] = useState(false)
  const resolveScroller = () => {
    if (scroller.current === undefined) scroller.current = scrollParent(listRef.current)
    return scroller.current
  }
  const scrollLatest = (smooth = false) => {
    const target = resolveScroller()
    if (!target && embedded) return
    scrollToBottom(target, smooth)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换会话时重新订阅；解析函数读 ref
  useEffect(() => {
    const element = resolveScroller()
    if (!element && embedded) return
    const target: HTMLElement | Window = element ?? window
    const onScroll = () => {
      const near = distanceToBottom(element) <= FOLLOW_THRESHOLD_PX
      following.current = near
      setAway(!near)
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [session, embedded])
  const lastUserId = messages.findLast((message) => message.role === 'user')?.id
  const previousUserId = useRef(lastUserId)
  const followUpsShown = Boolean(state.followUps)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息、追问变化时跟随；滚动函数读 ref
  useLayoutEffect(() => {
    // 打开对话时停在最新消息；自己刚发送的消息总是滚到可见；其余新内容只在用户位于底部附近时跟随
    const sent = lastUserId !== previousUserId.current
    previousUserId.current = lastUserId
    if (sent) following.current = true
    if (following.current && (messages.length || followUpsShown)) scrollLatest()
  }, [messages, lastUserId, followUpsShown])

  const jump = away && busy && (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      leadingIcon={ArrowDown}
      data-chat-jump=""
      className="rounded-full shadow-surface-5"
      onClick={() => {
        following.current = true
        setAway(false)
        scrollLatest(true)
      }}
    >
      {m.chat_ui_jump_latest()}
    </Button>
  )

  function sendSuggestion(text: string) {
    void session.submit(text)
    inputRef?.current?.focus()
  }

  const followUps =
    !busy && state.followUps && state.followUps.messageId === lastId ? state.followUps : null

  return (
    <div ref={listRef} className={cn('@container flex min-w-0 flex-col gap-5', className)}>
      {messages.length > 0 ? (
        <ol aria-label={m.chat_ui_messages()} className="flex min-w-0 flex-col gap-5">
          {messages.map((message) => {
            const live = busy && message === last && message.role === 'assistant'
            const messageStatus =
              (message.metadata?.messageId && state.ended[message.metadata.messageId]) ||
              message.metadata?.status
            const messageId = message.metadata?.messageId
            const done = message.role === 'assistant' && messageId && !live
            return (
              <li
                key={message.id}
                data-role={message.role}
                aria-label={message.role === 'user' ? m.chat_ui_you() : m.chat_ui_assistant()}
                className="flex min-w-0 flex-col"
              >
                <ChatMessageView
                  message={message}
                  live={live}
                  status={messageStatus}
                  entrance={!initialIds.current?.has(message.id)}
                  actions={
                    done && messageStatus !== 'streaming' ? (
                      // MessageFeedback 自带与正文对齐的左外边距，抵消消息操作区的同一偏移
                      <div className="ml-1.5 min-w-0">
                        <MessageFeedback
                          messageId={messageId}
                          value={state.feedback[messageId] ?? null}
                          disabled={session.readOnly}
                          onChange={(value) => session.saveFeedback(messageId, value)}
                          actions={
                            messageText(message) ? (
                              <CopyReplyButton text={messageText(message)} />
                            ) : undefined
                          }
                          meta={replyMeta(message, metaWithModel)}
                        />
                      </div>
                    ) : undefined
                  }
                />
              </li>
            )
          })}
        </ol>
      ) : (
        (empty ?? (
          <ChatEmptyState>
            <SuggestionChips
              suggestions={openingSuggestions}
              disabled={busy || !canSend || !model}
              onSelect={sendSuggestion}
              className="mt-2.5 justify-center"
            />
          </ChatEmptyState>
        ))
      )}
      {followUps ? (
        <SuggestionChips
          label={m.subject_chat_follow_ups()}
          showLabel
          suggestions={followUps.questions}
          disabled={!canSend || !model}
          onSelect={sendSuggestion}
          className="@chat-message:pl-10"
        />
      ) : null}
      <span role="status" className="sr-only" data-chat-announcer="">
        {phase ? PHASE_TEXT[phase]() : ''}
      </span>
      {jump ? (
        jumpContainer ? (
          createPortal(jump, jumpContainer)
        ) : (
          <div className="pointer-events-none sticky bottom-3 flex justify-center *:pointer-events-auto">
            {jump}
          </div>
        )
      ) : null}
    </div>
  )
}
