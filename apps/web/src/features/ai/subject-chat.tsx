import {
  Button,
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
  EmbeddedChat,
  MenuItem,
} from '@product-res/ui'
import { History, SquarePen } from '@product-res/ui/icons'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { ChatComposer } from './chat-composer.tsx'
import { SuggestionChips } from './chat-extras.tsx'
import { ChatSession } from './chat-session.ts'
import { ChatThread } from './chat-thread.tsx'
import { getPickerModels } from './model-picker.functions.ts'
import type { PickerModel } from './model-picker.ts'
import {
  getSubjectChat,
  startSubjectConversation,
  startTemporarySubjectConversation,
} from './subject-chat.functions.ts'
import type { SubjectChatData } from './subject-chat.server.ts'

/**
 * 嵌入式对象对话（add-subject-chat tasks.md 6.1；外壳与组件见 openspec add-ai-chat-components design D7，
 * 设计稿 docs/design-system/prototypes/chat-components/Embedded.dc.html、EmbeddedMobile.dc.html）。
 *
 * `<SubjectChat slug subjectType subjectId />` 可放在任意 App 页面（如报告页底部）：渲染 `@product-res/ui` 的 EmbeddedChat
 * 外壳（对象标签为徽标，历史对话与新对话在头部），消息与输入区是对话页同一组 ChatThread / ChatComposer。
 * 默认进入最近一个对话；还没有对话时显示开场推荐问题与输入框，第一次发送时由服务端构建上下文并新建对话。
 * 发送复用 `POST /api/ai/chat` 的流协议、计费与模型选择。
 *
 * 对话状态（消息、生成中的回复、草稿）按会话保存在外壳之外：外壳关闭时卸载内容，再打开时都还在，
 * 关闭与切换对话都不停止生成；整个组件卸载（离开页面）时才停止。
 */

export interface SubjectChatProps {
  readonly slug: string
  readonly subjectType: string
  readonly subjectId: string
  /** inline（默认）：≥ 768px 为正文中的卡片；panel：悬浮按钮 + 右侧面板。< 768px 都是悬浮按钮 + 底部抽屉 */
  readonly variant?: EmbeddedChatVariant
  /** 受控打开面板 / 抽屉；不传时由外壳自己管理 */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  /** 页面自带入口时传 false 并受控打开 */
  readonly showTrigger?: boolean
  readonly className?: string | undefined
}

/** inline：≥ 768px 为正文中的卡片；panel：悬浮按钮 + 右侧面板（EmbeddedChat 的 variant） */
type EmbeddedChatVariant = 'inline' | 'panel'

type Loaded = SubjectChatData & { readOnly: boolean; models: readonly PickerModel[] }

interface ShellProps {
  readonly variant?: EmbeddedChatVariant | undefined
  readonly open?: boolean | undefined
  readonly defaultOpen?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly showTrigger?: boolean | undefined
  readonly className?: string | undefined
}

/** EmbeddedChat 的可选属性：只传调用方给出的值（exactOptionalPropertyTypes） */
function shellProps({
  variant = 'inline',
  open,
  defaultOpen,
  onOpenChange,
  showTrigger,
  className,
}: ShellProps) {
  return {
    variant,
    ...(open !== undefined ? { open } : {}),
    ...(defaultOpen !== undefined ? { defaultOpen } : {}),
    ...(onOpenChange ? { onOpenChange } : {}),
    ...(showTrigger !== undefined ? { showTrigger } : {}),
    ...(className ? { className } : {}),
  }
}

const shellLabels = (title: string) => ({
  trigger: m.chat_ui_subject_trigger(),
  title,
  close: m.chat_ui_close(),
})

export function SubjectChat({
  slug,
  subjectType,
  subjectId,
  variant,
  open,
  onOpenChange,
  showTrigger,
  className,
}: SubjectChatProps) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; notFound: boolean }
    | { status: 'ready'; data: Loaded }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    Promise.all([
      getSubjectChat({ data: { slug, subject: { type: subjectType, id: subjectId } } }),
      getPickerModels({ data: { slug, kind: 'text' } }),
    ])
      .then(([chat, models]) => {
        if (!cancelled) setState({ status: 'ready', data: { ...chat, models } })
      })
      .catch((error: unknown) => {
        // 越权、未注册与不存在的对象都以 404（router notFound）返回
        const notFound = typeof error === 'object' && error !== null && 'isNotFound' in error
        if (!cancelled) setState({ status: 'error', notFound })
      })
    return () => {
      cancelled = true
    }
  }, [slug, subjectType, subjectId])

  // 加载完成时外壳换成对话视图（重新挂载）：打开状态放在这里，加载中点开的面板不会随之关闭
  const [innerOpen, setInnerOpen] = useState(false)
  const shell = {
    variant,
    open: open ?? innerOpen,
    onOpenChange: (next: boolean) => {
      setInnerOpen(next)
      onOpenChange?.(next)
    },
    showTrigger,
    className,
  }
  if (state.status !== 'ready')
    return (
      <EmbeddedChat labels={shellLabels(m.chat_ui_subject_title())} {...shellProps(shell)}>
        {state.status === 'loading' ? (
          <p role="status" className="text-muted-foreground">
            {m.subject_chat_loading()}
          </p>
        ) : (
          <FormAlert
            message={state.notFound ? m.subject_chat_not_found() : m.subject_chat_load_failed()}
          />
        )}
      </EmbeddedChat>
    )
  return (
    <SubjectChatView
      {...shell}
      slug={slug}
      data={state.data}
      models={state.data.models}
      start={async () => {
        const result = await startSubjectConversation({
          data: { slug, subject: { type: subjectType, id: subjectId } },
        })
        if (!result.ok) throw new Error(result.error)
        return result.result.id
      }}
      loadConversation={async (conversationId) => {
        const chat = await getSubjectChat({
          data: { slug, subject: { type: subjectType, id: subjectId }, conversationId },
        })
        return chat
      }}
    />
  )
}

