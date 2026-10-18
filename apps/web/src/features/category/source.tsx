import { cn, SourceBadge } from '@product-res/ui'
import type { ReactNode } from 'react'
import { fmtDateTime, fmtNumber, fmtPercent } from './format.ts'
import type { SourcedNumber, SourceSummary } from './types.ts'

/**
 * “查看来源”：每个数值旁的小按钮，展开后列出来源、获取方式、获取时间与其他来源的值。
 * 用原生 <details>，无需脚本即可开合，服务端渲染与截图中都可用。
 */
export function SourcePopover({
  label = '来源',
  align = 'left',
  children,
  className,
}: {
  label?: string
  align?: 'left' | 'right' | undefined
  children: ReactNode
  className?: string
}) {
  return (
    <details className={cn('group relative inline-block', className)} data-slot="source">
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-0.5 rounded px-1 text-[11px] text-subtle-foreground hover:bg-muted hover:text-primary [&::-webkit-details-marker]:hidden"
        aria-label={`查看${label}`}
      >
        <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7v4M8 5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {label}
      </summary>
      <div
        className={cn(
          'absolute top-full z-30 mt-1 grid w-72 gap-2 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </div>
    </details>
  )
}

export function SummarySources({
  sources,
  note,
}: {
  sources: readonly SourceSummary[]
  note?: ReactNode
}) {
  return (
    <SourcePopover>
      {sources.length === 0 ? <p className="text-muted-foreground">无来源记录</p> : null}
      {sources.map((s) => (
        <div key={s.sourceId} className="grid gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <SourceBadge method={s.method} source={s.sourceId} />
            <span className="text-muted-foreground">{s.points} 条观测</span>
          </div>
          <span className="text-muted-foreground">最近获取 {fmtDateTime(s.latestAt)}</span>
        </div>
      ))}
      {note ? <p className="border-t pt-2 text-muted-foreground">{note}</p> : null}
    </SourcePopover>
  )
}

export function ValueSources({
  value,
  format = fmtNumber,
  align,
}: {
  value: SourcedNumber
  format?: (n: number) => string
  align?: 'left' | 'right' | undefined
}) {
  return (
    <SourcePopover align={align}>
      <div className="grid gap-0.5">
        <div className="flex items-center justify-between gap-2">
          <SourceBadge method={value.method} source={value.sourceId} />
          <span className="font-mono">{format(value.value)}</span>
        </div>
        <span className="text-muted-foreground">
          观测日 {value.observedOn} · 获取 {fmtDateTime(value.at)}
        </span>
      </div>
      {value.alternatives.length > 0 ? (
        <div className="grid gap-1 border-t pt-2">
          <span className="text-muted-foreground">同日其他来源</span>
          {value.alternatives.map((a) => (
            <div key={a.sourceId} className="flex items-center justify-between gap-2">
              <SourceBadge method={a.method} source={a.sourceId} />
              <span className="font-mono">{format(a.value)}</span>
            </div>
          ))}
          <span className="text-muted-foreground">离散度 {fmtPercent(value.dispersion)}</span>
        </div>
      ) : (
        <p className="border-t pt-2 text-muted-foreground">只有一个来源，未交叉验证</p>
      )}
    </SourcePopover>
  )
}
