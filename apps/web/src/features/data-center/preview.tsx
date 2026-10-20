import { cn, SourceBadge } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getDataPreview } from './data-center.functions.ts'
import { ChannelTag, IntervalCell, TierTag } from './observation-cells.tsx'
import { errorText, formatTime, Section, SimpleTable } from './shared.tsx'

type Preview = Awaited<ReturnType<typeof getDataPreview>>
const VIEWS = [
  ['json', 'JSON'],
  ['table', '表格'],
  ['schema', 'Schema'],
  ['raw', '原始'],
] as const
const UNIT: Record<string, string> = {
  count: '件',
  money: '金额',
  rank: '排名',
  ratio: '比例',
  index: '指数',
  rate: '汇率',
}

export function DataPreview({
  slug,
  sources,
}: {
  slug: string
  sources: { id: string; label: string }[]
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('table')
  const [preview, setPreview] = useState<Preview | undefined>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!sourceId) return
    setPreview(undefined)
    getDataPreview({ data: { slug, sourceId } })
      .then(setPreview)
      .catch((e) => setError(errorText(e)))
  }, [slug, sourceId])
  if (sources.length === 0)
    return (
      <Section title="数据预览">
        <p className="text-sm text-muted-foreground">没有可预览的接口数据源。</p>
      </Section>
    )
  return (
    <Section
      title="数据预览"
      actions={
        <select
          aria-label="数据源"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      }
    >
      <div role="tablist" aria-label="预览视图" className="flex gap-1 border-b">
        {VIEWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm',
              view === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : preview === undefined ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : preview === null ? (
        <p className="text-sm text-muted-foreground">该数据源还没有可预览的同步数据。</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {formatTime(preview.fetchedAt)} · {preview.request.method} {preview.request.url} · HTTP{' '}
            {preview.status} · {preview.bytes} 字节
          </p>
          {view === 'json' ? (
            <pre className="max-h-[480px] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
              {preview.json ?? '响应不是 JSON'}
            </pre>
          ) : null}
          {view === 'raw' ? (
            <pre className="max-h-[480px] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {preview.raw}
            </pre>
          ) : null}
          {view === 'table' ? (
            <SimpleTable
              head={[
                '平台 ID',
                '站点',
                '指标',
                '日期',
                '数值',
                m.accuracy_interval(),
                m.accuracy_tier(),
                '获取方式',
              ]}
              empty={preview.rows.length === 0}
            >
              {preview.rows.map((row) => (
                <PreviewRow key={`${row.platformId}-${row.metric}-${row.observedOn}`} row={row} />
              ))}
            </SimpleTable>
          ) : null}
          {view === 'schema' ? (
            <SimpleTable
              head={['字段', '说明', '单位', '实体', '获取方式']}
              empty={preview.schema.length === 0}
            >
              {preview.schema.map((field) => (
                <tr key={field.name}>
                  <td className="px-3 py-2 font-mono">{field.name}</td>
                  <td className="px-3 py-2">{field.label}</td>
                  <td className="px-3 py-2">{UNIT[field.unit] ?? field.unit}</td>
                  <td className="px-3 py-2">{field.entity}</td>
                  <td className="px-3 py-2">
                    <SourceBadge method={field.method} />
                  </td>
                </tr>
              ))}
            </SimpleTable>
          ) : null}
        </>
      )}
    </Section>
  )
}

/** 观测预览的一行：区间列按 "100–200" / "10K+" 显示，层级列显示 T0–T4（design D8） */
export function PreviewRow({
  row,
}: {
  row: {
    platformId: string
    marketplace: string
    metric: string
    observedOn: string
    value: number
    currency: string | null
    method: 'official' | 'estimate' | 'derived' | 'import'
    tier: number
    valueLow: number | null
    valueHigh: number | null
    channel: string | null
  }
}) {
  return (
    <tr>
      <td className="px-3 py-2 font-mono">{row.platformId}</td>
      <td className="px-3 py-2">{row.marketplace}</td>
      <td className="px-3 py-2">{row.metric}</td>
      <td className="px-3 py-2">{row.observedOn}</td>
      <td className="px-3 py-2 font-mono">
        {row.value}
        {row.currency ? ` ${row.currency}` : ''}
      </td>
      <td className="px-3 py-2">
        <IntervalCell low={row.valueLow} high={row.valueHigh} />
      </td>
      <td className="px-3 py-2">
        <span className="flex flex-wrap gap-1">
          <TierTag tier={row.tier} />
          <ChannelTag channel={row.channel} />
        </span>
      </td>
      <td className="px-3 py-2">
        <SourceBadge method={row.method} />
      </td>
    </tr>
  )
}
