import { Button, Chart, cn, StatCard, Tag } from '@product-res/ui'
import { useEffect, useMemo, useState } from 'react'
import { formatTime, Section, SimpleTable } from '../data-center/shared.tsx'
import { marketplaceLabel } from '../follow/marketplaces.ts'
import {
  controlClass,
  EmptyState,
  ErrorText,
  Field,
  ReadOnlyNotice,
  useAction,
} from '../workbench/fields.tsx'
import {
  coldStartText,
  KIND_COLORS,
  KIND_LABELS,
  LEVEL_LABELS,
  LEVEL_TONES,
  pct,
  REPLAY_STATUS,
  replayErrorText,
  type SampleKindId,
  samples,
} from './labels.ts'
import {
  type getValidationPage,
  previewKeepaReplay,
  proposeWeightSuggestion,
  resolveWeightSuggestion,
  startKeepaReplay,
} from './validation.functions.ts'

export type ValidationData = Awaited<ReturnType<typeof getValidationPage>>
type Cell = ValidationData['readiness'][number]
type Month = ValidationData['monthly'][number]
type Suggestion = NonNullable<ValidationData['latestSuggestion']>

const KINDS: readonly SampleKindId[] = ['shadow', 'replay', 'import']

/**
 * 算法验证（design D6，tasks 4.1）：准备度矩阵、按月命中率、样本构成、待打标签、
 * 权重建议与 Keepa 回放。冷启动时只说明还需要积累多少样本，不画示例曲线。
 */
export function ValidationPage({
  slug,
  initial,
  reload,
}: {
  slug: string
  initial: ValidationData
  reload?: () => Promise<ValidationData>
}) {
  const [data, setData] = useState(initial)
  useEffect(() => setData(initial), [initial])
  const refresh = async () => {
    if (reload) setData(await reload())
  }
  const ready = data.readiness.filter((r) => r.level !== 'cold-start').length
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4" data-testid="validation-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">算法验证</h1>
          <p className="text-[13px] text-muted-foreground">
            每日冻结影子推荐，T+14 / T+30 / T+60 到期自动打标签；按 平台 × 方向 × 信号类型
            统计命中率 Wilson 下界并与同方向随机新品基线比较，得出算法准备度。
          </p>
        </div>
        <span className="text-xs text-muted-foreground">统计日 {data.asOf}（新加坡时间）</span>
      </div>

      {data.coldStart.allColdStart ? <ColdStartNotice data={data} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="已冻结推荐"
          value={<span className="font-mono">{sum(data.composition.recommendations)}</span>}
          hint={kindHint(data.composition.recommendations)}
        />
        <StatCard
          label="T+30 已打标签"
          value={<span className="font-mono">{sum(data.composition.labeled)}</span>}
          hint={`数据不足 ${sum(data.composition.insufficient)} 条（不计入命中率分母）`}
        />
        <StatCard
          label="到期待打标签"
          value={
            <span className="font-mono" data-testid="pending-total">
              {data.pendingLabels.total}
            </span>
          }
          hint={`T+14 ${data.pendingLabels.byWindow['14']} · T+30 ${data.pendingLabels.byWindow['30']} · T+60 ${data.pendingLabels.byWindow['60']}`}
        />
        <StatCard
          label="已过冷启动的组合"
          value={
            <span className="font-mono">
              {ready}
              <span className="text-sm font-normal text-muted-foreground">
                {' '}
                / {data.readiness.length}
              </span>
            </span>
          }
          hint="组合 = 平台站点 × 方向 × 信号类型"
        />
      </div>

      <ReadinessMatrix data={data} />

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="grid min-w-0 xl:col-span-2">
          <Section
            title="按月命中率（T+30）"
            actions={
              <span className="text-xs text-muted-foreground">按打标签月份 · 最近 12 个月</span>
            }
          >
            <HitRateChart months={data.monthly} />
          </Section>
        </div>
        <Composition data={data} />
      </div>

      <SuggestionCard slug={slug} data={data} onChange={refresh} />
      <ReplayPanel slug={slug} data={data} onChange={refresh} />
    </div>
  )
}

