import {
  Badge,
  Button,
  CreditEstimate,
  DailyClaimNotice,
  type DailyClaimStatus,
  EmbeddedChat,
  InsufficientCreditsDialog,
  LockedFeature,
  MessageFeedback,
  type MessageFeedbackLabels,
  type MessageFeedbackValue,
  SuggestionChips,
} from '@product-res/ui'
import { ChatMessage, InputMessage } from '@product-res/ui/chat'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { PreviewSection, Specimen } from './layout.tsx'

// 业务界面组件（openspec add-ui-design-system tasks 8.6）：中性示例数据（季度报告），回调只在页面上回显。

const format = (value: number) => new Intl.NumberFormat(getLocale()).format(value)

export function feedbackLabels(): MessageFeedbackLabels {
  return {
    group: m.ui_preview_biz_rate(),
    up: m.ui_preview_biz_helpful(),
    down: m.ui_preview_biz_not_helpful(),
    question: m.ui_preview_biz_question(),
    comment: m.ui_preview_biz_comment(),
    commentPlaceholder: m.ui_preview_biz_comment_placeholder(),
    submit: m.ui_preview_biz_submit(),
    cancel: m.ui_preview_cancel(),
    edit: m.ui_preview_biz_edit(),
    saved: m.ui_preview_biz_saved(),
    failed: m.ui_preview_biz_failed(),
  }
}

function reasons() {
  return [
    { value: 'inaccurate', label: m.ui_preview_biz_reason_inaccurate() },
    { value: 'incomplete', label: m.ui_preview_biz_reason_incomplete() },
    { value: 'no_source', label: m.ui_preview_biz_reason_no_source() },
    { value: 'too_long', label: m.ui_preview_biz_reason_too_long() },
  ]
}

/** 模拟保存：成功时把新值写回（与真实页面一致），fail 时 reject 让组件回滚 */
function FeedbackSpecimen({
  label,
  initial,
  fail = false,
  withReasons = false,
  withShare = false,
}: {
  label: string
  initial: MessageFeedbackValue | null
  fail?: boolean
  withReasons?: boolean
  withShare?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <Specimen label={label} className="flex-col items-stretch">
      <p className="m-0 text-body">{m.ui_preview_biz_chat_answer()}</p>
      <MessageFeedback
        value={value}
        labels={feedbackLabels()}
        meta={m.ui_preview_biz_meta()}
        {...(withReasons ? { reasons: reasons() } : {})}
        {...(withShare
          ? {
              shareLabels: {
                label: m.ui_preview_biz_share(),
                description: m.ui_preview_biz_share_description(),
              },
            }
          : {})}
        onChange={async (next) => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          if (fail) throw new Error('preview')
          setValue(next)
        }}
      />
    </Specimen>
  )
}

