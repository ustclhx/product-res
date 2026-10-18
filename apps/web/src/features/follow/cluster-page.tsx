import {
  Button,
  Chart,
  ConfidenceBar,
  cn,
  GradeTag,
  RiskCard,
  type RiskLevel,
  SourceBadge,
  Tag,
} from '@product-res/ui'
import { Link, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { CostingTab } from '../costing/costing-tab.tsx'
import { formatTime, Section } from '../data-center/shared.tsx'
import { controlClass, EmptyState, ErrorText, useAction } from '../workbench/fields.tsx'
import {
  estimateMemberRefresh,
  mergeCluster,
  refreshMemberData,
  splitMember,
} from './candidates.functions.ts'
import type { ClusterDetailData } from './candidates.server.ts'
import {
  dispersionText,
  formatInt,
  formatMetric,
  type MetricSourcesView,
  ProductThumb,
  SourceHover,
} from './follow-ui.tsx'

const ATTENTION_LABEL = '值得关注但证据不足'
/** 核算标签旁的线索状态提示 */
const COSTING_STATUS_TEXT: Record<string, string> = {
  costing: '核算中',
  pending: '待决定',
  followed: '已跟卖',
  dropped: '已放弃',
}
const GRADE_TEXT = { recommend: '推荐', caution: '谨慎', reject: '不推荐', unverified: '未验证' }
const METHOD_LABELS: Record<string, string> = {
  gtin: 'GTIN',
  'platform-id': '平台 ID',
  title: '标题相似',
  manual: '手动',
}

type Detail = ClusterDetailData
type Dimension = Detail['dimensions'][number]

function Card({
  title,
  extra,
  children,
  className,
  testId,
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <section
      data-testid={testId}
      className={cn('flex min-w-0 flex-col rounded-xl border bg-card', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {extra}
      </div>
      <div className="grid gap-3 p-4">{children}</div>
    </section>
  )
}

const effective = (d: Dimension) =>
  d.score === null ? null : Math.round(d.reversed ? 100 - d.score : d.score)

function barColor(value: number) {
  if (value >= 75) return 'bg-success'
  if (value >= 50) return 'bg-primary'
  return 'bg-warning'
}

/**
 * 7 维雷达：按对综合分的贡献绘制（反向维度取 100 − 分数）。ECharts 雷达会把缺失点画到圆心，
 * 等同于 0，所以只用已计算的维度作坐标轴；缺失维度在图下方单独标“无数据”。
 */
function radarOption(dimensions: readonly Dimension[]) {
  const present = dimensions.filter((d) => d.score !== null)
  return {
    tooltip: {
      trigger: 'item',
      formatter: () =>
        dimensions
          .map(
            (d) =>
              `${d.label}：${d.score === null ? '无数据' : `${Math.round(d.score)}${d.reversed ? `（反向，贡献 ${effective(d)}）` : ''}`}`,
          )
          .join('<br/>'),
    },
    radar: {
      radius: '64%',
      center: ['50%', '54%'],
      splitNumber: 4,
      indicator: present.map((d) => ({ name: d.label, max: 100, color: '#595959' })),
      axisName: { fontSize: 11 },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: '#e8e8e8' } },
    },
    series: [
      {
        type: 'radar',
        symbolSize: 5,
        lineStyle: { width: 2 },
        areaStyle: { color: 'rgba(22,119,255,0.15)' },
        data: [{ name: '维度贡献', value: present.map((d) => effective(d) as number) }],
      },
    ],
  }
}

function lineOption(
  series: ReadonlyArray<{ name: string; points: ReadonlyArray<readonly [string, number]> }>,
  money: boolean,
) {
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => (money ? `$${v}` : `${v}`) },
    legend: { top: 0, type: 'scroll', textStyle: { fontSize: 11 } },
    grid: { left: 44, right: 16, top: 32, bottom: 28 },
    xAxis: {
      type: 'time',
      axisLabel: { fontSize: 11, color: '#8c8c8c', formatter: '{MM}-{dd}', hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { fontSize: 11, color: '#8c8c8c' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      showSymbol: false,
      smooth: true,
      data: s.points.map(([d, v]) => [d, v]),
    })),
  }
}

