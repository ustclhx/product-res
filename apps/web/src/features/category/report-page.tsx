import { Button, cn, Tag } from '@product-res/ui'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { marketplaceLabel } from '../follow/marketplaces.ts'
import { controlClass, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import {
  archiveCategoryStudy,
  convertCategoryProduct,
  type getCategoryReport,
  refreshCategoryStudy,
} from './category.functions.ts'
import { BubbleChart, PriceBandChart, TrendChart, WordCloud } from './charts.tsx'
import {
  fmtCompact,
  fmtDateTime,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtSignedPercent,
} from './format.ts'
import { SourcePopover, SummarySources, ValueSources } from './source.tsx'
import {
  type MatrixRowView,
  NO_SOURCE,
  type ReviewView,
  type SnapshotModules,
  type Suggestion,
} from './types.ts'

export type ReportData = Awaited<ReturnType<typeof getCategoryReport>>

/** “分析中”时的轮询间隔 */
const ANALYSIS_POLL_MS = 4000

/** 品类洞察报告（对照 docs/design/workbench-overview.html「品牌选品 · 品类洞察」） */
export function CategoryReportPage({ slug, data }: { slug: string; data: ReportData }) {
  const router = useRouter()
  const navigate = useNavigate()
  const { study, snapshot, snapshots } = data
  const latestId = snapshots[0]?.id
  const refresh = useAction(async () => {
    await navigate({
      to: '/app/$slug/category/$studyId',
      params: { slug, studyId: study.id },
      search: {},
    })
    await router.invalidate()
  })
  const archive = useAction(async () => {
    await router.invalidate()
  })
  const archived = study.status === 'archived'
  // 后台 AI 分析在途（add-insight-background-analysis）：定时重新加载，完成或过期后停止
  const analyzing =
    snapshot?.modules.painPoints.themes.status === 'running' ||
    snapshot?.modules.suggestions.status === 'running'
  useEffect(() => {
    if (!analyzing) return
    const timer = setInterval(() => {
      void router.invalidate()
    }, ANALYSIS_POLL_MS)
    return () => clearInterval(timer)
  }, [analyzing, router])
  return (
    <div className="grid gap-3" data-testid="category-report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <nav className="text-xs text-muted-foreground">
            <Link to="/app/$slug/category" params={{ slug }} className="hover:text-primary">
              品牌选品
            </Link>
            <span className="px-1">/</span>
            <span>品类洞察 · {study.name}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{study.name}</h1>
            <Tag tone="info">{marketplaceLabel(study.marketplace)}</Tag>
            {archived ? <Tag tone="neutral">已归档</Tag> : null}
          </div>
          <ScopeLine study={study} modules={snapshot?.modules ?? null} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {snapshots.length > 0 ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              快照
              <select
                aria-label="快照"
                className={cn(controlClass, 'w-auto min-w-[180px]')}
                value={snapshot?.id ?? ''}
                onChange={(e) =>
                  navigate({
                    to: '/app/$slug/category/$studyId',
                    params: { slug, studyId: study.id },
                    search: e.target.value === latestId ? {} : { snapshot: e.target.value },
                  })
                }
              >
                {snapshots.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    {fmtDateTime(s.generatedAt)}
                    {i === 0 ? '（最新）' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {data.canWrite ? (
            <>
              <Button
                size="sm"
                disabled={refresh.busy || archived}
                onClick={() =>
                  refresh.run(() =>
                    refreshCategoryStudy({ data: { slug, id: study.id, name: study.name } }),
                  )
                }
              >
                {refresh.busy ? '刷新中…' : '用最新数据刷新'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={archive.busy}
                onClick={() =>
                  archive.run(() =>
                    archiveCategoryStudy({ data: { slug, id: study.id, archived: !archived } }),
                  )
                }
              >
                {archived ? '取消归档' : '归档到档案库'}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <ErrorText>{refresh.error || archive.error}</ErrorText>
      {snapshot && latestId && snapshot.id !== latestId ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
          正在查看历史快照（{fmtDateTime(snapshot.generatedAt)}），
          <Link
            to="/app/$slug/category/$studyId"
            params={{ slug, studyId: study.id }}
            search={{}}
            className="font-medium underline"
          >
            回到最新快照
          </Link>
        </p>
      ) : null}
      {snapshot ? (
        <Report
          slug={slug}
          data={data}
          modules={snapshot.modules}
          snapshotId={snapshot.id}
          dataAsOf={snapshot.dataAsOf}
        />
      ) : (
        <div className="rounded-xl border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          还没有报告快照{data.canWrite ? '，点击“用最新数据刷新”生成第一份。' : '。'}
        </div>
      )}
    </div>
  )
}

function ScopeLine({
  study,
  modules,
}: {
  study: ReportData['study']
  modules: SnapshotModules | null
}) {
  const parts = [
    study.categoryIds.length ? `类目 ${study.categoryIds.join('、')}` : null,
    study.keywords.length ? `关键词 ${study.keywords.join('、')}` : null,
    `头部 ${study.topN}`,
    modules ? `匹配商品 ${fmtNumber(modules.scope.productCount)} 个` : null,
  ].filter(Boolean)
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>
}

function Report({
  slug,
  data,
  modules,
  snapshotId,
  dataAsOf,
}: {
  slug: string
  data: ReportData
  modules: SnapshotModules
  snapshotId: string
  dataAsOf: string | null
}) {
  const { overview } = modules
  const competitors = modules.competitors.status === 'ok' ? modules.competitors : null
  const productTitles = new Map(
    (competitors?.rows ?? []).map((r) => [r.id, r.title ?? r.platformId] as const),
  )
  return (
    <>
      <p className="text-xs text-muted-foreground">
        数据截止 {dataAsOf ?? '—'} · 刷新只读取已有观测值，不会发起外部采集；需要补数据时请到
        <Link
          to="/app/$slug/data"
          params={{ slug }}
          className="mx-0.5 text-primary hover:underline"
        >
          数据中心
        </Link>
        手动刷新（受额度限制）。
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="搜索量同比（YoY）"
          testId="stat-yoy"
          module={overview.yoy}
          render={(m) => ({
            value: (
              <span className={m.yoy >= 0 ? 'text-success-strong' : 'text-destructive'}>
                {fmtSignedPercent(m.yoy)}
              </span>
            ),
            hint: (
              <>
                覆盖 {m.coveredMonths} 个月 · 截至 {m.endMonth}
                {m.coveredMonths < 12 ? <Tag tone="warning">月份不全</Tag> : null}
              </>
            ),
            source: (
              <SummarySources
                sources={m.sources}
                note={`近 12 个月合计 ${fmtCompact(m.currentSum)} ÷ 前 12 个月同月合计 ${fmtCompact(m.previousSum)} − 1，只用两边都有数据的月份`}
              />
            ),
          })}
        />
        <Stat
          label="近 90 天新品"
          testId="stat-new"
          module={overview.newProducts}
          render={(m) => ({
            value: fmtNumber(m.count),
            hint: `按上架时间 ${m.byListedAt} · 按首次发现 ${m.byFirstSeenAt}${m.excluded ? ` · ${m.excluded} 个无日期未计入` : ''}`,
            source: (
              <SourcePopover label="口径">
                <p className="leading-relaxed text-muted-foreground">{m.basis}</p>
              </SourcePopover>
            ),
          })}
        />
        <Stat
          label="头部集中度 CR3 / CR10"
          testId="stat-cr"
          module={overview.concentration}
          render={(m) => ({
            value: (
              <>
                {fmtPercent(m.cr3)}
                <span className="mx-1 text-base font-normal text-muted-foreground">/</span>
                <span className="text-xl">{fmtPercent(m.cr10)}</span>
              </>
            ),
            hint: (
              <>
                样本 {m.sampleSize} 个商品
                {m.crossValidated ? (
                  <Tag tone="success" title={`${m.crossChecked} 个商品有第二销量来源`}>
                    已交叉验证
                  </Tag>
                ) : (
                  <Tag tone="warning">未交叉验证</Tag>
                )}
              </>
            ),
            source: (
              <SummarySources
                sources={m.sources}
                note="按月销量估算降序，前 3 / 前 10 名占样本销量合计的比例；没有任何商品的销量估算有第二来源可比对时标“未交叉验证”"
              />
            ),
          })}
        />
        <Stat label="退货率" testId="stat-return" module={modules.returnRate} render={() => null} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="12 个月趋势"
          extra={
            modules.trend.status === 'ok' ? (
              <span className="text-xs text-muted-foreground">虚线为节点</span>
            ) : null
          }
          testId="module-trend"
        >
          {modules.trend.status === 'ok' ? (
            <div className="grid gap-1">
              <SeriesHead
                label="月搜索量"
                dot="#1677ff"
                source={<SummarySources sources={modules.trend.searchSources} />}
              />
              <TrendChart
                points={modules.trend.points}
                metric="searchVolume"
                color="#1677ff"
                label="月搜索量"
              />
              <SeriesHead
                label="月销量估算（匹配商品合计）"
                dot="#52c41a"
                source={<SummarySources sources={modules.trend.salesSources} />}
              />
              <TrendChart
                points={modules.trend.points}
                metric="salesEstimate"
                color="#52c41a"
                label="月销量估算"
                nodeLabels={false}
              />
            </div>
          ) : (
            <NoSource reason={modules.trend.reason} />
          )}
        </Panel>

        <Panel
          title="价格带分布"
          extra={
            overview.priceBands.status === 'ok' ? (
              <SummarySources
                sources={overview.priceBands.sources}
                note={`价格按分位分 6 档，柱高为该档销量估算占比，标注商品数；${overview.priceBands.excludedNoPrice} 个商品缺价格未计入，${overview.priceBands.missingSales} 个缺销量估算不计入占比`}
              />
            ) : null
          }
          testId="module-price"
        >
          {overview.priceBands.status === 'ok' ? (
            <div className="grid gap-2">
              <PriceBandChart
                bands={overview.priceBands.bands}
                currency={overview.priceBands.currency}
              />
              <dl className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground">计入商品</dt>
                  <dd className="font-mono text-sm font-semibold">
                    {fmtNumber(overview.priceBands.bands.reduce((a, b) => a + b.productCount, 0))}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground">缺价格未计入</dt>
                  <dd className="font-mono text-sm font-semibold">
                    {fmtNumber(overview.priceBands.excludedNoPrice)}
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground">缺销量估算（不计占比）</dt>
                  <dd className="font-mono text-sm font-semibold">
                    {fmtNumber(overview.priceBands.missingSales)}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <NoSource reason={overview.priceBands.reason} />
          )}
        </Panel>

        <PainPanel modules={modules} />

        <Panel
          title="价格 × 销量"
          extra={
            competitors ? (
              <span className="text-xs text-muted-foreground">
                气泡大小 = 评论数
                {competitors.bubblesSkipped
                  ? ` · ${competitors.bubblesSkipped} 个缺数据未画入`
                  : ''}
              </span>
            ) : null
          }
          testId="module-bubble"
        >
          {competitors ? (
            <BubbleChart
              rows={competitors.rows}
              bubbles={competitors.bubbles}
              currency={competitors.currency}
            />
          ) : (
            <NoSource
              reason={modules.competitors.status === 'no-source' ? modules.competitors.reason : ''}
            />
          )}
        </Panel>
      </div>

      <MatrixPanel slug={slug} data={data} modules={modules} snapshotId={snapshotId} />

      <SuggestionsPanel modules={modules} productTitles={productTitles} />
    </>
  )
}

function Panel({
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
      className={cn('grid content-start rounded-xl border bg-card shadow-xs', className)}
      data-testid={testId}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {extra}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function SeriesHead({ label, dot, source }: { label: string; dot: string; source: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full" style={{ background: dot }} />
        {label}
      </span>
      {source}
    </div>
  )
}

/** 没有数据的模块：只给原因，不放示例值 */
function NoSource({ reason, compact = false }: { reason: string; compact?: boolean }) {
  return (
    <div
      data-testid="no-source"
      className={cn(
        'grid place-content-center justify-items-center gap-1 rounded-lg border border-dashed bg-muted/40 px-4 text-center',
        compact ? 'py-2' : 'min-h-[140px] py-6',
      )}
    >
      <span className="text-[13px] font-medium text-muted-foreground">{NO_SOURCE}</span>
      {reason ? <span className="text-xs text-subtle-foreground">{reason}</span> : null}
    </div>
  )
}

function Stat<T extends { status: string }>({
  label,
  module,
  render,
  testId,
}: {
  label: string
  module: T | { status: 'no-source'; reason: string }
  render: (m: Extract<T, { status: 'ok' }>) => {
    value: ReactNode
    hint: ReactNode
    source: ReactNode
  } | null
  testId: string
}) {
  const ok = module.status === 'ok' ? render(module as Extract<T, { status: 'ok' }>) : null
  return (
    <div
      data-testid={testId}
      className="grid content-start gap-1 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {ok?.source}
      </div>
      {ok ? (
        <>
          <div className="font-mono text-2xl font-bold leading-tight tabular-nums">{ok.value}</div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {ok.hint}
          </div>
        </>
      ) : (
        <>
          <div className="text-lg font-semibold leading-tight text-subtle-foreground">
            {NO_SOURCE}
          </div>
          <div className="text-xs text-subtle-foreground">
            {'reason' in module ? String(module.reason) : ''}
          </div>
        </>
      )}
    </div>
  )
}

function PainPanel({ modules }: { modules: SnapshotModules }) {
  const { terms, themes } = modules.painPoints
  return (
    <Panel
      title="差评痛点"
      extra={
        terms.status === 'ok' ? (
          <span className="text-xs text-muted-foreground">
            {fmtNumber(terms.negativeCount)} 条差评 / {fmtNumber(terms.totalReviews)} 条评论 · 来源{' '}
            {terms.sources.join('、')}
          </span>
        ) : null
      }
      testId="module-pain"
    >
      {terms.status !== 'ok' ? (
        <NoSource reason={terms.reason} />
      ) : (
        <div className="grid gap-3">
          <WordCloud terms={terms.terms} reviews={modules.reviews} />
          <div className="grid gap-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">痛点主题占比</span>
              {themes.status === 'ok' ? (
                <span className="text-[11px] text-subtle-foreground">
                  AI 归纳 {themes.analyzed} 条差评 · {themes.ai.modelKey}
                  {themes.ai.reusedFrom ? ' · 沿用上一份结果' : ''}
                </span>
              ) : null}
            </div>
            {themes.status === 'ok' ? (
              themes.themes.map((t) => (
                <div key={t.label} className="grid gap-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{t.label}</span>
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <span className="font-mono">{fmtPercent(t.share)}</span>· {t.reviewCount} 条
                      <ReviewsPopover ids={t.reviewIds} reviews={modules.reviews} />
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-destructive/70"
                      style={{ width: `${Math.max(2, t.share * 100)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : themes.status === 'running' ? (
              <AiRunning reason={themes.reason} />
            ) : (
              <AiReason
                status={themes.status}
                reason={themes.reason}
                code={'code' in themes ? themes.code : undefined}
              />
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}

function AiRunning({ reason }: { reason: string }) {
  return (
    <p
      data-testid="ai-running"
      role="status"
      className="flex items-center gap-2 rounded-md bg-primary-soft px-3 py-2 text-xs text-primary"
    >
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />
      <span>
        <span className="font-medium">分析中</span>：{reason}
      </span>
    </p>
  )
}

function AiReason({
  status,
  reason,
  code,
}: {
  status: string
  reason: string
  code?: string | undefined
}) {
  return (
    <p
      data-testid="ai-reason"
      data-code={code}
      className={cn(
        'rounded-md px-3 py-2 text-xs',
        status === 'error'
          ? 'bg-destructive-soft text-destructive'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {status === 'ai-not-configured' ? 'AI 未配置：' : status === 'error' ? 'AI 未生成：' : ''}
      {reason.replace(/^AI 未配置：/, '')}
    </p>
  )
}

function ReviewQuote({ review }: { review: ReviewView }) {
  return (
    <blockquote className="grid gap-0.5 border-l-2 border-destructive/40 pl-2">
      <span className="text-[11px] text-muted-foreground">
        {'★'.repeat(review.rating)}
        {'☆'.repeat(Math.max(0, 5 - review.rating))} · {review.sourceId}
      </span>
      {review.title ? <span className="font-medium">{review.title}</span> : null}
      <span className="leading-relaxed text-muted-foreground">{review.body}</span>
    </blockquote>
  )
}

function ReviewsPopover({
  ids,
  reviews,
}: {
  ids: readonly string[]
  reviews: Readonly<Record<string, ReviewView>>
}) {
  return (
    <SourcePopover label="原文" align="right">
      {ids.map((id) => (reviews[id] ? <ReviewQuote key={id} review={reviews[id]} /> : null))}
    </SourcePopover>
  )
}

function MatrixPanel({
  slug,
  data,
  modules,
  snapshotId,
}: {
  slug: string
  data: ReportData
  modules: SnapshotModules
  snapshotId: string
}) {
  const [converting, setConverting] = useState<MatrixRowView | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const converted = { ...data.converted, ...done }
  const c = modules.competitors
  return (
    <Panel
      title={`竞品矩阵 — Top ${data.study.topN}`}
      extra={<span className="text-xs text-muted-foreground">按月销量估算排序</span>}
      testId="module-matrix"
    >
      {c.status !== 'ok' ? (
        <NoSource reason={c.reason} />
      ) : (
        <div className="-mx-4 -my-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">商品（标题即卖点）</th>
                <th className="px-2 py-2 text-right font-medium">价格</th>
                <th className="px-2 py-2 text-right font-medium">月销量估算</th>
                <th className="px-2 py-2 text-right font-medium">评分</th>
                <th className="px-2 py-2 text-right font-medium">评论数</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r, i) => (
                <tr key={r.id} className="border-t align-top hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-mono text-xs text-subtle-foreground">{i + 1}</td>
                  <td className="max-w-[380px] px-2 py-2.5">
                    <div className="line-clamp-2 font-medium leading-snug">
                      {r.title ?? '（无标题）'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {r.brand ? <strong className="text-foreground/80">{r.brand}</strong> : null}
                      {r.url ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-mono hover:text-primary"
                        >
                          {r.platformId}
                        </a>
                      ) : (
                        <span className="font-mono">{r.platformId}</span>
                      )}
                    </div>
                  </td>
                  <NumCell
                    value={r.price}
                    format={(n) => fmtMoney(n, r.price?.currency ?? c.currency)}
                  />
                  <NumCell value={r.salesMonthly} format={fmtCompact} />
                  <NumCell value={r.rating} format={(n) => n.toFixed(1)} />
                  <NumCell value={r.reviewCount} format={fmtCompact} />
                  <td className="px-4 py-2.5 text-right">
                    {converted[r.id] ? (
                      <Tag tone="success">已转线索</Tag>
                    ) : data.canWrite ? (
                      <Button size="sm" variant="outline" onClick={() => setConverting(r)}>
                        转为线索
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {converting ? (
        <ConvertDialog
          slug={slug}
          data={data}
          row={converting}
          snapshotId={snapshotId}
          onClose={() => setConverting(null)}
          onDone={(leadId) => {
            setDone((d) => ({ ...d, [converting.id]: leadId }))
            setConverting(null)
          }}
        />
      ) : null}
    </Panel>
  )
}

function NumCell({
  value,
  format,
}: {
  value: MatrixRowView['price']
  format: (n: number) => string
}) {
  return (
    <td className="px-2 py-2.5 text-right whitespace-nowrap">
      {value ? (
        <span className="inline-flex items-center gap-0.5">
          <span className="font-mono tabular-nums">{format(value.value)}</span>
          <ValueSources value={value} format={format} align="right" />
        </span>
      ) : (
        <span className="text-subtle-foreground" title={NO_SOURCE}>
          —
        </span>
      )}
    </td>
  )
}

function ConvertDialog({
  slug,
  data,
  row,
  snapshotId,
  onClose,
  onDone,
}: {
  slug: string
  data: ReportData
  row: MatrixRowView
  snapshotId: string
  onClose: () => void
  onDone: (leadId: string) => void
}) {
  const [directionId, setDirectionId] = useState(data.directions[0]?.id ?? '')
  const [improvement, setImprovement] = useState('')
  const { busy, error, run } = useAction(async () => {})
  const noDirection = data.directions.length === 0
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="转为跟卖线索"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className="grid w-full max-w-md gap-3 rounded-xl border bg-card p-5 shadow-lg"
        onSubmit={async (e) => {
          e.preventDefault()
          let leadId = ''
          const ok = await run(async () => {
            const result = await convertCategoryProduct({
              data: {
                slug,
                studyId: data.study.id,
                snapshotId,
                productId: row.id,
                ...(directionId ? { directionId } : {}),
                improvement,
              },
            })
            leadId = result.leadId
          })
          if (ok) onDone(leadId)
        }}
      >
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">转为跟卖线索</h2>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {row.title ?? row.platformId}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-primary-soft px-3 py-2 text-xs text-primary">
          跟卖方式：<strong>同款微改良</strong>
          <span className="text-primary/70">改良点写入线索备注并带入核算</span>
        </div>
        {noDirection ? (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            还没有覆盖 {marketplaceLabel(data.study.marketplace)} 的启用方向，请先在
            <Link
              to="/app/$slug/follow/directions"
              params={{ slug }}
              className="mx-0.5 font-medium underline"
            >
              选品方向
            </Link>
            中新建。
          </p>
        ) : (
          <Field label="归入方向" hint="线索在该方向的跟卖候选中出现">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={directionId}
                onChange={(e) => setDirectionId(e.target.value)}
              >
                {data.directions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="改良点" hint="例如：底部加防滑硅胶垫、改为可洗碗机材质">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              maxLength={500}
              className={`${controlClass} h-auto py-1.5`}
              value={improvement}
              onChange={(e) => setImprovement(e.target.value)}
            />
          )}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || noDirection}>
            {busy ? '转换中…' : '确认转为线索'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function SuggestionsPanel({
  modules,
  productTitles,
}: {
  modules: SnapshotModules
  productTitles: ReadonlyMap<string, string>
}) {
  const s = modules.suggestions
  return (
    <Panel
      title="差异化建议"
      extra={
        s.status === 'ok' ? (
          <span className="text-[11px] text-subtle-foreground">
            AI 生成 · {s.ai.modelKey}
            {s.dropped ? ` · 已丢弃 ${s.dropped} 条无依据建议` : ''}
          </span>
        ) : null
      }
      testId="module-suggestions"
    >
      {s.status === 'no-source' ? (
        <NoSource reason={s.reason} />
      ) : s.status === 'running' ? (
        <AiRunning reason={s.reason} />
      ) : s.status !== 'ok' ? (
        <AiReason status={s.status} reason={s.reason} code={s.code} />
      ) : s.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">AI 给出的建议都没有有效依据，已全部丢弃。</p>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {s.items.map((item, i) => (
            <SuggestionCard
              key={item.title}
              index={i + 1}
              item={item}
              reviews={modules.reviews}
              productTitles={productTitles}
            />
          ))}
        </ol>
      )}
    </Panel>
  )
}

function SuggestionCard({
  index,
  item,
  reviews,
  productTitles,
}: {
  index: number
  item: Suggestion
  reviews: Readonly<Record<string, ReviewView>>
  productTitles: ReadonlyMap<string, string>
}) {
  const reviewRefs = item.citations.filter((c) => c.kind === 'review')
  const productRefs = item.citations.filter((c) => c.kind === 'product')
  return (
    <li className="grid content-start gap-2 rounded-lg border border-success/30 bg-success-soft/40 p-3">
      <div className="flex items-start gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-[11px] font-semibold text-white">
          {index}
        </span>
        <div className="grid gap-0.5">
          <span className="text-[13px] font-semibold text-success-strong">{item.title}</span>
          {item.detail ? (
            <span className="text-xs leading-relaxed text-muted-foreground">{item.detail}</span>
          ) : null}
        </div>
      </div>
      <details className="group text-xs">
        <summary className="cursor-pointer list-none text-primary [&::-webkit-details-marker]:hidden">
          依据：{reviewRefs.length ? `${reviewRefs.length} 条差评` : ''}
          {reviewRefs.length && productRefs.length ? ' · ' : ''}
          {productRefs.length ? `${productRefs.length} 个竞品` : ''}
          <span className="ml-1 group-open:hidden">展开</span>
          <span className="ml-1 hidden group-open:inline">收起</span>
        </summary>
        <div className="mt-2 grid gap-2">
          {reviewRefs.map((c) =>
            reviews[c.id] ? <ReviewQuote key={c.id} review={reviews[c.id] as ReviewView} /> : null,
          )}
          {productRefs.map((c) => (
            <div key={c.id} className="border-l-2 border-primary/40 pl-2 text-muted-foreground">
              竞品：{productTitles.get(c.id) ?? c.id}
            </div>
          ))}
        </div>
      </details>
    </li>
  )
}