export function AiChatComponentsSection() {
  const [selected, setSelected] = useState<string | null>(null)
  const [fab, setFab] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const questions = [m.ui_preview_biz_q1(), m.ui_preview_biz_q2(), m.ui_preview_biz_q3()]
  const followUps = [m.ui_preview_biz_q4(), m.ui_preview_biz_q5()]

  const [draft, setDraft] = useState('')

  // 嵌入式对话的消息体与输入区使用对话页同一套组件（openspec add-ai-chat-components design D8，
  // 设计稿 docs/design-system/prototypes/chat-components/Embedded.dc.html）
  const chatBody = (
    <>
      <ChatMessage from="user" entrance={false}>
        {m.ui_preview_biz_chat_question()}
      </ChatMessage>
      <ChatMessage
        from="assistant"
        entrance={false}
        actions={
          <MessageFeedback
            value={null}
            labels={feedbackLabels()}
            meta={m.ui_preview_biz_credits({ count: format(2) })}
            onChange={() => {}}
          />
        }
      >
        {m.ui_preview_biz_chat_answer()}
      </ChatMessage>
      <SuggestionChips
        label={m.ui_preview_biz_follow_ups()}
        showLabel
        suggestions={followUps}
        onSelect={setSelected}
      />
    </>
  )
  const composer = (
    <InputMessage
      value={draft}
      onValueChange={setDraft}
      onSend={() => setDraft('')}
      placeholder={m.ui_preview_biz_chat_placeholder()}
      labels={{
        message: m.ui_preview_biz_chat_message(),
        send: m.ui_preview_biz_chat_send(),
        stop: m.ui_preview_chat_stop(),
      }}
      trailing={
        <CreditEstimate hideIcon estimate={m.ui_preview_biz_estimate_text({ count: format(2) })} />
      }
    />
  )
  const chatLabels = {
    trigger: m.ui_preview_biz_chat_trigger(),
    title: m.ui_preview_biz_chat_title(),
    close: m.ui_preview_biz_close(),
  }
  const chatProps = {
    labels: chatLabels,
    badge: <Badge size="compact">{m.ui_preview_biz_chat_subject()}</Badge>,
    footer: composer,
  }

  return (
    <PreviewSection
      id="business-chat"
      title="SuggestionChips · MessageFeedback · EmbeddedChat"
      description={m.ui_preview_biz_desc()}
    >
      <Specimen label={m.ui_preview_biz_suggestions()} className="flex-col items-stretch">
        <SuggestionChips
          label={m.ui_preview_biz_suggestions()}
          suggestions={questions}
          onSelect={setSelected}
        />
        <SuggestionChips
          label={m.ui_preview_biz_follow_ups()}
          showLabel
          suggestions={followUps}
          onSelect={setSelected}
        />
        <SuggestionChips
          label={m.ui_preview_disabled()}
          disabled
          suggestions={[m.ui_preview_disabled()]}
          onSelect={setSelected}
        />
        <p role="status" className="m-0 text-caption text-muted-foreground empty:hidden">
          {selected ? m.ui_preview_biz_selected({ text: selected }) : null}
        </p>
      </Specimen>
      <FeedbackSpecimen label={m.ui_preview_biz_feedback_none()} initial={null} />
      <FeedbackSpecimen
        label={m.ui_preview_biz_feedback_up()}
        initial={{ rating: 'up', comment: null }}
      />
      <FeedbackSpecimen
        label={m.ui_preview_biz_feedback_down()}
        initial={{ rating: 'down', comment: null, reason: 'incomplete' }}
        withReasons
      />
      <FeedbackSpecimen
        label={m.ui_preview_biz_feedback_share()}
        initial={{
          rating: 'down',
          comment: null,
          reason: 'no_source',
          shareConversation: true,
        }}
        withReasons
        withShare
      />
      <FeedbackSpecimen
        label={m.ui_preview_biz_feedback_error()}
        initial={{ rating: 'up', comment: null }}
        fail
      />
      <Specimen label={m.ui_preview_biz_chat_panel()} className="flex-col items-start">
        <p className="m-0 text-body text-muted-foreground">{m.ui_preview_biz_chat_hint()}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setFab((value) => !value)}>
            {fab ? m.ui_preview_biz_chat_hide() : m.ui_preview_biz_chat_show()}
          </Button>
          <Button type="button" variant="outline" onClick={() => setPanelOpen(true)}>
            {m.ui_preview_biz_chat_open()}
          </Button>
        </div>
        {fab ? <EmbeddedChat {...chatProps}>{chatBody}</EmbeddedChat> : null}
        <EmbeddedChat
          {...chatProps}
          showTrigger={false}
          open={panelOpen}
          onOpenChange={setPanelOpen}
          headerAction={
            <Button type="button" variant="link" size="compact">
              {m.ui_preview_biz_chat_open_full()}
            </Button>
          }
        >
          {chatBody}
        </EmbeddedChat>
      </Specimen>
      <Specimen label={m.ui_preview_biz_chat_inline()} wide className="flex-col items-stretch">
        <p className="m-0 text-body text-muted-foreground">{m.ui_preview_biz_chat_inline_hint()}</p>
        <EmbeddedChat
          {...chatProps}
          variant="inline"
          headerAction={
            <Button type="button" variant="link" size="compact">
              {m.ui_preview_biz_chat_open_full()}
            </Button>
          }
        >
          {chatBody}
        </EmbeddedChat>
      </Specimen>
    </PreviewSection>
  )
}

