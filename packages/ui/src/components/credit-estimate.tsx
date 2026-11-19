// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 Chat.dc.html 输入框右下角「本次约 3 积分 · 余额 1,280」）：
// 预计消耗提示。纯展示：文字由调用方按语言与数值格式化后传入；余额不足时以危险色提示。
import { CircleAlert, Clock } from 'lucide-react'
import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '../lib/utils.ts'

interface CreditEstimateProps extends HTMLAttributes<HTMLSpanElement> {
  /** 已格式化的预计消耗，如「本次约 3 积分」；为 null 时显示占位（估算中） */
  estimate: string | null
  /** 已格式化的余额，如「余额 1,280」；不传时只显示预计消耗 */
  balance?: string
  /** 预计消耗超过余额：文字改用危险色（调用方另行决定是否禁止发送） */
  insufficient?: boolean
  /** 不显示图标（空间紧张的单行输入框） */
  hideIcon?: boolean
  /** 估算中（estimate 为 null）时给读屏的文字，如「正在估算消耗」 */
  pendingLabel?: string
}

const CreditEstimate = forwardRef<HTMLSpanElement, CreditEstimateProps>(
  (
    {
      estimate,
      balance,
      insufficient = false,
      hideIcon = false,
      pendingLabel,
      className,
      ...props
    },
    ref,
  ) => (
    <span
      ref={ref}
      data-insufficient={insufficient || undefined}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 text-caption tabular-nums',
        insufficient ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      {hideIcon ? null : insufficient ? (
        // 余额不足除颜色外换成提示图标，不只靠颜色区分
        <CircleAlert
          aria-hidden
          data-icon="insufficient"
          className="size-3 shrink-0"
          strokeWidth={2}
        />
      ) : (
        <Clock aria-hidden className="size-3 shrink-0" strokeWidth={1.5} />
      )}
      {estimate === null ? (
        <>
          <span
            aria-hidden
            className="inline-block h-3 w-16 animate-pulse rounded-sm bg-active motion-reduce:animate-none"
          />
          {pendingLabel ? <span className="sr-only">{pendingLabel}</span> : null}
        </>
      ) : (
        <span className="truncate">
          {estimate}
          {balance ? ` · ${balance}` : null}
        </span>
      )}
    </span>
  ),
)
CreditEstimate.displayName = 'CreditEstimate'

export type { CreditEstimateProps }
export { CreditEstimate }
