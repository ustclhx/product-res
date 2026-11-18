import {
  MessageFeedback as FeedbackView,
  InsufficientCreditsDialog,
  SuggestionChips as SuggestionChipsView,
} from '@product-res/ui'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import {
  FEEDBACK_COMMENT_MAX_LENGTH,
  FEEDBACK_REASONS,
  FEEDBACK_SHARED_PRIOR_MESSAGES,
  type FeedbackReason,
  isFeedbackReason,
  type MessageFeedbackValue,
} from './feedback.ts'

/**
 * 推荐追问、消息评分与余额不足弹窗的接线层（add-subject-chat design 决策 9 的接口）：
 * 展示组件来自 `@product-res/ui`（add-ui-design-system tasks 8.6），这里只传入按语言的文案，props 与回调不变。
 */

export interface SuggestionChipsProps {
  /** 已本地化的问题 */
  readonly suggestions: readonly string[]
  /** 生成中或只读空间 */
  readonly disabled?: boolean
  /** 立即作为用户消息发送；问题本身不写入历史 */
  onSelect(text: string): void
  /** 无障碍分组名 */
  readonly label?: string
  /** 在按钮组上方显示分组名（回复后的「继续追问」） */
  readonly showLabel?: boolean
  readonly className?: string
}

export function SuggestionChips({
  suggestions,
  disabled,
  onSelect,
  label,
  showLabel,
  className,
}: SuggestionChipsProps) {
  return (
    <SuggestionChipsView
      suggestions={suggestions}
      label={label ?? m.subject_chat_suggestions()}
      showLabel={showLabel ?? false}
      disabled={disabled ?? false}
      onSelect={onSelect}
      {...(className ? { className } : {})}
    />
  )
}

export interface MessageFeedbackProps {
  readonly messageId: string
  /** null = 未评分 */
  readonly value: MessageFeedbackValue | null
  readonly disabled?: boolean
  /** null = 撤销；失败时 reject，组件回滚并提示 */
  onChange(next: MessageFeedbackValue | null): Promise<void>
  /** 评分按钮之前的操作（复制回复） */
  readonly actions?: ReactNode
  /** 评分按钮之后的说明（消耗积分与模型） */
  readonly meta?: ReactNode
}

/** 点踩原因的文案（画板 Chat.dc.html 的四个选项）；取值集合来自 `FEEDBACK_REASONS`，与服务端校验一致 */
const reasonLabels: Record<FeedbackReason, () => string> = {
  inaccurate: () => m.subject_chat_feedback_reason_inaccurate(),
  incomplete: () => m.subject_chat_feedback_reason_incomplete(),
  no_source: () => m.subject_chat_feedback_reason_no_source(),
  too_long: () => m.subject_chat_feedback_reason_too_long(),
}

export const feedbackReasonLabel = (reason: FeedbackReason) => reasonLabels[reason]()

export function MessageFeedback({
  value,
  disabled,
  onChange,
  actions,
  meta,
}: MessageFeedbackProps) {
  return (
    <FeedbackView
      actions={actions}
      meta={meta}
      value={value}
      disabled={disabled ?? false}
      commentMaxLength={FEEDBACK_COMMENT_MAX_LENGTH}
      reasons={FEEDBACK_REASONS.map((reason) => ({ value: reason, label: reasonLabels[reason]() }))}
      onChange={(next) =>
        onChange(
          next
            ? {
                rating: next.rating,
                comment: next.comment,
                // 组件只会回传 reasons 中的取值；点赞时为 null
                reason:
                  next.rating === 'down' && isFeedbackReason(next.reason) ? next.reason : null,
                // 只有用户在表单中明确勾选才算同意
                shareConversation: next.shareConversation === true,
              }
            : null,
        )
      }
      shareLabels={{
        label: m.subject_chat_feedback_share(),
        description: m.subject_chat_feedback_share_description({
          count: FEEDBACK_SHARED_PRIOR_MESSAGES,
        }),
      }}
      labels={{
        group: m.subject_chat_feedback(),
        up: m.subject_chat_feedback_up(),
        down: m.subject_chat_feedback_down(),
        question: m.chat_ui_feedback_question(),
        comment: m.subject_chat_feedback_comment(),
        submit: m.subject_chat_feedback_submit(),
        cancel: m.common_cancel(),
        edit: m.chat_ui_feedback_edit(),
        saved: m.subject_chat_feedback_saved(),
        failed: m.subject_chat_feedback_failed(),
      }}
    />
  )
}

export const formatNumber = (value: number) => new Intl.NumberFormat(getLocale()).format(value)

/** 余额不足弹窗（INSUFFICIENT_CREDITS 的 estimatedCredits / availableCredits），两个入口由调用方跳转 */
export function CreditsDialog({
  open,
  onOpenChange,
  estimatedCredits,
  availableCredits,
  onBuyPacks,
  onSubscribe,
  fallbackFocus,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  estimatedCredits: number
  availableCredits: number
  onBuyPacks(): void
  /** 项目没有订阅套餐时不传，弹窗只显示购买积分包 */
  onSubscribe?: (() => void) | undefined
  /** 关闭后焦点的去处（打开前焦点在 body 时），如对话输入框 */
  fallbackFocus?: (() => HTMLElement | null) | undefined
}) {
  return (
    <InsufficientCreditsDialog
      open={open}
      onOpenChange={onOpenChange}
      estimatedCredits={estimatedCredits}
      availableCredits={availableCredits}
      onBuyPacks={onBuyPacks}
      {...(onSubscribe ? { onSubscribe } : {})}
      // 弹窗由接口错误打开时焦点可能在 body：关闭后回到对话输入框
      fallbackFocus={fallbackFocus ?? (() => null)}
      labels={{
        title: m.billing_credit_guide_title(),
        description: m.chat_ui_credits_description(),
        estimated: m.chat_ui_credits_estimated(),
        available: m.chat_ui_credits_available(),
        credits: (value) => m.chat_ui_credits_value({ count: formatNumber(value) }),
        shortfall: (missing) => m.chat_ui_credits_shortfall({ count: formatNumber(missing) }),
        buyPacks: m.billing_credit_guide_packs(),
        subscribe: m.chat_ui_credits_subscribe(),
        close: m.chat_ui_close(),
      }}
    />
  )
}
