import { cn, Label } from '@product-res/ui'
import type { ComponentProps, ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { ADMIN_COPY } from './copy.ts'

/** 后台页面共用的布局、字段与展示小件；交互控件统一使用 @product-res/ui。 */

/** 标签 + 控件 + 说明的纵向字段；控件需自带与 htmlFor 一致的 id */
export function Field({
  label,
  htmlFor,
  description,
  className,
  children,
}: {
  label: ReactNode
  htmlFor: string
  description?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
    </div>
  )
}

/**
 * 后台页面骨架：统一的标题字号与可选说明。
 * grid-cols-1（minmax(0,1fr)）让宽表格在自身容器里横向滚动，而不是把整页撑宽。
 */
export function AdminPage({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <section className={cn('grid min-w-0 grid-cols-1 content-start gap-6', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="font-semibold text-2xl tracking-tight">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** 页面内的分区：小标题 + 内容 */
export function AdminSection({
  title,
  actions,
  className,
  children,
}: {
  title: ReactNode
  actions?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <section className={cn('grid min-w-0 grid-cols-1 gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-lg">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** 卡片式区块（表单、编辑器）的样式；tone="danger" 用于封禁等危险操作 */
export function panelClass(tone: 'default' | 'danger' = 'default', className?: string) {
  return cn(
    'grid min-w-0 gap-4 rounded-lg border bg-card p-4 text-card-foreground sm:p-5',
    tone === 'danger' && 'border-destructive/50 bg-destructive/5',
    className,
  )
}

export function Panel({
  tone = 'default',
  className,
  ...props
}: ComponentProps<'div'> & { tone?: 'default' | 'danger' }) {
  return <div className={panelClass(tone, className)} {...props} />
}

export function EmptyState({ children }: { children?: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-sm">
      {children ?? ADMIN_COPY.empty}
    </p>
  )
}

/** 固定按 UTC 显示到分钟：服务端与浏览器输出一致，避免水合差异 */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function adminTableLabels() {
  return {
    previous: m.admin_previous(),
    next: m.admin_next(),
    page: (page: number, pageCount: number | null) =>
      pageCount === null
        ? m.admin_page({ page: page })
        : m.admin_page_of({ page: page, pageCount: pageCount }),
    empty: m.admin_no_records_found(),
    applyFilters: m.admin_apply(),
    resetFilters: m.admin_reset(),
    filters: m.admin_filters(),
    pagination: m.admin_pagination(),
  }
}
