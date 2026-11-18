import { Button, cn, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem } from '@product-res/ui'
import { ChevronLeft, Ellipsis } from '@product-res/ui/icons'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { useAppShellBarAvailable } from '../app-shell/bar.tsx'
import { ChatComposer } from './chat-composer.tsx'
import { ChatSession, useChatSessionState } from './chat-session.ts'
import { ChatThread } from './chat-thread.tsx'
import type { StoredMessage } from './conversation.ts'
import { createConversation, setConversationArchived } from './conversations.functions.ts'
import type { MessageFeedbackValue } from './feedback.ts'
import type { PickerModel } from './model-picker.ts'

export interface ChatPageProps {
  readonly slug: string
  readonly conversation: { readonly id: string; readonly title: string }
  readonly storedMessages: readonly StoredMessage[]
  readonly models: readonly PickerModel[]
  readonly readOnly: boolean
  /** 对话无消息时显示的开场推荐问题 */
  readonly openingSuggestions?: readonly string[]
  /** 默认计费模型 key；不可用时回落到第一个模型 */
  readonly defaultModelKey?: string | null | undefined
  /** 当前用户对历史回复的评分 */
  readonly initialFeedback?: Readonly<Record<string, MessageFeedbackValue>>
}

/** 对话操作菜单：新对话、归档（归档后回到对话列表） */
function ConversationActions({ session }: { session: ChatSession }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const slug = session.slug
  async function create() {
    setError(null)
    const result = await createConversation({ data: { slug } })
    if (!result.ok) return setError(m.chat_ui_action_failed())
    await navigate({
      to: '/app/$slug/chat/$conversationId',
      params: { slug, conversationId: result.result.id },
    })
  }
  async function archive() {
    setError(null)
    const conversationId = session.conversationId
    if (!conversationId) return
    const result = await setConversationArchived({
      data: { slug, conversationId, archived: true },
    })
    if (!result.ok) return setError(m.chat_ui_action_failed())
    await navigate({ to: '/app/$slug/chat', params: { slug } })
  }
  return (
    <>
      {error ? (
        <span role="alert" className="text-caption text-destructive">
          {error}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              aria-label={m.chat_ui_actions()}
            >
              <Ellipsis aria-hidden />
            </Button>
          }
        />
        <DropdownContent align="end">
          <MenuItem
            index={0}
            label={m.chat_ui_new_chat()}
            disabled={session.readOnly}
            onSelect={() => void create()}
          />
          <MenuItem
            index={1}
            label={m.chat_ui_archive()}
            disabled={session.readOnly}
            onSelect={() => void archive()}
          />
        </DropdownContent>
      </DropdownMenu>
    </>
  )
}

/**
 * 对话页头部（设计稿 chat-components/Main.dc.html、Mobile.dc.html；版式取舍 2：标题留在对话区头部，不移到顶栏）：
 * 「全部对话」返回（窄屏只显示图标）、标题与对话操作。
 */
function ChatPageHeader({ session }: { session: ChatSession }) {
  const state = useChatSessionState(session)
  // 侧边栏布局：顶部条不显示标题（路由 staticData.shellTitle = false），对话标题是页面 h1；顶部布局的 h1 为空间名
  const Heading = useAppShellBarAvailable() ? 'h1' : 'h2'
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-2 border-b pb-2">
      <Link
        to="/app/$slug/chat"
        params={{ slug: session.slug }}
        aria-label={m.chat_ui_all_chats()}
        className="flex h-7 shrink-0 items-center gap-1 rounded-lg pr-2 pl-1 text-body text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--focus-ring) max-sm:size-9 max-sm:justify-center max-sm:p-0"
      >
        <ChevronLeft aria-hidden className="size-4" strokeWidth={1.5} />
        <span className="max-sm:hidden">{m.chat_ui_all_chats()}</span>
      </Link>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border max-sm:hidden" />
      <Heading
        className="ml-1 min-w-0 flex-1 truncate font-semibold text-subtitle"
        data-testid="conversation-title"
      >
        {state.title || m.chat_ui_untitled()}
      </Heading>
      <ConversationActions session={session} />
    </div>
  )
}

/**
 * 对话页（openspec add-ai-chat-components design D6，设计稿 chat-components/Main.dc.html、Mobile.dc.html）：
 * 720px 居中的消息列，输入区吸附在视口底部；消息与输入区分别由 ChatThread 与 ChatComposer 渲染，
 * 二者读同一个 ChatSession（`useChat` 经 `POST /api/ai/chat` 流式回复，停止经 `/api/ai/chat/:messageId/stop`）。
 * 嵌入其他页面的对话用 SubjectChat（同一组组件放进 EmbeddedChat 外壳）。
 */
export function ChatPage({
  slug,
  conversation,
  storedMessages,
  models,
  readOnly,
  openingSuggestions = [],
  defaultModelKey,
  initialFeedback = {},
}: ChatPageProps) {
  const [session] = useState(
    () =>
      new ChatSession({
        slug,
        conversationId: conversation.id,
        title: conversation.title,
        storedMessages,
        models,
        defaultModelKey,
        initialFeedback,
        readOnly,
      }),
  )
  // 路由数据重新加载时模型列表可能变化（权益或启用状态）
  useEffect(() => {
    session.setModels(models)
  }, [session, models])
  // 离开页面时停止本地读取
  useEffect(() => {
    session.attach()
    return () => session.dispose()
  }, [session])
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [jumpContainer, setJumpContainer] = useState<HTMLDivElement | null>(null)
  // 吸底输入区的底色与所在面板一致（侧边栏布局为 surface-2 面板，顶部布局为页面背景）
  const inShell = useAppShellBarAvailable()

  return (
    <div
      className="mx-auto flex min-h-chat-page w-full min-w-0 max-w-180 flex-col gap-5"
      data-chat-page=""
    >
      <ChatPageHeader session={session} />
      <ChatThread
        session={session}
        openingSuggestions={openingSuggestions}
        inputRef={inputRef}
        jumpContainer={jumpContainer}
        metaWithModel
        className="flex-1 pb-4"
      />
      <div
        className={cn(
          'sticky bottom-0 z-(--z-sticky) -mx-1 px-1 pt-2 pb-5',
          inShell ? 'bg-surface-2' : 'bg-background',
        )}
      >
        <div
          ref={setJumpContainer}
          className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3 *:pointer-events-auto"
        />
        <ChatComposer
          session={session}
          placeholder={m.chat_ui_placeholder()}
          inputRef={inputRef}
          disclaimer
          autoFocus
        />
      </div>
    </div>
  )
}
