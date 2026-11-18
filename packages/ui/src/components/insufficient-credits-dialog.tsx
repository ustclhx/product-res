// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 docs/design-system/prototypes/ui-review/Billing.dc.html
// 的 showInsufficient 分支）：余额不足弹窗。纯展示：数值与文案由调用方传入，两个入口经回调交给调用方跳转。
// 通常没有 Trigger（由接口错误打开），关闭后把焦点还给打开前的元素（同 AlertDialog）。
import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog.tsx'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface InsufficientCreditsLabels {
  /** 如「积分不足」 */
  title: string
  /** 如「这次生成需要的积分超过了当前余额，补充后会继续执行。」 */
  description: string
  /** 如「本次预计消耗」 */
  estimated: string
  /** 如「当前余额」 */
  available: string
  /** 积分数值的显示，如 `(n) => \`${n} 积分\``；调用方负责千分位 */
  credits: (value: number) => string
  /** 差额说明，如 `(n) => \`还差 ${n} 积分。积分包长期有效；订阅每月发放积分。\`` */
  shortfall?: (missing: number) => string
  buyPacks: string
  subscribe: string
  close: string
}

interface InsufficientCreditsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 本次预计消耗（整数积分） */
  estimatedCredits: number
  /** 当前可用余额（整数积分） */
  availableCredits: number
  labels: InsufficientCreditsLabels
  /** 主入口：购买积分包 */
  onBuyPacks: () => void
  /** 次入口：订阅；不传时不显示（如项目没有订阅套餐） */
  onSubscribe?: () => void
  /** 打开前没有可还焦点的元素（焦点在 body，如由接口错误打开）时，关闭后改把焦点给它，如对话输入框 */
  fallbackFocus?: () => HTMLElement | null
}

function InsufficientCreditsDialog({
  open,
  onOpenChange,
  estimatedCredits,
  availableCredits,
  labels,
  onBuyPacks,
  onSubscribe,
  fallbackFocus,
}: InsufficientCreditsDialogProps) {
  // 受控打开、没有 Trigger：Radix 关闭时只把焦点还给 Trigger，这里记录打开前的焦点元素并归还
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useIsoLayoutEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
  }, [open])
  const missing = Math.max(estimatedCredits - availableCredits, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={labels.close}
        onCloseAutoFocus={(event) => {
          const recorded = returnFocusRef.current
          returnFocusRef.current = null
          const usable = recorded && recorded !== document.body && recorded.isConnected
          const target = usable ? recorded : (fallbackFocus?.() ?? null)
          if (!target) return
          event.preventDefault()
          target.focus({ preventScroll: true })
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        <dl className="m-0 grid grid-cols-2 gap-2">
          <CreditFigure label={labels.estimated} value={labels.credits(estimatedCredits)} />
          <CreditFigure
            label={labels.available}
            value={labels.credits(availableCredits)}
            tone="destructive"
          />
        </dl>
        {labels.shortfall && missing > 0 ? (
          <p className="mt-2 mb-0 text-caption text-muted-foreground">
            {labels.shortfall(missing)}
          </p>
        ) : null}
        <DialogFooter className="flex-wrap">
          {onSubscribe ? (
            <Button type="button" variant="outline" onClick={onSubscribe}>
              {labels.subscribe}
            </Button>
          ) : null}
          <Button type="button" onClick={onBuyPacks}>
            {labels.buyPacks}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreditFigure({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'destructive'
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-hover px-3.5 py-3 inset-ring-1 inset-ring-border">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'm-0 font-semibold text-title tabular-nums',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export type { InsufficientCreditsDialogProps, InsufficientCreditsLabels }
export { InsufficientCreditsDialog }