const sum = (counts: Readonly<Record<SampleKindId, number>>) =>
  counts.shadow + counts.replay + counts.import

const kindHint = (counts: Readonly<Record<SampleKindId, number>>) =>
  KINDS.map((k) => `${KIND_LABELS[k]} ${counts[k]}`).join(' · ')

function ColdStartNotice({ data }: { data: ValidationData }) {
  const text = coldStartText({ observation: data.thresholds.observation, ...data.coldStart })
  const best = data.thresholds.observation - data.coldStart.samplesNeeded
  return (
    <section
      data-testid="cold-start"
      className="grid gap-3 rounded-xl border border-primary/30 bg-primary-soft/60 p-4 md:grid-cols-[1fr_auto] md:items-center"
    >
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Tag tone="neutral">冷启动</Tag>
          <h2 className="text-sm font-semibold">所有组合仍在冷启动，算法尚未经过验证</h2>
        </div>
        <p className="text-[13px] text-foreground/80">{text.need}</p>
        <p className="text-[13px] text-foreground/80" data-testid="cold-start-eta">
          {text.eta}
        </p>
        <p className="text-xs text-muted-foreground">
          冷启动期间候选列表只展示信号，等级显示为“未验证”；命中率曲线在有真实标签后才绘制。
        </p>
      </div>
      <div className="grid min-w-[220px] gap-1.5 rounded-lg bg-card p-3 shadow-xs">
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>距观察期</span>
          <span className="font-mono text-foreground">
            {samples(Math.max(0, best))} / {data.thresholds.observation}
          </span>
        </div>
        <Meter value={Math.max(0, best)} max={data.thresholds.observation} />
        <div className="text-xs text-muted-foreground">
          预计{' '}
          <span className="font-mono text-base font-semibold text-foreground">
            {data.coldStart.estimatedDays ?? '—'}
          </span>{' '}
          天
        </div>
      </div>
    </section>
  )
}

