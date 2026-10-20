import { parseBoughtText } from '@product-res/datasources'
import { Button, DataTable, type DataTableColumn, Input, Tag } from '@product-res/ui'
import { useCallback, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import {
  generateAccuracyAudit,
  getAccuracy,
  saveAccuracyItem,
  submitAccuracyAudit,
} from './accuracy.functions.ts'
import { type AccuracyKpis, fieldLabel, percent } from './accuracy-kpi.tsx'
import { intervalText, TierTag } from './observation-cells.tsx'
import { errorText, formatNumber, formatTime, Section } from './shared.tsx'

type AccuracyData = Awaited<ReturnType<typeof getAccuracy>>
type AuditItem = AccuracyData['items'][number]
type HistoryRow = AccuracyData['history'][number]

/** 抽检字段（与 @product-res/marketdata 的 AUDIT_FIELDS 一致；客户端不引入数据库包） */
export const AUDIT_FIELDS = [
  'price',
  'bought_month',
  'review_count',
  'rating',
  'bsr',
  'available_quantity',
] as const
type Field = (typeof AUDIT_FIELDS)[number]

interface Collected {
  value: number
  low: number | null
  high: number | null
  currency: string | null
  tier: number
  channel: string | null
  fetchedAt: string
}

const tableLabels = () => ({
  previous: m.accuracy_previous(),
  next: m.accuracy_next(),
  page: (page: number, count: number | null) =>
    m.accuracy_page({ page: String(page), count: String(count ?? page) }),
  empty: m.accuracy_empty(),
  pagination: m.accuracy_pagination(),
})

/** 某来源某字段的采集值文本：bought 显示区间，价格带币种，可售状态显示可售 / 不可售 */
export function collectedText(field: Field, v: Collected) {
  if (field === 'bought_month')
    return v.low === null ? formatNumber(v.value) : intervalText(v.low, v.high)
  if (field === 'available_quantity')
    return v.value > 0 ? m.accuracy_available_yes() : m.accuracy_available_no()
  if (field === 'price') return `${v.value}${v.currency ? ` ${v.currency}` : ''}`
  return formatNumber(v.value)
}

type Draft = Record<Field, string>

function draftOf(actual: AuditItem['actual']): Draft {
  const a = (actual ?? {}) as Partial<Record<Field, number | boolean | null>>
  const text = (v: number | boolean | null | undefined) =>
    v === null || v === undefined ? '' : String(v)
  return {
    price: text(a.price),
    bought_month: text(a.bought_month),
    review_count: text(a.review_count),
    rating: text(a.rating),
    bsr: text(a.bsr),
    available_quantity:
      a.available_quantity === true ? 'yes' : a.available_quantity === false ? 'no' : '',
  }
}

/** 草稿 → 提交值；无法识别的数字返回 null 字段名供提示 */
export function actualOf(draft: Draft): {
  actual: Record<string, number | boolean | null>
  invalid: Field | null
} {
  const actual: Record<string, number | boolean | null> = {}
  for (const field of AUDIT_FIELDS) {
    const raw = draft[field].trim()
    if (field === 'available_quantity') {
      actual[field] = raw === 'yes' ? true : raw === 'no' ? false : null
      continue
    }
    if (raw === '') {
      actual[field] = null
      continue
    }
    // bought 允许直接粘贴徽标文本（"1K+ bought"）
    const n =
      field === 'bought_month' && /\+/.test(raw)
        ? parseBoughtText(raw)
        : Number(raw.replace(/[$,\s]/g, ''))
    if (n === null || !Number.isFinite(n) || n < 0) return { actual, invalid: field }
    actual[field] = n
  }
  return { actual, invalid: null }
}

function AgreementTags({ item, field }: { item: AuditItem; field: Field }) {
  const agreement = item.agreement as Record<string, Partial<Record<Field, boolean>>> | null
  if (!agreement) return null
  const tags = Object.entries(agreement).filter(([, f]) => f[field] !== undefined)
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map(([sourceId, f]) => (
        <Tag key={sourceId} tone={f[field] ? 'success' : 'danger'}>
          {sourceId} {f[field] ? m.accuracy_agree() : m.accuracy_disagree()}
        </Tag>
      ))}
    </span>
  )
}

