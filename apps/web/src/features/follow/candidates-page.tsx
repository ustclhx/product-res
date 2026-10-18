import {
  ConfidenceBar,
  cn,
  DataTable,
  type DataTableColumn,
  GradeTag,
  SourceBadge,
  Tag,
} from '@product-res/ui'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { EmptyState } from '../workbench/fields.tsx'
import type { CandidateItem, CandidatesData } from './candidates.server.ts'
import {
  CANDIDATE_PAGE_SIZE,
  type CandidateColumnId,
  candidateColumnIds,
  PLATFORM_LABELS,
  PLATFORMS,
  type Platform,
} from './candidates.ts'
import { daysUntil, formatInt, formatMoney, ProductThumb } from './follow-ui.tsx'

const ATTENTION_LABEL = '值得关注但证据不足'

/** 综合分颜色与等级一致：推荐绿、谨慎橙、其余默认 */
function scoreClass(item: CandidateItem) {
  if (item.score === null) return 'text-muted-foreground'
  if (item.grade === 'reject') return 'text-destructive'
  if (item.score >= 75) return 'text-success-strong'
  if (item.score >= 50) return 'text-warning-strong'
  return 'text-destructive'
}

function riskTone(r: CandidateItem['risks'][number]) {
  if (r.veto || r.level === 'high') return 'danger' as const
  if (r.level === 'medium') return 'warning' as const
  return 'neutral' as const
}