function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  const p = max <= 0 ? 0 : Math.min(100, (value / max) * 100)
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${p}%` }} />
    </div>
  )
}

/** 准备度矩阵：行 = 站点 × 方向，列 = 信号类型（主导维度） */
function ReadinessMatrix({ data }: { data: ValidationData }) {
  const rows = useMemo(() => {
    const map = new Map<
      string,
      { marketplace: string; directionName: string; cells: Map<string, Cell> }
    >()
    for (const cell of data.readiness) {
      const key = `${cell.marketplace}|${cell.directionId}`
      const row = map.get(key) ?? {
        marketplace: cell.marketplace,
        directionName: cell.directionName,
        cells: new Map<string, Cell>(),
      }
      row.cells.set(cell.signalType, cell)
      map.set(key, row)
    }
    return [...map.entries()]
  }, [data.readiness])
  return (
    <Section
      title="算法准备度矩阵"
      actions={
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {(['cold-start', 'observation', 'usable', 'trusted'] as const).map((l) => (
            <Tag key={l} tone={LEVEL_TONES[l]}>
              {LEVEL_LABELS[l]}
            </Tag>
          ))}
          <span className="ml-1">
            {`< ${data.thresholds.observation} · ${data.thresholds.observation}–${data.thresholds.usable} · ≥ ${data.thresholds.usable} 且下界 ≥ 基线 · ≥ ${data.thresholds.trusted} 且已校准、稳定`}
          </span>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="还没有准备度统计">
          每周一 05:30 按已打标签的样本重算；有了第一批 T+30 标签后这里按组合显示等级。
        </EmptyState>
      ) : (
        <div className="overflow-x-auto" data-testid="readiness-matrix">
          <table className="w-full min-w-[1080px] border-separate border-spacing-0 text-left text-[13px]">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-10 bg-muted px-3 py-2 font-medium">站点 · 方向</th>
                {data.dimensions.map((d) => (
                  <th key={d.id} className="bg-muted px-3 py-2 font-medium whitespace-nowrap">
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, row]) => (
                <tr key={key}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b bg-card px-3 py-2 text-left align-top font-normal"
                  >
                    <div className="font-medium">{row.directionName}</div>
                    <div className="text-xs text-muted-foreground">
                      {marketplaceLabel(row.marketplace)}
                    </div>
                  </th>
                  {data.dimensions.map((d) => {
                    const cell = row.cells.get(d.id)
                    return (
                      <td key={d.id} className="border-b px-3 py-2 align-top">
                        {cell ? (
                          <MatrixCell cell={cell} />
                        ) : (
                          <span className="text-xs text-muted-foreground">无样本</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function MatrixCell({ cell }: { cell: Cell }) {
  const below =
    cell.wilsonLower !== null && cell.baseline !== null && cell.wilsonLower < cell.baseline
  return (
    <div className="grid min-w-[128px] gap-1" data-testid="readiness-cell" data-level={cell.level}>
      <Tag tone={LEVEL_TONES[cell.level]} className="w-fit">
        {LEVEL_LABELS[cell.level]}
      </Tag>
      <div className="text-xs">
        有效 <span className="font-mono font-medium">{samples(cell.effectiveSamples)}</span>
        <span className="text-muted-foreground"> · 命中 {cell.hitCount}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        下界{' '}
        <span className={cn('font-mono', below ? 'text-destructive' : 'text-foreground')}>
          {pct(cell.wilsonLower)}
        </span>{' '}
        / 基线{' '}
        <span className="font-mono text-foreground">
          {cell.baseline === null ? '未知' : pct(cell.baseline)}
        </span>
      </div>
      {cell.samplesToObservation > 0 ? (
        <div className="text-xs text-warning-strong">
          还差 {samples(cell.samplesToObservation)} 进入观察期
        </div>
      ) : null}
      {cell.samples.replay > 0 || cell.samples.import > 0 ? (
        <div className="text-[11px] text-muted-foreground">
          影子 {cell.samples.shadow} · 回放 {cell.samples.replay}
          {cell.samples.import > 0 ? ` · 导入 ${cell.samples.import}` : ''}
        </div>
      ) : null}
    </div>
  )
}

const AXIS = {
  axisLine: { lineStyle: { color: '#f0f0f0' } },
  axisTick: { show: false },
  axisLabel: { color: '#8c8c8c', fontSize: 11 },
  splitLine: { lineStyle: { color: '#f0f0f0', type: 'dashed' as const } },
}

/** 每月命中率：总体（加权）一条，各样本类型各一条；无样本的月份断开，不补 0 */
function HitRateChart({ months }: { months: readonly Month[] }) {
  const empty = months.every((m) => m.effectiveSamples === 0)
  const kinds = KINDS.filter((k) => months.some((m) => m.byKind[k].labeled > 0))
  const option = useMemo(() => {
    const rate = (h: { hits: number; labeled: number }) =>
      h.labeled > 0 ? Math.round((h.hits / h.labeled) * 1000) / 10 : null
    return {
      grid: { left: 40, right: 16, top: 36, bottom: 24 },
      legend: {
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 4,
        textStyle: { color: '#595959', fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#fff',
        borderColor: '#f0f0f0',
        textStyle: { color: '#262626', fontSize: 12 },
        extraCssText: 'box-shadow:0 6px 16px rgba(0,0,0,.08);border-radius:8px;',
        formatter: (items: { dataIndex: number }[]) => {
          const m = months[items[0]?.dataIndex ?? 0]
          if (!m) return ''
          const lines = [
            `<b>${m.month}</b>`,
            `加权命中率 ${m.hitRate === null ? '无样本' : pct(m.hitRate)}（有效样本 ${samples(m.effectiveSamples)}）`,
            ...kinds.map((k) => {
              const b = m.byKind[k]
              return `<span style="color:${KIND_COLORS[k]}">●</span> ${KIND_LABELS[k]} ${b.hits} / ${b.labeled}`
            }),
          ]
          return lines.join('<br/>')
        },
      },
      xAxis: {
        type: 'category',
        data: months.map((m) => m.month),
        boundaryGap: false,
        ...AXIS,
        splitLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: (v: string) => `${Number(v.slice(5))}月` },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        ...AXIS,
        axisLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: '{value}%' },
      },
      series: [
        {
          name: '加权总体',
          type: 'line',
          color: '#262626',
          lineStyle: { width: 2 },
          symbolSize: 8,
          data: months.map((m) => (m.hitRate === null ? null : Math.round(m.hitRate * 1000) / 10)),
        },
        ...kinds.map((k) => ({
          name: KIND_LABELS[k],
          type: 'line',
          color: KIND_COLORS[k],
          lineStyle: { width: 2, type: k === 'shadow' ? 'solid' : 'dashed' },
          symbolSize: 8,
          data: months.map((m) => rate(m.byKind[k])),
        })),
      ],
    }
  }, [months, kinds])
  return (
    <div className="grid gap-2">
      <Chart option={option} empty={empty} height={260} aria-label="按月命中率曲线" />
      {empty ? (
        <p className="text-xs text-muted-foreground">
          还没有 T+30 标签，曲线在第一批样本到期后出现。
        </p>
      ) : (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">表格视图</summary>
          <SimpleTable
            head={['月份', '有效样本', '加权命中率', ...kinds.map((k) => KIND_LABELS[k])]}
          >
            {months
              .filter((m) => m.effectiveSamples > 0)
              .map((m) => (
                <tr key={m.month}>
                  <td className="px-3 py-1.5 font-mono">{m.month}</td>
                  <td className="px-3 py-1.5 font-mono">{samples(m.effectiveSamples)}</td>
                  <td className="px-3 py-1.5 font-mono">{pct(m.hitRate)}</td>
                  {kinds.map((k) => (
                    <td key={k} className="px-3 py-1.5 font-mono">
                      {m.byKind[k].hits} / {m.byKind[k].labeled}
                    </td>
                  ))}
                </tr>
              ))}
          </SimpleTable>
        </details>
      )}
    </div>
  )
}

function Composition({ data }: { data: ValidationData }) {
  const { composition: c, pendingLabels: p } = data
  const max = Math.max(1, ...KINDS.map((k) => c.recommendations[k]))
  return (
    <Section title="样本构成">
      <div className="grid gap-3" data-testid="composition">
        {KINDS.map((k) => {
          const total = c.recommendations[k]
          return (
            <div key={k} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: KIND_COLORS[k] }} />
                  {KIND_LABELS[k]}
                  {k === 'replay' ? (
                    <span className="text-xs text-muted-foreground">权重 0.5</span>
                  ) : null}
                  {k === 'import' ? (
                    <span className="text-xs text-muted-foreground">Terapeak 暂缓</span>
                  ) : null}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  冻结 <b className="text-foreground">{total}</b> · 已标 {c.labeled[k]} · 不足{' '}
                  {c.insufficient[k]}
                </span>
              </div>
              {/* 冻结总量为底，已打标签与数据不足叠在上面 */}
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  style={{ width: `${(c.labeled[k] / max) * 100}%`, background: KIND_COLORS[k] }}
                />
                <div
                  className="bg-warning"
                  style={{ width: `${(c.insufficient[k] / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          <span>彩色 = T+30 已打标签</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-warning" />
            数据不足
          </span>
          <span>灰底 = 尚未到期</span>
        </div>
        <div className="grid gap-1.5 border-t pt-3">
          <div className="text-xs font-medium text-muted-foreground">
            已到期待打标签 · 每天 05:00 自动处理
          </div>
          <div className="grid grid-cols-3 gap-2" data-testid="pending-labels">
            {(['14', '30', '60'] as const).map((w) => (
              <div key={w} className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">T+{w}</div>
                <div className="font-mono text-lg font-semibold">{p.byWindow[w]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  )
}

function SuggestionCard({
  slug,
  data,
  onChange,
}: {
  slug: string
  data: ValidationData
  onChange: () => Promise<void>
}) {
  const s = data.latestSuggestion
  const [reason, setReason] = useState('')
  const { busy, error, run } = useAction(onChange)
  const propose = () =>
    run(async () => {
      setReason('')
      const result = await proposeWeightSuggestion({ data: { slug } })
      if (!result.ok) setReason(`暂不能生成建议：${result.reason}`)
    })
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          权重拟合建议
          {s ? <SuggestionStatus s={s} /> : null}
        </span>
      }
      actions={
        data.canWrite ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={propose}>
            生成建议
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        有效样本 ≥ {data.thresholds.fitMinSamples} 时，用 T+30 标签与冻结时的 7 维分数做 L2
        逻辑回归、分层 5 折交叉验证；只有点“采用”才生成新的评分设置版本。
      </p>
      {reason ? (
        <p
          role="status"
          data-testid="propose-reason"
          className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-strong"
        >
          {reason}
        </p>
      ) : null}
      <ErrorText>{error}</ErrorText>
      {s ? (
        <SuggestionBody slug={slug} s={s} data={data} onChange={onChange} />
      ) : (
        <EmptyState title="还没有权重建议">
          样本达到下限后点“生成建议”；样本不足时会说明还差什么。
        </EmptyState>
      )}
    </Section>
  )
}

function SuggestionStatus({ s }: { s: Suggestion }) {
  if (s.status === 'proposed') return <Tag tone="info">待确认</Tag>
  if (s.status === 'accepted')
    return <Tag tone="success">已采用{s.acceptedVersion ? ` · 版本 ${s.acceptedVersion}` : ''}</Tag>
  return <Tag tone="neutral">已忽略</Tag>
}

function SuggestionBody({
  slug,
  s,
  data,
  onChange,
}: {
  slug: string
  s: Suggestion
  data: ValidationData
  onChange: () => Promise<void>
}) {
  const { busy, error, run } = useAction(onChange)
  const totalCurrent = Object.values(s.currentWeights).reduce((a, b) => a + b, 0) || 1
  const totalSuggested = Object.values(s.suggestedWeights).reduce((a, b) => a + b, 0) || 1
  const maxShare = Math.max(
    ...data.dimensions.flatMap((d) => [
      (s.currentWeights[d.id] ?? 0) / totalCurrent,
      (s.suggestedWeights[d.id] ?? 0) / totalSuggested,
    ]),
    0.01,
  )
  const resolve = (decision: 'accept' | 'dismiss') =>
    run(() => resolveWeightSuggestion({ data: { slug, id: s.id, decision } }))
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]" data-testid="suggestion">
      <SimpleTable
        head={['维度', '当前权重', '建议权重', '占比对比（灰 = 当前，蓝 = 建议）', '变化']}
      >
        {data.dimensions.map((d) => {
          const cur = s.currentWeights[d.id] ?? 0
          const sug = s.suggestedWeights[d.id] ?? 0
          const delta = sug / totalSuggested - cur / totalCurrent
          return (
            <tr key={d.id}>
              <td className="px-3 py-2">{d.label}</td>
              <td className="px-3 py-2 font-mono">{cur.toFixed(2)}</td>
              <td className="px-3 py-2 font-mono font-medium">{sug.toFixed(2)}</td>
              <td className="px-3 py-2">
                <div className="grid w-44 gap-0.5">
                  <div
                    className="h-1.5 rounded-full bg-muted-foreground/30"
                    style={{ width: `${(cur / totalCurrent / maxShare) * 100}%` }}
                  />
                  <div
                    className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${(sug / totalSuggested / maxShare) * 100}%` }}
                  />
                </div>
              </td>
              <td
                className={cn(
                  'px-3 py-2 font-mono text-xs',
                  Math.abs(delta) < 0.005
                    ? 'text-muted-foreground'
                    : delta > 0
                      ? 'text-success-strong'
                      : 'text-destructive',
                )}
              >
                {Math.abs(delta) < 0.005
                  ? '—'
                  : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)} pt`}
              </td>
            </tr>
          )
        })}
      </SimpleTable>
      <div className="grid content-start gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Metric
            label="交叉验证 AUC"
            value={fixed(s.crossValidation?.auc)}
            base={fixed(s.current?.auc)}
          />
          <Metric label="提升度" value={pt(s.crossValidation?.lift)} base={pt(s.current?.lift)} />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          括号内为当前权重在同一批样本上的值。提升度 = 预测概率前 20% 的命中率 − 总体命中率。 拟合于{' '}
          {formatTime(s.fittedAt)}，有效样本 {s.sampleCount}，基于评分设置版本{' '}
          {s.baseVersion ?? '—'}。
        </p>
        {s.status === 'proposed' && data.canWrite ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => resolve('accept')}>
              采用并生成新版本
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve('dismiss')}>
              忽略
            </Button>
          </div>
        ) : null}
        {s.status === 'accepted' ? (
          <p className="text-xs text-success-strong">
            已于 {formatTime(s.resolvedAt)} 采用，生成评分设置版本 {s.acceptedVersion ?? '—'}
            ，从下一次计算起生效。
          </p>
        ) : null}
        {s.status === 'dismissed' ? (
          <p className="text-xs text-muted-foreground">
            已于 {formatTime(s.resolvedAt)} 忽略，评分设置未改变。
          </p>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  )
}

