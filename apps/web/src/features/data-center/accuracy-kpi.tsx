import { cn, StatCard } from '@product-res/ui'
import { m } from '../../paraglide/messages.js'

export interface AccuracyStat {
  readonly sourceId: string
  readonly metric: string
  readonly agree: number
  readonly samples: number
  readonly rate: number | null
  readonly disqualified: boolean
  readonly belowTarget: boolean
}

export interface AccuracyKpis {
  readonly overall: number | null
  readonly samples: number
  readonly stats: readonly AccuracyStat[]
}

export const percent = (rate: number | null) =>
  rate === null ? '—' : `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`

const FIELD_LABEL: Record<string, () => string> = {
  price: m.accuracy_field_price,
  bought_month: m.accuracy_field_bought_month,
  review_count: m.accuracy_field_review_count,
  rating: m.accuracy_field_rating,
  bsr: m.accuracy_field_bsr,
  available_quantity: m.accuracy_field_available_quantity,
}

export const fieldLabel = (metric: string) => FIELD_LABEL[metric]?.() ?? metric

/**
 * 数据中心准确率 KPI（specs/data-accuracy「人工抽检与准确率」）：近 4 次抽检的总体一致率；
 * 任一 来源 × 字段 低于 95% 时标红，并列出不达标项。
 */
export function AccuracyKpiCard({
  kpis,
  sourceLabel = (id) => id,
  onOpen,
}: {
  kpis: AccuracyKpis
  sourceLabel?: (sourceId: string) => string
  onOpen?: () => void
}) {
  const failing = kpis.stats.filter((s) => s.belowTarget || s.disqualified)
  const danger = failing.length > 0
  const hint =
    kpis.samples === 0
      ? m.accuracy_kpi_empty()
      : danger
        ? m.accuracy_kpi_bad({
            count: String(failing.length),
            items: failing
              .map((s) => `${sourceLabel(s.sourceId)} · ${fieldLabel(s.metric)} ${percent(s.rate)}`)
              .join('；'),
          })
        : m.accuracy_kpi_ok()
  return (
    <div data-testid="accuracy-kpi" data-tone={danger ? 'danger' : 'neutral'} className="grid">
      <StatCard
        label={m.accuracy_kpi_label()}
        value={<span className={cn(danger && 'text-destructive')}>{percent(kpis.overall)}</span>}
        hint={
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn(danger && 'text-destructive')}>{hint}</span>
            {onOpen ? (
              <button type="button" className="text-primary underline" onClick={onOpen}>
                {m.accuracy_kpi_open()}
              </button>
            ) : null}
          </span>
        }
        className={cn(danger && 'border-destructive bg-destructive/5')}
      />
    </div>
  )
}
