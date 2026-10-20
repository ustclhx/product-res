import { cn } from '@product-res/ui'
import type { ReactNode } from 'react'

export const KIND_LABELS: Record<string, string> = {
  'seller-new-listings': '卖家新品',
  'product-snapshot': '商品快照',
  'sales-estimate': '销量估算',
  'rank-history': '排名历史',
  'keyword-volume': '关键词搜索量',
  'search-trend': '搜索趋势',
  reviews: '评论',
  'fee-estimate': '费用预估',
  taxonomy: '类目',
  'fx-rate': '汇率',
  'amazon-search': 'Amazon 关键词搜索',
  'amazon-asin': 'Amazon 商品详情',
  'amazon-offers': 'Amazon 卖家报价',
  'amazon-keyword-volume': 'Amazon 关键词搜索量',
  'amazon-product': 'Amazon 商品页（交叉验证）',
}

export const RUN_STATUS: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }
> = {
  running: { label: '进行中', tone: 'info' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  deferred: { label: '已顺延', tone: 'warning' },
  skipped: { label: '已跳过', tone: 'neutral' },
}

export const formatTime = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Singapore',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso))
    : '—'

export const formatNumber = (n: number) => new Intl.NumberFormat('zh-CN').format(n)

export function Section({
  title,
  actions,
  children,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function SimpleTable({
  head,
  children,
  empty,
}: {
  head: readonly string[]
  children: ReactNode
  empty?: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
      {empty ? <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p> : null}
    </div>
  )
}

export function ProgressBar({
  value,
  max,
  warnAt,
}: {
  value: number
  max: number
  warnAt?: number
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100))
  const warn = warnAt !== undefined && value >= warnAt
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full', warn ? 'bg-warning' : 'bg-primary')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作失败，请重试'
}
