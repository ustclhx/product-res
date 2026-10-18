import { type AcquisitionMethod, cn, SourceBadge } from '@product-res/ui'
import type { ReactNode } from 'react'
import { formatTime } from '../data-center/shared.tsx'

/** 跟卖选品页面共用的小部件：商品缩略图、来源悬浮卡与数值格式 */

export function ProductThumb({
  src,
  title,
  size = 40,
}: {
  src: string | null
  title: string
  size?: number
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-xs font-semibold text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        // 没有图片时用标题首字母占位，不放示例图
        <span aria-hidden>{title.trim().charAt(0).toUpperCase() || '·'}</span>
      )}
    </span>
  )
}

export function formatMoney(value: number, currency: string | null | undefined) {
  if (!currency) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

export const formatInt = (value: number) =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)

/** 指标值的显示：价格带币种，排名加 #，其余按数字 */
export function formatMetric(metric: string, value: number, currency?: string | null) {
  if (currency || metric.endsWith('price')) return formatMoney(value, currency)
  if (metric === 'bsr') return `#${formatInt(value)}`
  if (metric === 'rating') return value.toFixed(1)
  return formatInt(value)
}

/** 距今天数（UTC 日历日）；过去为负 */
export function daysUntil(day: string, today = new Date().toISOString().slice(0, 10)) {
  return Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000)
}

export interface SourceValueView {
  sourceId: string
  label: string
  value: number
  currency: string | null
  method: AcquisitionMethod
  fetchedAt: string
}

export interface MetricSourcesView {
  metric: string
  label: string
  observedOn: string
  primarySourceId: string
  dispersion: number | null
  values: SourceValueView[]
}

export function dispersionText(dispersion: number | null, sources: number) {
  if (sources < 2 || dispersion === null) return '未交叉验证'
  return `${Math.round(dispersion * 100)}%`
}

/** 各来源值、主值来源、离散度与获取时间（spec「查看来源」） */
export function SourceList({ view }: { view: MetricSourcesView }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {view.label} · 观测日 {view.observedOn}
        </span>
        <span>离散度 {dispersionText(view.dispersion, view.values.length)}</span>
      </div>
      <ul className="grid gap-1">
        {view.values.map((v) => (
          <li key={v.sourceId} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <SourceBadge method={v.method} source={v.label} />
              {v.sourceId === view.primarySourceId ? (
                <span className="text-[11px] text-primary">主值</span>
              ) : null}
            </span>
            <span className="flex items-baseline gap-2">
              <span className="font-mono font-medium text-foreground">
                {formatMetric(view.metric, v.value, v.currency)}
              </span>
              <span className="text-[11px] text-muted-foreground">{formatTime(v.fetchedAt)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 悬浮或聚焦时展开来源明细的数值。纯 CSS 展开（group-hover / focus-within），
 * 不依赖额外的弹层库；键盘用户 Tab 聚焦后同样可见。
 */
export function SourceHover({
  view,
  children,
  align = 'right',
  className,
}: {
  view: MetricSourcesView | null
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  if (!view) return <span className={className}>{children}</span>
  return (
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 悬浮卡需要键盘可达，聚焦即显示来源
      tabIndex={0}
      data-testid={`source-hover-${view.metric}`}
      className={cn(
        'group relative inline-flex cursor-help rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      {children}
      <span
        role="tooltip"
        className={cn(
          'invisible absolute top-full z-20 mt-2 w-80 rounded-lg border bg-popover p-3 text-left font-normal no-underline opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        <SourceList view={view} />
      </span>
    </span>
  )
}