/** 一项的逐字段核对：各来源采集值（含层级与采集时间）、页面实际值输入、一致结果 */
export function AuditItemForm({
  slug,
  item,
  readOnly,
  onSaved,
}: {
  slug: string
  item: AuditItem
  readOnly: boolean
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item.actual))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const collected = item.collected as Record<string, Partial<Record<Field, Collected>>>
  const sources = Object.keys(collected).sort()
  async function save() {
    const { actual, invalid } = actualOf(draft)
    if (invalid) {
      setError(fieldLabel(invalid))
      return
    }
    setBusy(true)
    setError('')
    try {
      await saveAccuracyItem({ data: { slug, itemId: item.id, actual } })
      setSaved(true)
      await onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-2">
      {sources.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.accuracy_no_collected()}</p>
      ) : null}
      <table className="w-full min-w-[560px] text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 text-left font-medium">{m.accuracy_field()}</th>
            <th className="py-1 pr-2 text-left font-medium">{m.accuracy_collected()}</th>
            <th className="py-1 pr-2 text-left font-medium">{m.accuracy_actual()}</th>
            <th className="py-1 text-left font-medium">{m.accuracy_result()}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {AUDIT_FIELDS.map((field) => (
            <tr key={field}>
              <td className="py-1 pr-2 whitespace-nowrap">{fieldLabel(field)}</td>
              <td className="py-1 pr-2">
                <span className="grid gap-0.5">
                  {sources.map((sourceId) => {
                    const v = collected[sourceId]?.[field]
                    return (
                      <span key={sourceId} className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground">{sourceId}</span>
                        {v ? (
                          <>
                            <span className="font-mono" data-field={field}>
                              {collectedText(field, v)}
                            </span>
                            <TierTag tier={v.tier} />
                            <span className="text-muted-foreground">
                              {m.accuracy_collected_at({ time: formatTime(v.fetchedAt) })}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            {m.accuracy_not_collected()}
                          </span>
                        )}
                      </span>
                    )
                  })}
                </span>
              </td>
              <td className="py-1 pr-2">
                {field === 'available_quantity' ? (
                  <select
                    aria-label={fieldLabel(field)}
                    className="h-8 rounded-md border bg-background px-2"
                    disabled={readOnly}
                    value={draft[field]}
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  >
                    <option value="">{m.accuracy_available_unset()}</option>
                    <option value="yes">{m.accuracy_available_yes()}</option>
                    <option value="no">{m.accuracy_available_no()}</option>
                  </select>
                ) : (
                  <Input
                    aria-label={fieldLabel(field)}
                    className="h-8 w-32"
                    inputMode="decimal"
                    disabled={readOnly}
                    placeholder={field === 'bought_month' ? m.accuracy_bought_placeholder() : ''}
                    value={draft[field]}
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  />
                )}
              </td>
              <td className="py-1">
                <AgreementTags item={item} field={field} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={save}>
            {m.accuracy_save()}
          </Button>
          {saved && !error ? (
            <span className="text-xs text-muted-foreground">{m.accuracy_saved()}</span>
          ) : null}
          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** 来源 × 字段一致率表：低于 95% 标红，失去资格显示标签 */
export function AccuracyStatsTable({
  kpis,
  sourceLabel = (id) => id,
}: {
  kpis: AccuracyKpis
  sourceLabel?: (id: string) => string
}) {
  const columns: DataTableColumn<AccuracyKpis['stats'][number]>[] = [
    { id: 'source', header: m.accuracy_col_source(), cell: (s) => sourceLabel(s.sourceId) },
    { id: 'field', header: m.accuracy_field(), cell: (s) => fieldLabel(s.metric) },
    {
      id: 'rate',
      header: m.accuracy_col_rate(),
      cell: (s) => (
        <span
          className={s.belowTarget ? 'font-medium text-destructive' : ''}
          data-below={s.belowTarget}
        >
          {percent(s.rate)}
        </span>
      ),
    },
    {
      id: 'samples',
      header: m.accuracy_col_samples(),
      cell: (s) => `${s.agree} / ${s.samples}`,
    },
    {
      id: 'qualification',
      header: m.accuracy_col_qualification(),
      cell: (s) =>
        s.disqualified ? (
          <Tag tone="danger">{m.accuracy_disqualified()}</Tag>
        ) : s.belowTarget ? (
          <Tag tone="warning">
            {s.samples < 20 ? m.accuracy_insufficient() : m.accuracy_below_target()}
          </Tag>
        ) : (
          <Tag tone="success">{m.accuracy_qualified()}</Tag>
        ),
    },
  ]
  return (
    <DataTable
      label={m.accuracy_stats_title()}
      columns={columns}
      rows={kpis.stats}
      getRowId={(s) => `${s.sourceId}|${s.metric}`}
      page={{ pageIndex: 0, pageSize: Math.max(1, kpis.stats.length), rowCount: kpis.stats.length }}
      onPageChange={() => {}}
      labels={{ ...tableLabels(), empty: m.accuracy_stats_empty() }}
    />
  )
}

/** 数据中心「人工抽检」标签页（design D8）：本周清单逐项填写、提交，历史一致率 */
export function AccuracyAudit({
  slug,
  sourceLabel,
}: {
  slug: string
  sourceLabel?: (sourceId: string) => string
}) {
  const [auditId, setAuditId] = useState<string | undefined>()
  const [data, setData] = useState<AccuracyData | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(
    async (id?: string) => {
      setData(await getAccuracy({ data: { slug, ...(id ? { auditId: id } : {}) } }))
    },
    [slug],
  )
  useEffect(() => {
    load(auditId).catch((e) => setError(errorText(e)))
  }, [load, auditId])
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await load(auditId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (!data)
    return (
      <Section title={m.accuracy_tab()}>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">…</p>
        )}
      </Section>
    )
  const audit = data.audit
  const readOnly = audit?.status !== 'open'
  const checked = data.items.filter((i) => i.checkedAt).length
  const itemColumns: DataTableColumn<AuditItem>[] = [
    {
      id: 'product',
      header: m.accuracy_col_product(),
      className: 'align-top w-56',
      cell: (item) => (
        <span className="grid gap-1">
          <span className="font-mono text-xs">{item.platformId}</span>
          <span className="line-clamp-2 text-xs">{item.title ?? '—'}</span>
          <span className="text-xs text-muted-foreground">{item.marketplace}</span>
          {item.link ? (
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-primary underline"
            >
              {m.accuracy_open_page()}
            </a>
          ) : null}
        </span>
      ),
    },
    {
      id: 'check',
      header: m.accuracy_col_check(),
      cell: (item) => (
        <AuditItemForm
          key={`${item.id}-${item.checkedAt ?? ''}`}
          slug={slug}
          item={item}
          readOnly={readOnly}
          onSaved={() => load(auditId)}
        />
      ),
    },
    {
      id: 'status',
      header: m.accuracy_col_status(),
      className: 'align-top',
      cell: (item) =>
        item.checkedAt ? (
          <Tag tone="success">{m.accuracy_checked()}</Tag>
        ) : (
          <Tag tone="neutral">{m.accuracy_unchecked()}</Tag>
        ),
    },
  ]
  const historyColumns: DataTableColumn<HistoryRow>[] = [
    { id: 'week', header: m.accuracy_col_week(), cell: (a) => a.weekOf },
    {
      id: 'status',
      header: m.accuracy_col_status(),
      cell: (a) =>
        a.status === 'submitted' ? (
          <Tag tone="success">{m.accuracy_status_submitted()}</Tag>
        ) : (
          <Tag tone="info">{m.accuracy_status_open()}</Tag>
        ),
    },
    { id: 'sample', header: m.accuracy_col_sample(), cell: (a) => a.sampleSize },
    { id: 'checked', header: m.accuracy_col_checked(), cell: (a) => a.checked },
    {
      id: 'rate',
      header: m.accuracy_col_rate(),
      cell: (a) => (
        <span className={a.rate !== null && a.rate < 0.95 ? 'text-destructive' : ''}>
          {percent(a.rate)}
        </span>
      ),
    },
    {
      id: 'view',
      header: '',
      cell: (a) =>
        a.id === audit?.id ? null : (
          <Button size="sm" variant="ghost" onClick={() => setAuditId(a.id)}>
            {m.accuracy_history_view()}
          </Button>
        ),
    },
  ]
  return (
    <div className="grid gap-4">
      <Section
        title={m.accuracy_tab()}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{m.accuracy_generate_hint()}</span>
            <Button
              size="sm"
              disabled={busy || data.hasThisWeek}
              onClick={() =>
                run(async () => {
                  const r = await generateAccuracyAudit({ data: { slug } })
                  setAuditId(r.auditId)
                })
              }
            >
              {m.accuracy_generate_now()}
            </Button>
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">
          {m.accuracy_intro({ count: String(data.sampleSize) })}
        </p>
        <p className="text-xs text-muted-foreground">{m.accuracy_rules()}</p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {audit ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{m.accuracy_week({ week: audit.weekOf })}</span>
              <Tag tone={audit.status === 'submitted' ? 'success' : 'info'}>
                {audit.status === 'submitted'
                  ? m.accuracy_status_submitted()
                  : m.accuracy_status_open()}
              </Tag>
              <span className="text-xs text-muted-foreground">
                {m.accuracy_progress({
                  checked: String(checked),
                  total: String(data.items.length),
                })}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {m.accuracy_seed({ seed: audit.seed })}
              </span>
            </div>
            {audit.shortfall ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                {m.accuracy_shortfall({
                  available: String(audit.shortfall.available),
                  count: String(audit.sampleSize),
                })}
              </p>
            ) : null}
            <DataTable
              label={m.accuracy_checklist()}
              columns={itemColumns}
              rows={data.items}
              getRowId={(item) => item.id}
              page={{
                pageIndex: 0,
                pageSize: Math.max(1, data.items.length),
                rowCount: data.items.length,
              }}
              onPageChange={() => {}}
              labels={tableLabels()}
            />
            {audit.status === 'open' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={busy || checked === 0}
                  onClick={() =>
                    run(() => submitAccuracyAudit({ data: { slug, auditId: audit.id } }))
                  }
                >
                  {m.accuracy_submit()}
                </Button>
                <span className="text-xs text-muted-foreground">{m.accuracy_submit_hint()}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{m.accuracy_no_audit()}</p>
        )}
      </Section>
      <Section title={m.accuracy_stats_title()}>
        <AccuracyStatsTable kpis={data.kpis} {...(sourceLabel ? { sourceLabel } : {})} />
      </Section>
      <Section title={m.accuracy_history()}>
        <DataTable
          label={m.accuracy_history()}
          columns={historyColumns}
          rows={data.history}
          getRowId={(a) => a.id}
          page={{
            pageIndex: 0,
            pageSize: Math.max(1, data.history.length),
            rowCount: data.history.length,
          }}
          onPageChange={() => {}}
          labels={tableLabels()}
        />
      </Section>
    </div>
  )
}