function columnsFor(slug: string, platform: Platform): DataTableColumn<CandidateItem>[] {
  const all: Record<CandidateColumnId, DataTableColumn<CandidateItem>> = {
    cluster: {
      id: 'cluster',
      header: '商品簇',
      className: 'min-w-[240px]',
      cell: (item) => (
        <div className="flex items-center gap-3">
          <ProductThumb src={item.imageUrl} title={item.name} />
          <div className="grid min-w-0 gap-0.5">
            <Link
              to="/app/$slug/follow/$clusterId"
              params={{ slug, clusterId: item.clusterId }}
              className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground hover:text-primary"
              title={item.name}
            >
              {item.name}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              {[
                item.platformId
                  ? `${platform === 'amazon' ? 'ASIN' : 'Item'}: ${item.platformId}`
                  : null,
                item.directionName,
                `${item.memberCount} 个成员`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>
      ),
    },
    grade: {
      id: 'grade',
      header: '等级',
      className: 'whitespace-nowrap',
      cell: (item) => (
        <div className="grid justify-items-start gap-1">
          <span title={item.gateReasons.join('；') || undefined}>
            <GradeTag score={null} readiness={item.readiness} grade={item.grade} />
          </span>
          {item.attention ? (
            <Tag tone="warning" data-testid="attention-tag">
              {ATTENTION_LABEL}
            </Tag>
          ) : null}
          {item.followMode === 'improved' ? <Tag data-testid="follow-mode-tag">微改良</Tag> : null}
        </div>
      ),
    },
    score: {
      id: 'score',
      header: '综合分',
      className: 'whitespace-nowrap text-right',
      cell: (item) =>
        item.score === null ? (
          <span className="text-xs text-muted-foreground" title="可计算维度少于 4 个">
            维度不足
          </span>
        ) : (
          <span className={cn('font-mono text-base font-semibold', scoreClass(item))}>
            {Math.round(item.score)}
          </span>
        ),
    },
    confidence: {
      id: 'confidence',
      header: '置信度',
      className: 'w-28',
      cell: (item) => <ConfidenceBar value={item.confidence} label="" className="w-24" />,
    },
    signals: {
      id: 'signals',
      header: '命中信号',
      cell: (item) =>
        item.signals.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex max-w-[220px] flex-wrap gap-1">
            {item.signals.map((s) => (
              <Tag key={s.dimension} tone="info">
                {s.label}
                <span className="font-mono">{s.effective}</span>
              </Tag>
            ))}
          </div>
        ),
    },
    risks: {
      id: 'risks',
      header: '风险',
      cell: (item) =>
        item.risks.length === 0 ? (
          <span className="text-xs text-muted-foreground">未发现</span>
        ) : (
          <div className="flex max-w-[180px] flex-wrap gap-1">
            {item.risks.slice(0, 3).map((r) => (
              <Tag key={r.kind} tone={riskTone(r)}>
                {r.veto ? `否决 · ${r.label}` : r.label}
              </Tag>
            ))}
            {item.risks.length > 3 ? (
              <span className="text-xs text-muted-foreground">+{item.risks.length - 3}</span>
            ) : null}
          </div>
        ),
    },
    price: {
      id: 'price',
      header: '售价',
      className: 'whitespace-nowrap text-right',
      cell: (item) =>
        item.price ? (
          <span className="font-mono font-medium">
            {formatMoney(item.price.value, item.price.currency)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    bsr: {
      id: 'bsr',
      header: 'BSR',
      className: 'whitespace-nowrap text-right',
      cell: (item) =>
        item.bsr === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="font-mono">#{formatInt(item.bsr)}</span>
        ),
    },
    deadline: {
      id: 'deadline',
      header: '最晚决定日',
      className: 'whitespace-nowrap',
      cell: (item) => {
        if (!item.latestDecisionOn)
          return <span className="text-xs text-muted-foreground">未关联节点</span>
        const days = daysUntil(item.latestDecisionOn)
        return (
          <div className="grid gap-0.5">
            <span className="font-mono text-[13px]">{item.latestDecisionOn.slice(5)}</span>
            <span
              className={cn(
                'text-xs',
                days < 0
                  ? 'text-destructive'
                  : days <= 14
                    ? 'text-warning-strong'
                    : 'text-muted-foreground',
              )}
            >
              {days < 0 ? `已过 ${-days} 天` : days === 0 ? '今天' : `剩 ${days} 天`}
            </span>
          </div>
        )
      },
    },
    sources: {
      id: 'sources',
      header: '来源',
      className: 'whitespace-nowrap',
      cell: (item) =>
        item.sources.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          // 列表只显示获取方式徽标（官方/估算/推算/导入，同方式去重），来源名称收进悬浮提示；详情页有完整来源对比
          <div
            className="flex flex-wrap gap-1"
            title={item.sources.map((s) => s.label).join('、')}
            data-testid="candidate-sources"
          >
            {[...new Set(item.sources.map((s) => s.method))].map((method) => (
              <SourceBadge key={method} method={method} />
            ))}
            <span className="text-xs text-muted-foreground">{item.sources.length}</span>
          </div>
        ),
    },
  }
  return candidateColumnIds(platform).map((id) => all[id])
}

/** 跟卖候选列表（specs/follow-candidates「候选列表」，对照设计稿“跟卖候选品列表”） */
export function CandidatesPage({ slug, data }: { slug: string; data: CandidatesData }) {
  const navigate = useNavigate()
  const { platform, direction, offset } = data.search
  const columns = useMemo(() => columnsFor(slug, platform), [slug, platform])
  // 空串表示清除方向筛选；切换平台或筛选时回到第一页
  const go = (next: { platform?: Platform; direction?: string; offset?: number }) => {
    const d = next.direction === undefined ? direction : next.direction || undefined
    return navigate({
      to: '/app/$slug/follow',
      params: { slug },
      search: {
        platform: next.platform ?? platform,
        ...(d ? { direction: d } : {}),
        offset: next.offset ?? 0,
      },
    })
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">跟卖候选</h1>
          <p className="text-[13px] text-muted-foreground">
            每日流水线按方向归并同款商品并打分；按 综合分 × 置信度
            排序。冷启动阶段等级显示“未验证”，硬门槛不通过仍为“不推荐”。
          </p>
        </div>
        <Link
          to="/app/$slug/follow/directions"
          params={{ slug }}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[13px] hover:border-primary hover:text-primary"
          data-testid="follow-directions-link"
        >
          选品方向与店铺池 <span aria-hidden>→</span>
        </Link>
      </div>

      <section className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b">
          <div role="tablist" aria-label="平台" className="flex">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={platform === p}
                className={cn(
                  '-mb-px border-b-2 px-4 py-2 text-[13px]',
                  platform === p
                    ? 'border-primary font-medium text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
                onClick={() => go({ platform: p, direction: '' })}
              >
                {PLATFORM_LABELS[p]}
              </button>
            ))}
          </div>
          <span className="pb-2 text-xs text-muted-foreground" data-testid="candidate-total">
            共 <strong className="text-foreground">{data.total}</strong> 个候选
          </span>
        </div>

        {data.setup ? (
          <SetupEmpty slug={slug} platform={platform} setup={data.setup} filtered={!!direction} />
        ) : (
          <DataTable
            label={`${PLATFORM_LABELS[platform]} 跟卖候选`}
            columns={columns}
            rows={data.items}
            getRowId={(item) => item.leadId}
            page={{
              pageIndex: Math.floor(offset / CANDIDATE_PAGE_SIZE),
              pageSize: CANDIDATE_PAGE_SIZE,
              rowCount: data.total,
            }}
            onPageChange={(pageIndex) => go({ offset: pageIndex * CANDIDATE_PAGE_SIZE })}
            filters={[
              {
                id: 'direction',
                label: '方向',
                type: 'select',
                options: [
                  { value: '', label: '全部方向' },
                  ...data.directions.map((d) => ({
                    value: d.id,
                    label: d.enabled ? d.name : `${d.name}（已停用）`,
                  })),
                ],
              },
            ]}
            filterValues={{ direction }}
            onFiltersChange={(values) => go({ direction: values.direction ?? '' })}
            labels={{
              previous: '上一页',
              next: '下一页',
              page: (page, count) =>
                count === null ? `第 ${page} 页` : `第 ${page} / ${count} 页`,
              empty: '没有符合条件的候选',
              applyFilters: '筛选',
              resetFilters: '重置',
              filters: '候选筛选',
              pagination: '分页',
            }}
          />
        )}
      </section>
    </div>
  )
}

/** 空状态：说明先配置方向和数据源，不放示例数据 */
function SetupEmpty({
  slug,
  platform,
  setup,
  filtered,
}: {
  slug: string
  platform: Platform
  setup: NonNullable<CandidatesData['setup']>
  filtered: boolean
}) {
  const steps = [
    {
      done: setup.platformDirections > 0,
      title: `配置覆盖 ${PLATFORM_LABELS[platform]} 站点的选品方向`,
      detail:
        setup.platformDirections > 0
          ? `已有 ${setup.platformDirections} 个方向`
          : '选择平台站点、类目或关键词，并添加对标店铺',
      link: (
        <Link
          to="/app/$slug/follow/directions"
          params={{ slug }}
          className="text-primary hover:underline"
        >
          去配置方向
        </Link>
      ),
    },
    {
      done: setup.enabledSources > 0,
      title: '启用数据源',
      detail:
        setup.enabledSources > 0
          ? `已启用 ${setup.enabledSources} 个数据源`
          : '在数据中心配置凭据并启用至少一个数据源',
      link: (
        <Link to="/app/$slug/data" params={{ slug }} className="text-primary hover:underline">
          去数据中心
        </Link>
      ),
    },
    {
      done: false,
      title: '等待每日流水线生成候选',
      detail: '每天 04:00（新加坡时间）在数据同步之后归并、打分并生成线索',
      link: null,
    },
  ]
  return (
    <div data-testid="candidates-empty">
      <EmptyState title={filtered ? '该方向暂无候选' : `还没有 ${PLATFORM_LABELS[platform]} 候选`}>
        <ol className="mt-3 grid gap-2 text-left">
          {steps.map((step, i) => (
            <li key={step.title} className="flex items-start gap-2.5">
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  step.done ? 'bg-success text-white' : 'bg-muted text-muted-foreground',
                )}
              >
                {step.done ? '✓' : i + 1}
              </span>
              <span className="grid gap-0.5">
                <span className="text-[13px] font-medium text-foreground">{step.title}</span>
                <span>
                  {step.detail}
                  {step.link ? <> · {step.link}</> : null}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </EmptyState>
    </div>
  )
}