/** 还没有对话（或新对话）时会话缓存中的键 */
const NEW = 'new'

/**
 * 对象对话视图：EmbeddedChat 外壳 + 按对话缓存的 ChatSession。还没有对话时显示开场推荐与输入框，
 * 第一次发送前调用 `start` 新建对话。临时上下文页与 `SubjectChat` 共用。
 */
export function SubjectChatView({
  slug,
  data,
  models,
  start,
  loadConversation,
  ...shell
}: {
  slug: string
  data: SubjectChatData & { readOnly: boolean }
  models: readonly PickerModel[]
  /** 新建对话并返回其 ID；为 undefined 时不允许新建（如临时令牌已过期） */
  start: (() => Promise<string>) | undefined
  /** 读取历史对话的消息；不传时没有历史菜单 */
  loadConversation?: ((id: string) => Promise<SubjectChatData>) | undefined
} & ShellProps) {
  const subject = data.subject
  const sessions = useRef(new Map<string, ChatSession>())
  // 本视图内新建的对话立即出现在历史列表中，不必重新加载
  const [conversations, setConversations] = useState(data.conversations)
  const [activeKey, setActiveKey] = useState(data.conversation?.id ?? NEW)
  const [loading, setLoading] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  function create(key: string, stored?: SubjectChatData) {
    const conversation = stored?.conversation
    const session = new ChatSession({
      slug,
      conversationId: conversation?.id,
      title: subject.title ?? '',
      storedMessages: stored?.messages ?? [],
      models,
      defaultModelKey: subject.defaultModelKey,
      initialFeedback: stored?.feedback ?? {},
      readOnly: data.readOnly,
      start,
      onStarted: (id) => {
        // 新对话开始后以对话 ID 缓存，「新对话」再次从空白开始；用户在新建期间已切到别的对话时不切回来
        if (sessions.current.get(NEW) === session) sessions.current.delete(NEW)
        sessions.current.set(id, session)
        setActiveKey((current) => (current === NEW ? id : current))
        setConversations((old) => [
          { id, title: subject.title ?? '', updatedAt: new Date() },
          ...old.filter((item) => item.id !== id),
        ])
      },
    })
    sessions.current.set(key, session)
    return session
  }

  const cached = sessions.current.get(activeKey)
  const session =
    cached ??
    (activeKey === NEW
      ? create(NEW)
      : activeKey === data.conversation?.id
        ? create(activeKey, data)
        : undefined)

  // 离开页面时停止全部会话的本地读取；关闭外壳与切换对话不停止
  useEffect(() => {
    const all = sessions.current
    for (const item of all.values()) item.attach()
    return () => {
      for (const item of all.values()) item.dispose()
    }
  }, [])

  async function switchTo(id: string) {
    if (id === activeKey) return
    setLoadError(null)
    if (sessions.current.has(id) || !loadConversation) return setActiveKey(id)
    setLoading(id)
    try {
      const stored = await loadConversation(id)
      if (!sessions.current.has(id)) create(id, stored)
      setActiveKey(id)
    } catch {
      setLoadError(m.subject_chat_load_failed())
    } finally {
      setLoading(null)
    }
  }

  const blank = activeKey === NEW
  const canStartNew = start !== undefined && !data.readOnly && models.length > 0
  const history = loadConversation !== undefined && conversations.length > 0
  const newConversation = () => {
    setLoadError(null)
    setActiveKey(NEW)
    inputRef.current?.focus()
  }

  const headerAction = (
    <>
      {history ? (
        <DropdownMenu>
          <DropdownTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={m.subject_chat_history()}
              >
                <History aria-hidden />
              </Button>
            }
          />
          <DropdownContent
            align="end"
            checkedIndex={conversations.findIndex((item) => item.id === activeKey) + 1}
          >
            {/* 手机抽屉的头部没有「新对话」按钮，放在菜单第一项 */}
            <MenuItem
              index={0}
              label={m.subject_chat_new()}
              disabled={blank || !canStartNew}
              onSelect={newConversation}
            />
            <DropdownSeparator />
            {conversations.map((item, index) => (
              <MenuItem
                key={item.id}
                index={index + 1}
                label={item.title || m.subject_chat_untitled()}
                checked={item.id === activeKey}
                onSelect={() => void switchTo(item.id)}
              />
            ))}
          </DropdownContent>
        </DropdownMenu>
      ) : null}
      {!blank && start ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={
            history ? 'size-8 text-muted-foreground max-md:hidden' : 'size-8 text-muted-foreground'
          }
          aria-label={m.subject_chat_new()}
          disabled={!canStartNew}
          onClick={newConversation}
        >
          <SquarePen aria-hidden />
        </Button>
      ) : null}
    </>
  )

  const intro: ReactNode = (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        {subject.suggestions.length > 0 ? m.chat_ui_subject_intro() : m.subject_chat_empty()}
      </p>
      {session ? (
        <SuggestionChips
          suggestions={subject.suggestions}
          disabled={!session.canSend}
          onSelect={(text) => {
            void session.submit(text)
            inputRef.current?.focus()
          }}
        />
      ) : null}
    </div>
  )

  return (
    <EmbeddedChat
      labels={shellLabels(subject.title ?? subject.label)}
      badge={
        <span className="inline-flex h-5 shrink-0 items-center rounded-full px-2 font-medium text-caption inset-ring inset-ring-border">
          {subject.label}
        </span>
      }
      headerAction={headerAction}
      footer={
        session && !loading ? (
          <ChatComposer
            // 按会话本身作 key：第一次发送时键从「新对话」换成对话 ID，会话不变，输入框与状态区不重新挂载
            key={session.chat.id}
            session={session}
            placeholder={m.chat_ui_subject_placeholder({ subject: subject.label })}
            inputRef={inputRef}
            compact={shell.variant === 'panel'}
          />
        ) : undefined
      }
      {...shellProps(shell)}
    >
      <div data-subject-type={subject.type} className="flex min-w-0 flex-col gap-3.5">
        <FormAlert message={loadError} />
        {loading || !session ? (
          <p role="status" className="text-muted-foreground">
            {m.subject_chat_loading()}
          </p>
        ) : (
          // 消息列不超过 720px、居中（设计稿 Embedded.dc.html 的 inline 卡片）
          <ChatThread
            key={session.chat.id}
            session={session}
            empty={intro}
            inputRef={inputRef}
            embedded
            className="mx-auto w-full max-w-180"
          />
        )}
      </div>
    </EmbeddedChat>
  )
}

