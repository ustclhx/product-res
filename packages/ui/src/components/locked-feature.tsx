// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 Billing.dc.html「会员锁定态」卡片与 Components.dc.html
// 「会员」徽标）：会员锁定态。纯展示：不判断权益，调用方决定何时渲染锁定态；点击任何位置只触发 onUpgrade，
// 被锁的功能（children）以 inert 渲染，不可点击、不可聚焦。
import { Lock, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils.ts'
import { Badge } from './badge.tsx'
import { Button } from './button.tsx'

interface LockedFeatureProps {
  /** 功能名称，如「批量导出报告」 */
  title: string
  /** 解锁说明，如「升级后可用。一次导出空间内的全部报告为 PDF。」 */
  description: string
  /** 升级按钮文字，如「升级到专业版」 */
  actionLabel: string
  /** 订阅引导回调（打开定价页、升级弹窗等）；锁定态任何位置的点击都只触发它 */
  onUpgrade: () => void
  /** 标题旁的徽标文字，如「会员」 */
  badge?: string
  /** 被锁功能的预览：以 inert 渲染并减淡，点击它也只触发 onUpgrade */
  children?: ReactNode
  className?: string
}

function LockedFeature({
  title,
  description,
  actionLabel,
  onUpgrade,
  badge,
  children,
  className,
}: LockedFeatureProps) {
  return (
    <section
      data-locked=""
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col gap-2.5 rounded-xl border border-dashed bg-card px-5 py-4',
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-active"
        >
          <Lock className="size-4" strokeWidth={1.5} />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-subtitle">{title}</span>
          {badge ? (
            <Badge size="compact">
              <Lock aria-hidden className="mr-1 inline size-3 align-[-1px]" strokeWidth={2} />
              {badge}
            </Badge>
          ) : null}
        </span>
      </div>
      <p className="m-0 text-body text-muted-foreground">{description}</p>
      {children ? (
        // 鼠标点到被锁的控件时同样引导升级：捕获阶段拦下点击，预览中的控件收不到事件（inert 之外的第二道保险）。
        // 键盘与读屏用户使用下方的升级按钮，预览本身不可聚焦。
        <div
          data-locked-preview=""
          className="relative cursor-pointer"
          onClickCapture={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onUpgrade()
          }}
        >
          <div inert className="pointer-events-none select-none opacity-50">
            {children}
          </div>
        </div>
      ) : null}
      <Button type="button" size="sm" className="self-start" leadingIcon={Zap} onClick={onUpgrade}>
        {actionLabel}
      </Button>
    </section>
  )
}

export type { LockedFeatureProps }
export { LockedFeature }