export function CreditsComponentsSection() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [daily, setDaily] = useState<DailyClaimStatus>('available')
  const dailyLabels = {
    claim: m.ui_preview_biz_daily_claim(),
    claimed: m.ui_preview_biz_daily_claimed(),
    dismiss: m.ui_preview_biz_daily_dismiss(),
  }
  const claimed = daily === 'claimed'
  const dailyTitle = claimed
    ? m.ui_preview_biz_daily_claimed_title()
    : m.ui_preview_biz_daily_available_title()
  const dailyDesc = claimed
    ? m.ui_preview_biz_daily_claimed_desc()
    : m.ui_preview_biz_daily_available_desc()

  return (
    <PreviewSection
      id="business-credits"
      title="InsufficientCreditsDialog · CreditEstimate · LockedFeature · DailyClaimNotice"
      description={m.ui_preview_biz_desc()}
    >
      <Specimen label={m.ui_preview_biz_insufficient()} className="flex-col items-start">
        <Button type="button" onClick={() => setDialogOpen(true)}>
          {m.ui_preview_biz_insufficient_open()}
        </Button>
        <p role="status" className="m-0 text-caption text-muted-foreground empty:hidden">
          {action ? m.ui_preview_biz_last_action({ action }) : null}
        </p>
        <InsufficientCreditsDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          estimatedCredits={30}
          availableCredits={10}
          labels={{
            title: m.ui_preview_biz_insufficient_title(),
            description: m.ui_preview_biz_insufficient_desc(),
            estimated: m.ui_preview_biz_estimated(),
            available: m.ui_preview_biz_available(),
            credits: (value) => m.ui_preview_biz_credits({ count: format(value) }),
            shortfall: (missing) => m.ui_preview_biz_shortfall({ count: format(missing) }),
            buyPacks: m.ui_preview_biz_buy_packs(),
            subscribe: m.ui_preview_biz_subscribe(),
            close: m.ui_preview_biz_close(),
          }}
          onBuyPacks={() => {
            setAction(m.ui_preview_biz_buy_packs())
            setDialogOpen(false)
          }}
          onSubscribe={() => {
            setAction(m.ui_preview_biz_subscribe())
            setDialogOpen(false)
          }}
        />
      </Specimen>
      <Specimen label={m.ui_preview_biz_estimate()} className="flex-col items-start">
        <CreditEstimate
          estimate={m.ui_preview_biz_estimate_text({ count: format(3) })}
          balance={m.ui_preview_biz_balance_text({ count: format(1280) })}
        />
        <span className="text-caption text-muted-foreground">
          {m.ui_preview_biz_estimate_low()}
        </span>
        <CreditEstimate
          estimate={m.ui_preview_biz_estimate_text({ count: format(30) })}
          balance={m.ui_preview_biz_balance_text({ count: format(10) })}
          insufficient
        />
        <span className="text-caption text-muted-foreground">
          {m.ui_preview_biz_estimate_pending()}
        </span>
        <CreditEstimate estimate={null} pendingLabel={m.ui_preview_biz_estimate_pending_sr()} />
      </Specimen>
      <Specimen label={m.ui_preview_biz_locked()} className="flex-col items-stretch">
        <LockedFeature
          title={m.ui_preview_biz_locked_title()}
          description={m.ui_preview_biz_locked_desc()}
          actionLabel={m.ui_preview_biz_locked_action()}
          badge={m.ui_preview_biz_locked_badge()}
          onUpgrade={() => setAction(m.ui_preview_biz_locked_action())}
        >
          <Button type="button" variant="outline" onClick={() => setAction('run')}>
            {m.ui_preview_biz_locked_preview()}
          </Button>
        </LockedFeature>
      </Specimen>
      <Specimen label={m.ui_preview_biz_daily()} wide className="flex-col items-stretch">
        <DailyClaimNotice
          status={daily}
          title={dailyTitle}
          description={dailyDesc}
          labels={dailyLabels}
          onClaim={() => {
            setDaily('pending')
            setTimeout(() => setDaily('claimed'), 600)
          }}
          {...(claimed ? { onDismiss: () => setDaily('available') } : {})}
        />
        <DailyClaimNotice
          status="error"
          title={m.ui_preview_biz_daily_available_title()}
          description={m.ui_preview_biz_daily_available_desc()}
          error={m.ui_preview_biz_daily_error()}
          labels={dailyLabels}
          onClaim={() => {}}
        />
      </Specimen>
      <Specimen label={m.ui_preview_biz_daily_compact()} className="flex-col items-stretch">
        <DailyClaimNotice
          compact
          status="available"
          title={m.ui_preview_biz_daily_available_title()}
          description={m.ui_preview_biz_daily_available_desc()}
          labels={{ ...dailyLabels, claim: m.ui_preview_biz_daily_claim() }}
          onClaim={() => {}}
        />
      </Specimen>
    </PreviewSection>
  )
}