/** 临时上下文页（`/app/$slug/chat/context?token=`）：无效、过期引导与对话 */
export function TemporarySubjectChat({
  slug,
  token,
  page,
  models,
}: {
  slug: string
  token: string
  page:
    | { status: 'invalid'; readOnly: boolean }
    | ({ status: 'expired'; returnTo: string; readOnly: boolean } & Partial<SubjectChatData>)
    | ({ status: 'ok'; returnTo: string; readOnly: boolean } & SubjectChatData)
  models: readonly PickerModel[]
}) {
  if (page.status === 'invalid')
    return (
      <section className="grid gap-3">
        <FormAlert message={m.subject_chat_context_invalid()} />
        <Link to="/app/$slug/chat" params={{ slug }} className="underline">
          {m.subject_chat_context_back_app()}
        </Link>
      </section>
    )
  const back = (
    // returnTo 已在签发时校验为站内路径
    <a href={page.returnTo} className="underline">
      {m.subject_chat_context_back()}
    </a>
  )
  if (page.status === 'expired' && !page.subject)
    return (
      <section className="grid gap-3">
        <p role="status">{m.subject_chat_context_expired()}</p>
        {back}
      </section>
    )
  const data = page as SubjectChatData & { readOnly: boolean }
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-2xl">{m.subject_chat_context_title()}</h1>
        {back}
      </div>
      {page.status === 'expired' ? (
        <p role="status">{m.subject_chat_context_expired_existing()}</p>
      ) : null}
      {/* 专门的对话页：桌面为卡片，手机直接打开底部抽屉 */}
      <SubjectChatView
        slug={slug}
        data={data}
        models={models}
        defaultOpen
        start={
          page.status === 'ok'
            ? async () => {
                const result = await startTemporarySubjectConversation({ data: { slug, token } })
                if (!result.ok) throw new Error(result.error)
                if (result.result.status !== 'ok') throw new Error(result.result.status)
                return result.result.id
              }
            : undefined
        }
      />
    </section>
  )
}