const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`)

/** 季节曲线：每年一条 1–12 月趋势线叠加，节点销售窗口用阴影标出 */
function seasonOption(season: NonNullable<Detail['season']>) {
  const areas = season.windows.map((w) => {
    const start = Date.UTC(2001, w.startMonth - 1, w.startDay)
    const endMonth = new Date(start + (w.salesDays - 1) * 86_400_000).getUTCMonth()
    return [{ name: w.name, xAxis: MONTHS[w.startMonth - 1] }, { xAxis: MONTHS[endMonth] }]
  })
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    grid: { left: 40, right: 16, top: 32, bottom: 28 },
    xAxis: {
      type: 'category',
      data: MONTHS,
      boundaryGap: false,
      axisLabel: { fontSize: 11, color: '#8c8c8c' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 11, color: '#8c8c8c' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: season.years.map((y, i) => ({
      name: String(y.year),
      type: 'line',
      smooth: true,
      connectNulls: false,
      showSymbol: false,
      // 越近的年份越醒目
      lineStyle: { width: i === season.years.length - 1 ? 2.5 : 1.5 },
      data: y.months.map((v) => v ?? '-'),
      ...(i === season.years.length - 1
        ? {
            markArea: {
              silent: true,
              itemStyle: { color: 'rgba(250,173,20,0.12)' },
              label: { color: '#d48806', fontSize: 11, position: 'insideTop' },
              data: areas,
            },
          }
        : {}),
    })),
  }
}

function MetricStat({
  label,
  view,
  testId,
}: {
  label: string
  view: MetricSourcesView | null
  testId: string
}) {
  const primary = view?.values.find((v) => v.sourceId === view.primarySourceId)
  return (
    <div className="grid justify-items-end gap-0.5 text-right" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {view && primary ? (
        <SourceHover view={view}>
          <span className="font-mono text-xl font-bold leading-tight">
            {formatMetric(view.metric, primary.value, primary.currency)}
          </span>
        </SourceHover>
      ) : (
        <span className="text-xl font-bold leading-tight text-muted-foreground">—</span>
      )}
      {view ? (
        <span className="text-[11px] text-muted-foreground">
          {view.values.length > 1 ? `${view.values.length} 个来源` : '未交叉验证'}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">无数据</span>
      )}
    </div>
  )
}

/** 商品簇详情（specs/follow-candidates「商品簇详情」，对照设计稿“评分详情页”） */
export function ClusterPage({
  slug,
  data,
  tab = 'overview',
}: {
  slug: string
  data: Detail
  tab?: 'overview' | 'costing'
}) {
  const router = useRouter()
  const reload = () => router.invalidate()
  const { cluster: c, lead } = data
  const scored = data.dimensions.filter((d) => d.score !== null).length

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <nav className="text-xs text-muted-foreground">
        <Link
          to="/app/$slug/follow"
          params={{ slug }}
          search={{ platform: c.platform }}
          className="hover:text-primary"
        >
          跟卖选品
        </Link>
        <span className="px-1">/</span>
        <span>商品簇详情</span>
      </nav>

      {c.status !== 'active' ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-strong">
          该商品簇已{c.status === 'merged' ? '合并' : '归档'}，仅供查看历史。
          {c.mergedIntoId ? (
            <Link
              to="/app/$slug/follow/$clusterId"
              params={{ slug, clusterId: c.mergedIntoId }}
              className="ml-1 text-primary hover:underline"
            >
              查看合并后的商品簇 →
            </Link>
          ) : null}
        </p>
      ) : null}

      {/* 商品头部 */}
      <section className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
        <ProductThumb src={c.imageUrl} title={c.name} size={64} />
        <div className="grid min-w-[240px] flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold leading-snug">{c.name}</h1>
            {lead ? <GradeTag score={null} readiness={lead.readiness} grade={lead.grade} /> : null}
            {lead?.attention ? <Tag tone="warning">{ATTENTION_LABEL}</Tag> : null}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {c.platformId ? (
              <span>
                {c.platform === 'amazon' ? 'ASIN' : 'Item'}: {c.platformId}
              </span>
            ) : null}
            <span>{c.marketplaceLabel}</span>
            <span>方向：{c.directionName}</span>
            {c.categoryId ? <span>类目 {c.categoryId}</span> : null}
            <span>{data.members.length} 个成员</span>
            {lead ? <span>线索日期 {lead.leadOn}</span> : null}
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer" className="text-primary">
                平台页面 ↗
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
          <MetricStat label="售价" view={data.headline.price} testId="stat-price" />
          <MetricStat
            label={data.series.sales.label.replace(/（.*）/, '')}
            view={data.headline.sales}
            testId="stat-sales"
          />
          {c.platform === 'amazon' ? (
            <MetricStat label="BSR" view={data.headline.bsr} testId="stat-bsr" />
          ) : null}
        </div>
      </section>

      <div role="tablist" aria-label="商品簇详情" className="flex gap-1 border-b">
        {(
          [
            ['overview', '概览'],
            ['costing', '核算'],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            to="/app/$slug/follow/$clusterId"
            params={{ slug, clusterId: c.id }}
            search={key === 'costing' ? { tab: 'costing' } : {}}
            role="tab"
            aria-selected={tab === key}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {key === 'costing' && lead ? (
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                {COSTING_STATUS_TEXT[lead.status] ?? ''}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {tab === 'costing' ? (
        <CostingTab slug={slug} clusterId={c.id} leadId={lead?.id ?? null} onLeadChanged={reload} />
      ) : (
        <>
          {lead && lead.gateReasons.length > 0 ? (
            <p
              role="status"
              className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-[13px] text-destructive"
            >
              不推荐：{lead.gateReasons.join('；')}
            </p>
          ) : null}
          {!lead ? (
            <p className="rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground">
              每日流水线还没有为该商品簇生成线索，评分与置信度会在下次运行后出现。
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
            {/* 左：7 维评分卡 */}
            <Card
              title="7 维评分卡"
              testId="score-card"
              extra={
                lead ? (
                  <span className="text-xs text-muted-foreground">
                    评分设置 v{lead.settingVersion}
                  </span>
                ) : null
              }
            >
              <div className="grid justify-items-center gap-0.5 pb-1">
                <span
                  className={cn(
                    'font-mono text-[40px] font-bold leading-none',
                    lead?.score == null
                      ? 'text-muted-foreground'
                      : lead.grade === 'reject'
                        ? 'text-destructive'
                        : lead.score >= 75
                          ? 'text-success-strong'
                          : lead.score >= 50
                            ? 'text-warning-strong'
                            : 'text-destructive',
                  )}
                  data-testid="overall-score"
                >
                  {lead?.score == null ? '—' : Math.round(lead.score)}
                </span>
                <span className="text-xs text-muted-foreground">
                  综合评分 · {lead ? GRADE_TEXT[lead.grade] : '暂无线索'}
                  {lead?.score == null && lead
                    ? `（${scored}/7 个维度可计算，少于 4 个不给分）`
                    : ''}
                </span>
              </div>
              <Chart
                option={radarOption(data.dimensions)}
                empty={scored < 3}
                height={240}
                aria-label="7 维雷达"
              />
              <p className="text-center text-[11px] text-muted-foreground">
                雷达按对综合分的贡献绘制：反向维度取 100 − 分数，越靠外越有利
              </p>
              {data.dimensions.some((d) => d.score === null) ? (
                <div
                  className="flex flex-wrap justify-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="radar-missing"
                >
                  <span>无数据（未计入综合分）：</span>
                  {data.dimensions
                    .filter((d) => d.score === null)
                    .map((d) => (
                      <Tag key={d.dimension}>{d.label}</Tag>
                    ))}
                </div>
              ) : null}
              <ul className="grid gap-2.5" data-testid="dimension-list">
                {data.dimensions.map((d) => (
                  <DimensionRow key={d.dimension} d={d} labels={data.sourceLabels} />
                ))}
              </ul>
            </Card>

            {/* 右：置信度、风险 */}
            <div className="grid content-start gap-4">
              <Card
                title="置信度明细"
                testId="confidence-card"
                extra={
                  lead?.confidence != null ? (
                    <span className="text-xs text-muted-foreground">与综合分分开显示</span>
                  ) : null
                }
              >
                <ConfidenceBar value={lead?.confidence ?? null} label="总置信度" />
                {data.confidence.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无置信度明细</p>
                ) : (
                  <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    {data.confidence.items.map((item) => (
                      <li key={item.id} className="grid gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="font-medium">{item.label}</span>
                          <span className="font-mono text-muted-foreground">
                            {item.value === null ? '不可算' : `${Math.round(item.value * 100)}%`}
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          {item.value === null ? null : (
                            <div
                              className={cn(
                                'h-full rounded-full',
                                item.value >= 0.7
                                  ? 'bg-success'
                                  : item.value >= 0.4
                                    ? 'bg-warning'
                                    : 'bg-destructive',
                              )}
                              style={{ width: `${Math.round(item.value * 100)}%` }}
                            />
                          )}
                        </div>
                        <span className="text-[11px] leading-snug text-muted-foreground">
                          {item.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.confidence.unverifiedMetrics.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                    <span>未交叉验证：</span>
                    {data.confidence.unverifiedMetrics.map((m) => (
                      <Tag key={m.metric}>{m.label}</Tag>
                    ))}
                  </div>
                ) : null}
              </Card>

              <Card title="风险提示" testId="risk-card" extra={<RiskSummary risks={data.risks} />}>
                {data.risks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    品牌库、VeRO、受限类目与认证规则均未命中。
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {data.risks.map((r) => (
                      <RiskCard
                        key={r.id}
                        level={(r.level === 'info' ? 'hint' : r.level) as RiskLevel}
                        veto={r.veto}
                        title={r.label}
                      >
                        <span>{r.basis || '—'}</span>
                        {r.link ? (
                          <a
                            href={r.link}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 text-primary hover:underline"
                          >
                            {r.kind === 'design-patent' ? '在 Google Patents 检索 ↗' : '查看依据 ↗'}
                          </a>
                        ) : null}
                      </RiskCard>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>

          {/* 曲线 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="店铺价格（近 90 天）">
              <Chart
                option={lineOption(data.series.price, true)}
                empty={data.series.price.length === 0}
                height={240}
                aria-label="价格曲线"
              />
            </Card>
            <Card title={`${data.series.sales.label}（近 90 天）`}>
              <Chart
                option={lineOption(data.series.sales.series, false)}
                empty={data.series.sales.series.length === 0}
                height={240}
                aria-label="销量曲线"
              />
            </Card>
          </div>

          <Card
            title="季节曲线"
            extra={
              data.season?.keywords.length ? (
                <span className="text-xs text-muted-foreground">
                  搜索趋势：{data.season.keywords.join('、')}
                </span>
              ) : null
            }
          >
            {data.season === null ? (
              <p className="text-xs text-muted-foreground">
                该方向没有关联销售节点。可在“选品方向”中关联节点，季节曲线会叠加节点关键词的搜索趋势。
              </p>
            ) : (
              <>
                <Chart
                  option={seasonOption(data.season)}
                  empty={data.season.years.length === 0}
                  height={220}
                  aria-label="季节曲线"
                />
                <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <span>节点销售窗口：</span>
                  {data.season.windows.map((w) => (
                    <Tag key={w.name} tone="warning">
                      {w.name} {w.startMonth}/{w.startDay} 起 {w.salesDays} 天
                    </Tag>
                  ))}
                </div>
              </>
            )}
          </Card>

          <SourceCompare compare={data.compare} />

          <Members slug={slug} data={data} onChanged={reload} />
        </>
      )}

      {tab === 'overview' && data.events.length > 0 ? (
        <Section title="修正记录">
          <ul className="grid gap-1.5 text-[13px]">
            {data.events.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <Tag
                  tone={e.kind === 'merge' ? 'info' : e.kind === 'split' ? 'warning' : 'neutral'}
                >
                  {e.kind === 'merge'
                    ? '合并'
                    : e.kind === 'split'
                      ? '拆分'
                      : e.kind === 'status'
                        ? '状态'
                        : '备注'}
                </Tag>
                <span>{e.summary}</span>
                <span className="text-xs text-muted-foreground">{formatTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

function RiskSummary({ risks }: { risks: Detail['risks'] }) {
  const veto = risks.filter((r) => r.veto).length
  if (risks.length === 0) return <Tag tone="success">未发现</Tag>
  return veto > 0 ? (
    <Tag tone="danger">{veto} 项一票否决</Tag>
  ) : (
    <Tag tone="warning">{risks.length} 项</Tag>
  )
}

function DimensionRow({ d, labels }: { d: Dimension; labels: Record<string, string> }) {
  const value = effective(d)
  // 每个维度的输入来源（悬浮查看），按指标去重显示
  const metrics = [...new Set(d.sources.map((s) => s.metric))]
  return (
    <li className="grid gap-1" data-dimension={d.dimension}>
      <div className="flex items-center gap-2.5 text-xs">
        <span className="w-[76px] shrink-0 font-medium text-subtle-foreground">{d.label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          {value === null ? null : (
            <div
              className={cn('h-full rounded-full', barColor(value))}
              style={{ width: `${value}%` }}
            />
          )}
        </div>
        <span
          className={cn(
            'w-14 shrink-0 text-right font-mono text-[13px] font-semibold',
            d.score === null && 'font-sans text-xs font-normal text-muted-foreground',
          )}
          data-testid={`dimension-score-${d.dimension}`}
        >
          {d.score === null ? '无数据' : Math.round(d.score)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[86px] text-[11px] leading-snug text-muted-foreground">
        {d.reversed && value !== null ? (
          <span className="text-warning-strong">反向维度 · 贡献 {value}</span>
        ) : null}
        {d.reason ? <span>{d.reason}</span> : null}
        {metrics.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {[...new Map(d.sources.map((s) => [s.sourceId, s])).values()]
              .filter((s) => s.sourceId !== 'selection-config' && s.sourceId !== 'risk-rules')
              .slice(0, 3)
              .map((s) => (
                <SourceBadge
                  key={s.sourceId}
                  method={s.method}
                  source={labels[s.sourceId] ?? s.sourceId}
                />
              ))}
          </span>
        ) : null}
      </div>
    </li>
  )
}

/** 来源对比：每个指标的各来源值、主值来源、离散度与获取时间 */
function SourceCompare({ compare }: { compare: Detail['compare'] }) {
  const [selected, setSelected] = useState(compare[0]?.productId ?? '')
  const current = compare.find((m) => m.productId === selected) ?? compare[0]
  return (
    <Card
      title="来源对比"
      testId="source-compare"
      extra={
        compare.length > 1 ? (
          <select
            aria-label="选择成员"
            className={cn(controlClass, 'h-7 w-auto max-w-[260px] text-xs')}
            value={current?.productId}
            onChange={(e) => setSelected(e.target.value)}
          >
            {compare.map((m) => (
              <option key={m.productId} value={m.productId}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      {!current || current.metrics.length === 0 ? (
        <p className="text-xs text-muted-foreground">近 90 天没有该商品的观测值。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">指标</th>
                <th className="py-2 pr-3 font-medium">主值</th>
                <th className="py-2 pr-3 font-medium">各来源值</th>
                <th className="py-2 pr-3 text-right font-medium">离散度</th>
                <th className="py-2 font-medium">观测日</th>
              </tr>
            </thead>
            <tbody>
              {current.metrics.map((m) => {
                const primary = m.values.find((v) => v.sourceId === m.primarySourceId)
                return (
                  <tr key={m.metric} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3 font-medium">{m.label}</td>
                    <td className="py-2 pr-3">
                      {primary ? (
                        <SourceHover view={m} align="left">
                          <span className="font-mono font-semibold">
                            {formatMetric(m.metric, primary.value, primary.currency)}
                          </span>
                        </SourceHover>
                      ) : null}
                      <div className="text-[11px] text-muted-foreground">
                        主值来源 {primary?.label}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="grid gap-1">
                        {m.values.map((v) => (
                          <div key={v.sourceId} className="flex flex-wrap items-center gap-1.5">
                            <SourceBadge method={v.method} source={v.label} />
                            <span className="font-mono">
                              {formatMetric(m.metric, v.value, v.currency)}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              获取于 {formatTime(v.fetchedAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-3 text-right font-mono',
                        m.values.length < 2
                          ? 'font-sans text-xs text-muted-foreground'
                          : (m.dispersion ?? 0) > 0.3
                            ? 'text-destructive'
                            : (m.dispersion ?? 0) > 0.1
                              ? 'text-warning-strong'
                              : 'text-success-strong',
                      )}
                    >
                      {dispersionText(m.dispersion, m.values.length)}
                    </td>
                    <td className="py-2 font-mono text-xs text-muted-foreground">{m.observedOn}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Members({
  slug,
  data,
  onChanged,
}: {
  slug: string
  data: Detail
  onChanged: () => Promise<void>
}) {
  const { busy, error, run } = useAction(onChanged)
  const [target, setTarget] = useState('')
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const writable = data.canWrite && data.cluster.status === 'active'
  return (
    <Card
      title={`簇成员（${data.members.length}）`}
      testId="members"
      extra={
        <span className="text-xs text-muted-foreground">
          手动拆分 / 合并的成员会锁定，之后的自动归并不再改动
        </span>
      }
    >
      {data.members.length === 0 ? (
        <EmptyState title="没有成员" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">商品</th>
                <th className="py-2 pr-3 font-medium">卖家</th>
                <th className="py-2 pr-3 font-medium">归并方式</th>
                <th className="py-2 pr-3 text-right font-medium">归并置信度</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <MemberRow
                  key={m.id}
                  slug={slug}
                  clusterId={data.cluster.id}
                  member={m}
                  writable={writable}
                  canSplit={data.members.length > 1}
                  busy={busy}
                  refreshOpen={refreshing === m.id}
                  onToggleRefresh={() => setRefreshing(refreshing === m.id ? null : m.id)}
                  onSplit={() =>
                    run(() =>
                      splitMember({ data: { slug, clusterId: data.cluster.id, memberId: m.id } }),
                    )
                  }
                  onRefreshed={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {writable ? (
        <form
          aria-label="合并商品簇"
          className="flex flex-wrap items-center gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!target) return
            void run(() =>
              mergeCluster({
                data: { slug, intoClusterId: data.cluster.id, fromClusterId: target },
              }),
            ).then((ok) => ok && setTarget(''))
          }}
        >
          <label htmlFor="merge-target" className="text-xs font-medium text-muted-foreground">
            把另一个簇合并到本簇
          </label>
          <select
            id="merge-target"
            className={cn(controlClass, 'w-auto min-w-[240px] max-w-[360px]')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={data.mergeTargets.length === 0}
          >
            <option value="">
              {data.mergeTargets.length === 0 ? '同方向同站点没有其他商品簇' : '选择商品簇'}
            </option>
            {data.mergeTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !target}>
            合并
          </Button>
        </form>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  )
}

function MemberRow({
  slug,
  clusterId,
  member: m,
  writable,
  canSplit,
  busy,
  refreshOpen,
  onToggleRefresh,
  onSplit,
  onRefreshed,
}: {
  slug: string
  clusterId: string
  member: Detail['members'][number]
  writable: boolean
  canSplit: boolean
  busy: boolean
  refreshOpen: boolean
  onToggleRefresh: () => void
  onSplit: () => void
  onRefreshed: () => Promise<void>
}) {
  return (
    <>
      <tr className="border-b last:border-0" data-testid="member-row">
        <td className="py-2 pr-3">
          <div className="flex items-center gap-2.5">
            <ProductThumb src={m.imageUrl} title={m.title} size={32} />
            <div className="grid min-w-0 gap-0.5">
              <span className="line-clamp-1 font-medium" title={m.title}>
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noreferrer" className="hover:text-primary">
                    {m.title}
                  </a>
                ) : (
                  m.title
                )}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{m.platformId}</span>
                {m.isRepresentative ? <Tag tone="info">代表商品</Tag> : null}
              </span>
            </div>
          </div>
        </td>
        <td className="py-2 pr-3 text-xs">{m.sellerId ?? '—'}</td>
        <td className="py-2 pr-3">
          <span className="flex items-center gap-1.5">
            <Tag tone={m.method === 'manual' ? 'warning' : 'neutral'}>
              {METHOD_LABELS[m.method] ?? m.method}
            </Tag>
            {m.locked ? <Tag tone="warning">已锁定</Tag> : null}
          </span>
        </td>
        <td className="py-2 pr-3 text-right font-mono">{Math.round(m.confidence * 100)}%</td>
        <td className="py-2 text-right">
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onToggleRefresh}>
              {refreshOpen ? '收起' : '人工刷新'}
            </Button>
            {writable ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canSplit}
                title={canSplit ? undefined : '簇里只有这一个成员'}
                onClick={() => {
                  if (window.confirm(`把“${m.title}”拆成单独的商品簇？`)) onSplit()
                }}
              >
                拆分
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {refreshOpen ? (
        <tr className="border-b bg-muted/40">
          <td colSpan={5} className="px-3 py-3">
            <RefreshPanel
              slug={slug}
              clusterId={clusterId}
              memberId={m.id}
              writable={writable}
              onRefreshed={onRefreshed}
            />
          </td>
        </tr>
      ) : null}
    </>
  )
}

type RefreshOptions = Awaited<ReturnType<typeof estimateMemberRefresh>>
type RefreshResult = Awaited<ReturnType<typeof refreshMemberData>>

const REFRESH_STATUS: Record<string, string> = {
  succeeded: '刷新完成',
  failed: '刷新失败',
  deferred: '额度不足，已顺延',
  skipped: '未执行',
}

/** 单个商品的人工刷新：先显示各数据源的预计花费与本期额度，确认后执行（遵守硬上限） */
function RefreshPanel({
  slug,
  clusterId,
  memberId,
  writable,
  onRefreshed,
}: {
  slug: string
  clusterId: string
  memberId: string
  writable: boolean
  onRefreshed: () => Promise<void>
}) {
  const [options, setOptions] = useState<RefreshOptions | null>(null)
  const [result, setResult] = useState<RefreshResult | null>(null)
  const { busy, error, setError, run } = useAction(async () => undefined)
  // 展开时先估算花费；执行刷新前不调用任何外部接口
  useEffect(() => {
    let cancelled = false
    estimateMemberRefresh({ data: { slug, clusterId, memberId } })
      .then((o) => !cancelled && setOptions(o))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : '估算失败'))
    return () => {
      cancelled = true
    }
  }, [slug, clusterId, memberId, setError])
  return (
    <div className="grid gap-2 text-xs" data-testid="refresh-panel">
      {options === null ? (
        <span className="text-muted-foreground">{error ? '' : '正在估算花费…'}</span>
      ) : options.options.length === 0 ? (
        <span className="text-muted-foreground">
          没有支持 {options.marketplace} 商品快照的数据源。
        </span>
      ) : (
        <ul className="grid gap-1.5">
          {options.options.map((o) => {
            const blocked = !o.enabled
              ? '数据源未启用'
              : o.paused
                ? '数据源已暂停'
                : !o.withinCap
                  ? '超过本期硬上限'
                  : null
            return (
              <li key={o.sourceId} className="flex flex-wrap items-center gap-3">
                <span className="w-32 font-medium">{o.label}</span>
                <span>
                  预计花费 <strong className="font-mono">{formatInt(o.cost)}</strong> {o.unit}
                </span>
                <span className="text-muted-foreground">
                  本期已用 {formatInt(o.used)} / 硬上限 {formatInt(o.hardCap)}
                </span>
                {blocked ? <Tag tone="neutral">{blocked}</Tag> : null}
                {writable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={busy || blocked !== null}
                    onClick={() =>
                      run(async () => {
                        const r = await refreshMemberData({
                          data: { slug, clusterId, memberId, sourceId: o.sourceId },
                        })
                        setResult(r)
                        await onRefreshed()
                        setOptions(
                          await estimateMemberRefresh({ data: { slug, clusterId, memberId } }),
                        )
                      })
                    }
                  >
                    刷新 {options.platformId}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {result ? (
        <p
          role="status"
          className={result.status === 'succeeded' ? 'text-success-strong' : 'text-warning-strong'}
        >
          {REFRESH_STATUS[result.status] ?? result.status}
          {'observations' in result ? `：写入 ${result.observations} 条观测值` : ''}
          {'reason' in result && result.reason ? `（${result.reason}）` : ''}
          {'errorCode' in result && result.errorCode ? `（${result.errorCode}）` : ''}
        </p>
      ) : null}
      {!writable ? (
        <span className="text-muted-foreground">执行刷新需要空间所有者或管理员。</span>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
