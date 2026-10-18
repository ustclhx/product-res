import { Button, Input, StatCard, Tag } from '@product-res/ui'
import { useState } from 'react'
import { probeDataSource, saveDataSource } from './data-center.functions.ts'
import {
  errorText,
  formatNumber,
  formatTime,
  KIND_LABELS,
  ProgressBar,
  RUN_STATUS,
  Section,
} from './shared.tsx'
import type { DataCenterData } from './types.ts'

const CREDENTIALS = {
  missing: { label: '未配置凭据', tone: 'neutral' },
  unverified: { label: '已配置未核验', tone: 'warning' },
  valid: { label: '核验通过', tone: 'success' },
  invalid: { label: '核验失败', tone: 'danger' },
} as const

const UNIT_LABEL: Record<string, string> = { call: '次', token: '令牌', 'usd-micro': '美元' }
const PERIOD_LABEL: Record<string, string> = { minute: '每分钟', day: '每日', month: '每月' }

function amount(unit: string, value: number) {
  return unit === 'usd-micro' ? `$${(value / 1_000_000).toFixed(2)}` : formatNumber(value)
}

export function Overview({
  slug,
  data,
  onChanged,
}: {
  slug: string
  data: DataCenterData
  onChanged: () => Promise<void>
}) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="已启用数据源"
          value={`${data.kpis.enabledSources} / ${data.kpis.totalSources}`}
        />
        <StatCard label="观测记录" value={formatNumber(data.kpis.records)} />
        <StatCard
          label="今日同步次数"
          value={formatNumber(data.kpis.runsToday)}
          hint="新加坡时间"
        />
        <StatCard label="有效导入批次" value={formatNumber(data.kpis.imports)} />
      </div>
      <Section title="数据源">
        {data.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有接入任何接口数据源。各数据源的连接器在接入阶段（add-source-connectors）加入；
            现在可以通过“文件导入”导入工具导出的数据。
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.sources.map((source) => (
              <SourceCard key={source.id} slug={slug} source={source} onChanged={onChanged} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function SourceCard({
  slug,
  source,
  onChanged,
}: {
  slug: string
  source: DataCenterData['sources'][number]
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [safetyLine, setSafetyLine] = useState(String(source.budget.safetyLine))
  const credentials = CREDENTIALS[source.credentials]
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const unit = UNIT_LABEL[source.budget.unit] ?? source.budget.unit
  return (
    <article className="grid gap-3 rounded-lg border p-4" data-testid={`source-${source.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="font-medium">{source.label}</h3>
          <p className="text-xs text-muted-foreground">
            {source.marketplaces.join(' · ')} · {source.access === 'api' ? '接口同步' : '文件导入'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Tag tone={source.enabled ? 'success' : 'neutral'}>
            {source.enabled ? '已启用' : '已停用'}
          </Tag>
          <Tag tone={credentials.tone}>{credentials.label}</Tag>
          {source.paused ? <Tag tone="danger">已暂停：{source.paused.reason}</Tag> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {source.capabilities.map((kind) => (
          <Tag key={kind} tone="info">
            {KIND_LABELS[kind] ?? kind}
          </Tag>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">记录数</dt>
          <dd className="font-medium">{formatNumber(source.records)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">最近同步</dt>
          <dd className="font-medium">
            {source.lastRun ? (
              <>
                {formatTime(source.lastRun.startedAt)} · {RUN_STATUS[source.lastRun.status]?.label}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <div className="grid gap-1 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>
            {PERIOD_LABEL[source.budget.period]}额度（{unit}）
          </span>
          <span data-testid="budget-usage">
            {amount(source.budget.unit, source.budget.used)} /{' '}
            {amount(source.budget.unit, source.budget.safetyLine)}
            （安全线）· 硬上限 {amount(source.budget.unit, source.budget.hardCap)}
          </span>
        </div>
        <ProgressBar
          value={source.budget.used}
          max={source.budget.safetyLine}
          warnAt={source.budget.safetyLine * 0.9}
        />
        <span className="text-muted-foreground">重置时间 {formatTime(source.budget.resetsAt)}</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button
          size="sm"
          variant={source.enabled ? 'outline' : 'default'}
          disabled={busy}
          onClick={() =>
            run(() =>
              saveDataSource({ data: { slug, sourceId: source.id, enabled: !source.enabled } }),
            )
          }
        >
          {source.enabled ? '停用' : '启用'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => probeDataSource({ data: { slug, sourceId: source.id } }))}
        >
          核验
        </Button>
        <label className="grid gap-1 text-xs" htmlFor={`safety-${source.id}`}>
          <span className="text-muted-foreground">安全线</span>
          <Input
            id={`safety-${source.id}`}
            className="h-8 w-28"
            inputMode="numeric"
            value={safetyLine}
            onChange={(e) => setSafetyLine(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !/^\d+$/.test(safetyLine)}
          onClick={() =>
            run(() =>
              saveDataSource({
                data: { slug, sourceId: source.id, safetyLine: Number(safetyLine) },
              }),
            )
          }
        >
          保存
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  )
}
