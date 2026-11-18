// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 Workbench.dc.html / WorkbenchMobile.dc.html 顶部的
// 「今日奖励可领取」条）：每日领取提示。纯展示：领取与去重由调用方的数据层负责，组件只呈现状态并回调。
// 状态：available（可领取，显示领取按钮）、pending（领取中）、claimed（已到账，显示徽标）、error（失败可重试）。
import { Check, Gift, X } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../lib/utils.ts'
import { Badge } from './badge.tsx'
import { Button } from './button.tsx'

type DailyClaimStatus = 'available' | 'pending' | 'claimed' | 'error'

interface DailyClaimLabels {
  /** 领取按钮，如「领取 10 积分」 */
  claim: string
  /** 已领取徽标，如「今日已领取」 */
  claimed: string
  /** 关闭按钮的可读名称；传了 onDismiss 时必填 */
  dismiss?: string
}

interface DailyClaimNoticeProps {
  status: DailyClaimStatus
  /** 如「今日登录奖励可领取」/「已领取今日奖励」，随状态由调用方给出 */
  title: string
  /** 如「每天可领取 10 积分，按 UTC 日计算。」/「10 积分已到账，明天再来。」 */
  description: string
  labels: DailyClaimLabels
  /** 手动领取；自动发放的项目不传，available 状态也不显示按钮 */
  onClaim?: () => void
  /** 关闭提示（如自动到账后的一次性通知） */
  onDismiss?: () => void
  /** error 状态的说明，以危险色显示在描述下方 */
  error?: string
  /** 强制紧凑布局（图标不加圆底、内边距更小）；不传时 < sm 自动紧凑 */
  compact?: boolean
  className?: string
}

function DailyClaimNotice({
  status,
  title,
  description,
  labels,
  onClaim,
  onDismiss,
  error,
  compact = false,
  className,
}: DailyClaimNoticeProps) {
  const canClaim = onClaim && status !== 'claimed'
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      data-status={status}
      className={cn(
        // < sm 自动用紧凑样式（WorkbenchMobile 画板）；按钮放不下时换到下一行
        'flex min-w-0 flex-wrap items-center rounded-xl border bg-card',
        compact
          ? 'gap-2.5 py-2.5 pr-2.5 pl-3'
          : 'gap-2.5 py-2.5 pr-2.5 pl-3 sm:gap-3 sm:py-3 sm:pr-3 sm:pl-4',
        className,
      )}
    >
      <Gift
        aria-hidden
        className={cn('size-4.5 shrink-0', !compact && 'sm:hidden')}
        strokeWidth={1.5}
      />
      {compact ? null : (
        <span
          aria-hidden
          className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-active sm:inline-flex"
        >
          <Gift className="size-4" strokeWidth={1.5} />
        </span>
      )}
      {/* 只播报文字（领取结果、错误），按钮不在播报区域内 */}
      <div role="status" className="flex min-w-0 flex-1 basis-40 flex-col">
        <span id={titleId} className="font-medium text-body">
          {title}
        </span>
        <span className="text-caption text-muted-foreground">{description}</span>
        {status === 'error' && error ? (
          <span className="text-caption text-destructive">{error}</span>
        ) : null}
      </div>
      {/* 操作区作为一组换行，放不下时整体落到下一行右侧 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {status === 'claimed' ? (
          <Badge color="green" className="shrink-0">
            <Check
              aria-hidden
              className="mr-1 inline size-3 align-[-1px] text-success"
              strokeWidth={2.5}
            />
            {labels.claimed}
          </Badge>
        ) : canClaim ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            loading={status === 'pending'}
            onClick={onClaim}
          >
            {labels.claim}
          </Button>
        ) : null}
        {onDismiss && labels.dismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={labels.dismiss}
            onClick={onDismiss}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export type { DailyClaimLabels, DailyClaimNoticeProps, DailyClaimStatus }
export { DailyClaimNotice }
