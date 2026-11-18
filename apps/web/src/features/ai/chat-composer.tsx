import { useChat } from '@ai-sdk/react'
import { estimateInputTokens } from '@product-res/ai/client'
import { type InsufficientCreditsDetails, parseInsufficientCredits } from '@product-res/shared'
import { Button, cn, Switch } from '@product-res/ui'
import { InputMessage } from '@product-res/ui/chat'
import { CircleAlert } from '@product-res/ui/icons'
import { Link, useNavigate } from '@tanstack/react-router'
import { type RefObject, useEffect, useId, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { trackEvent } from '../analytics/track.ts'
import { pricingSnapshot } from '../marketing/pricing-snapshot.ts'
import { ProjectComposerEstimate } from './chat-composer.project.tsx'
import { CreditsDialog, formatNumber } from './chat-extras.tsx'
import { type ChatSession, useChatSessionState } from './chat-session.ts'
import { CHAT_THROTTLE_MS } from './chat-thread.tsx'
import { type ChatUIMessage, chatErrorCode, chatErrorMessage, messageText } from './conversation.ts'
import { CreditEstimateText, ModelPicker } from './model-picker.tsx'

const BILLING_CODES = new Set(['INSUFFICIENT_CREDITS', 'CREDIT_DEBT', 'UPGRADE_REQUIRED'])
// 构建时的公开套餐里明确没有订阅时，余额不足弹窗不显示「订阅」；快照为空（构建时数据库不可达）时保留
const offersSubscriptions =
  pricingSnapshot.plans.length === 0 ||
  pricingSnapshot.plans.some((plan) => plan.type === 'subscription')

// 每个错误对象只自动打开一次余额不足弹窗、只记一次 paywall_view：嵌入式外壳关闭再打开时组件重新挂载，不重复
const handledErrors = new WeakSet<Error>()

export interface ChatComposerProps {
  readonly session: ChatSession
  readonly placeholder: string
  /** 输入框元素（推荐问题与弹窗关闭后把焦点交回这里） */
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>
  /** 嵌入式侧面板与底部抽屉：紧凑内边距（设计稿 Embedded 的 10px / 12px） */
  readonly compact?: boolean
  /** 对话还没有消息时，水合后把焦点放到输入框（对话页空态） */
  readonly autoFocus?: boolean
  /** 输入区下方的「回答由 AI 生成」说明（对话页） */
  readonly disclaimer?: boolean
  readonly className?: string
}

/** 错误提示（设计稿 Main.dc.html 的 error）：标题为错误原因，余额不足时附数值与补充积分入口 */
function ChatErrorAlert({
  session,
  error,
  inputRef,
}: {
  session: ChatSession
  error: Error
  inputRef: RefObject<HTMLTextAreaElement | null> | undefined
}) {
  const code = chatErrorCode(error)
  const insufficient = parseInsufficientCredits(error)
  const [dialogOpen, setDialogOpen] = useState(false)
  useEffect(() => {
    if (handledErrors.has(error)) return
    handledErrors.add(error)
    if (code && BILLING_CODES.has(code)) trackEvent('paywall_view')
    // 积分不足（带预计消耗与余额）时弹出余额不足弹窗；关闭后可经提示中的按钮再次打开
    if (insufficient) setDialogOpen(true)
  }, [error, code, insufficient])
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 text-destructive" strokeWidth={1.5} />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="font-medium text-destructive">{chatErrorMessage(code)}</span>
        {insufficient ? <CreditAmounts details={insufficient} /> : null}
      </div>
      {insufficient ? (
        <>
          <Button
            type="button"
            size="sm"
            className="ml-7 sm:ml-0"
            onClick={() => setDialogOpen(true)}
          >
            {m.chat_ui_credits_reopen()}
          </Button>
          <CreditsGuideDialog
            slug={session.slug}
            details={insufficient}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            inputRef={inputRef}
          />
        </>
      ) : code && BILLING_CODES.has(code) ? (
        <Button size="sm" className="ml-7 sm:ml-0" asChild>
          <Link to="/app/$slug/billing" params={{ slug: session.slug }}>
            {m.chat_ui_go_billing()}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

function CreditAmounts({ details }: { details: InsufficientCreditsDetails }) {
  return (
    <span className="text-muted-foreground">
      {m.billing_credit_guide_amounts({
        estimatedCredits: formatNumber(details.estimatedCredits),
        availableCredits: formatNumber(details.availableCredits),
      })}
    </span>
  )
}

/** 余额不足弹窗（add-ui-design-system 8.6）：购买积分包与订阅两个入口 */
function CreditsGuideDialog({
  slug,
  details,
  open,
  onOpenChange,
  inputRef,
}: {
  slug: string
  details: InsufficientCreditsDetails
  open: boolean
  onOpenChange(open: boolean): void
  inputRef: RefObject<HTMLTextAreaElement | null> | undefined
}) {
  const navigate = useNavigate()
  const goTo = (hash: 'credit-packs' | 'subscriptions') => {
    onOpenChange(false)
    void navigate({ to: '/app/$slug/billing', params: { slug }, hash })
  }
  return (
    <CreditsDialog
      open={open}
      onOpenChange={onOpenChange}
      estimatedCredits={details.estimatedCredits}
      availableCredits={details.availableCredits}
      onBuyPacks={() => goTo('credit-packs')}
      onSubscribe={offersSubscriptions ? () => goTo('subscriptions') : undefined}
      fallbackFocus={() => inputRef?.current ?? null}
    />
  )
}

/**
 * 输入区（design D6）：InputMessage + 模型选择、Thinking 开关（左下）与预计消耗（右下），
 * 上方为错误与只读提示。与 ChatThread 读同一个会话；草稿保存在会话中，嵌入式外壳关闭再打开仍在。
 */
export function ChatComposer({
  session,
  placeholder,
  inputRef,
  compact = false,
  disclaimer = false,
  autoFocus = false,
  className,
}: ChatComposerProps) {
  const { messages, status, error } = useChat<ChatUIMessage>({
    chat: session.chat,
    experimental_throttle: CHAT_THROTTLE_MS,
  })
  const state = useChatSessionState(session)
  const busy = status === 'submitted' || status === 'streaming'
  const model = session.model
  // 水合前输入区不可用：受控输入在水合前的键入会丢失
  const inputId = useId()
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在水合完成时判断一次
  useEffect(() => {
    if (hydrated && autoFocus && session.chat.messages.length === 0) inputRef?.current?.focus()
  }, [hydrated])
  const inputTokens = estimateInputTokens([
    ...messages.map((message) => ({ text: messageText(message) })),
    { text: state.draft },
  ])
  const notices = [state.stopError, state.startError].filter(Boolean) as string[]

  return (
    <div className={cn('flex min-w-0 flex-col gap-2.5', className)}>
      {error ? <ChatErrorAlert session={session} error={error} inputRef={inputRef} /> : null}
      {notices.map((notice) => (
        <p key={notice} role="alert" className="text-caption text-destructive">
          {notice}
        </p>
      ))}
      {session.readOnly ? (
        <p role="status" className="text-caption text-muted-foreground">
          {m.chat_ui_read_only()}
        </p>
      ) : null}
      {/* fieldset 只用来在水合前整体禁用，不显示边框 */}
      <fieldset disabled={!hydrated} className="min-w-0">
        <InputMessage
          value={state.draft}
          onValueChange={(draft) => session.set({ draft })}
          onSend={() => void session.submit()}
          onStop={() => void session.stop()}
          busy={busy}
          disabled={session.readOnly}
          sendDisabled={!session.canSend || state.starting}
          placeholder={placeholder}
          labels={{
            message: m.chat_ui_message(),
            send: m.chat_ui_send(),
            stop: m.chat_ui_stop(),
          }}
          {...(inputRef ? { textareaRef: inputRef } : {})}
          textareaProps={{ id: inputId }}
          {...(compact ? { size: 'compact' as const } : {})}
          leading={
            <>
              <ModelPicker
                models={session.models}
                value={state.modelId}
                onChange={(modelId) => session.set({ modelId })}
                disabled={busy}
                compact
              />
              {session.canToggleThinking ? (
                <Switch
                  size="compact"
                  checked={state.thinking}
                  disabled={busy || session.readOnly}
                  onToggle={() => session.set({ thinking: !state.thinking })}
                  label={<span className="max-sm:sr-only">{m.chat_ui_thinking_toggle()}</span>}
                  className="text-caption text-muted-foreground"
                />
              ) : null}
            </>
          }
          trailing={
            // 项目可在 chat-composer.project.tsx 替换（#373）
            ProjectComposerEstimate ? (
              <ProjectComposerEstimate model={model} inputTokens={inputTokens} session={session} />
            ) : (
              <CreditEstimateText model={model} inputTokens={inputTokens} />
            )
          }
        />
      </fieldset>
      {disclaimer ? (
        <p className="text-center text-caption text-muted-foreground max-sm:hidden">
          {m.chat_ui_disclaimer()}
        </p>
      ) : null}
    </div>
  )
}