const fixed = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(3))
const pt = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pt`

function Metric({ label, value, base }: { label: string; value: string; base: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-lg font-semibold leading-tight">{value}</div>
      <div className="font-mono text-[11px] text-muted-foreground">（{base}）</div>
    </div>
  )
}

type Preview = Awaited<ReturnType<typeof previewKeepaReplay>>

function ReplayPanel({
  slug,
  data,
  onChange,
}: {
  slug: string
  data: ValidationData
  onChange: () => Promise<void>
}) {
  const [directionId, setDirectionId] = useState(data.amazonDirections[0]?.id ?? '')
  const [nodeDate, setNodeDate] = useState('')
  const [beforeDays, setBeforeDays] = useState('30')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [notice, setNotice] = useState('')
  const { busy, error, run } = useAction(onChange)

  useEffect(() => {
    setPreview(null)
    setPreviewError('')
    if (!directionId) return
    let stale = false
    previewKeepaReplay({ data: { slug, directionId } })
      .then((p) => !stale && setPreview(p))
      .catch((e: unknown) => !stale && setPreviewError(e instanceof Error ? e.message : '预估失败'))
    return () => {
      stale = true
    }
  }, [slug, directionId])

  const submit = () =>
    run(async () => {
      setNotice('')
      const r = await startKeepaReplay({
        data: { slug, directionId, nodeDate, beforeDays: Number(beforeDays) },
      })
      setNotice(
        `已排队：冻结日 ${r.frozenOn}，${r.products} 个商品、约 ${r.estimatedTokens} Keepa token；额度不足时自动顺延。`,
      )
    })
  const names = new Map(data.amazonDirections.map((d) => [d.id, d.name]))

  return (
    <Section
      title="Keepa 历史回放"
      actions={
        <span className="text-xs text-muted-foreground">
          只适用于 Amazon 方向 · 回放样本权重 0.5
        </span>
      }
    >
      <p className="text-xs text-muted-foreground">
        用节点前 T 日为止的 Keepa 价格、BSR、卖家数与销量估算重算当时的分数，冻结为回放样本，
        再按之后的序列打 T+14 / T+30 / T+60 标签。Keepa 调用经额度账本预扣，超出时顺延，不超额。
      </p>
      <ReadOnlyNotice show={!data.canWrite} />
      {data.canWrite && !data.replayQueueAvailable ? (
        <p
          data-testid="replay-unavailable"
          className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
        >
          当前部署没有启用回放队列（目前只有自托管 Node
          部署装配），可以查看预估与已有任务，暂不能发起新的回放。
        </p>
      ) : null}
      {data.amazonDirections.length === 0 ? (
        <EmptyState title="没有包含 Amazon 站点的方向">
          在“选品方向与店铺池”中为方向添加 Amazon 站点后可回放。
        </EmptyState>
      ) : data.canWrite ? (
        <form
          aria-label="发起回放"
          className="grid gap-3 rounded-lg border bg-muted/30 p-3 md:grid-cols-[1.4fr_1fr_0.8fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Amazon 方向">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={directionId}
                onChange={(e) => setDirectionId(e.target.value)}
              >
                {data.amazonDirections.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}（{d.marketplaces.map(marketplaceLabel).join('、')}）
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="历史节点日期">
            {(id) => (
              <input
                id={id}
                type="date"
                required
                className={controlClass}
                value={nodeDate}
                max={data.asOf}
                onChange={(e) => setNodeDate(e.target.value)}
              />
            )}
          </Field>
          <Field label="提前天数 T">
            {(id) => (
              <input
                id={id}
                type="number"
                min={1}
                max={365}
                required
                className={controlClass}
                value={beforeDays}
                onChange={(e) => setBeforeDays(e.target.value)}
              />
            )}
          </Field>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !directionId || !data.replayQueueAvailable}
          >
            发起回放
          </Button>
          <div className="text-xs md:col-span-4" data-testid="replay-preview">
            {previewError ? (
              <span className="text-destructive">{previewError}</span>
            ) : preview ? (
              <span className="text-muted-foreground">
                预计 <b className="font-mono text-foreground">{preview.products}</b> 个商品（
                {preview.clusters} 个簇）· 约{' '}
                <b className="font-mono text-foreground">{preview.estimatedTokens}</b> Keepa token
                {preview.products === 0 ? '；方向下还没有 Amazon 簇成员，暂时无法回放' : ''}
              </span>
            ) : (
              <span className="text-muted-foreground">正在预估…</span>
            )}
          </div>
        </form>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-success-strong">
          {notice}
        </p>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <SimpleTable
        head={[
          '方向',
          '节点 / 提前',
          '冻结日',
          '状态',
          '商品（已取 / 计划）',
          '预估 token',
          '回放推荐',
          '发起时间',
        ]}
        empty={data.replays.length === 0}
      >
        {data.replays.map((r) => {
          const status = REPLAY_STATUS[r.status]
          const err = replayErrorText(r.errorCode)
          return (
            <tr key={r.replayId} data-testid="replay-row" data-status={r.status}>
              <td className="px-3 py-2">{names.get(r.directionId) ?? r.directionName}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {r.nodeDate} · T−{r.beforeDays}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{r.frozenOn}</td>
              <td className="px-3 py-2">
                <div className="grid justify-items-start gap-0.5">
                  <Tag tone={status.tone}>{status.label}</Tag>
                  {err ? (
                    <span
                      className={cn(
                        'text-xs',
                        r.status === 'failed' ? 'text-destructive' : 'text-warning-strong',
                      )}
                      title={r.errorCode ?? undefined}
                    >
                      {err}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="grid w-28 gap-1">
                  <span className="font-mono text-xs">
                    {r.fetchedProducts} / {r.products}
                  </span>
                  <Meter value={r.fetchedProducts} max={r.products} />
                </div>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{r.estimatedTokens}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {r.status === 'succeeded' ? r.recommendations : '—'}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{formatTime(r.startedAt)}</td>
            </tr>
          )
        })}
      </SimpleTable>
    </Section>
  )
}
