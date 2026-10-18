import type { CostingResult, FollowMode } from '@product-res/costing'
import { Button, cn, Input, Tag } from '@product-res/ui'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import {
  getCostingTab,
  saveImprovement,
  selectScenario,
  setFollowMode,
} from './costing.functions.ts'
import {
  formatMoney,
  formatRate,
  moneyInput,
  parseMoney,
  parseNumber,
  parsePercent,
  percentInput,
} from './format.ts'
import type { MatrixOptions } from './inputs.ts'
import { FOLLOW_MODE_LABELS, LOGISTICS_TYPE_LABELS, WATERFALL_LABELS } from './labels.ts'
import type { MatrixCellView } from './matrix.server.ts'
import { QuoteSection } from './quote-editor.tsx'
import { CostWaterfall } from './waterfall.tsx'

/**
 * 商品簇详情的“核算”标签（tasks 2.3 / 3.1）：供应商报价 → 对比矩阵（报价 × 物流方案 × 跟卖方式，
 * 高亮最优）→ 所选组合的成本瀑布。选定组合后线索进入工作台的待决定队列；已决定的线索只读。
 */

type TabData = Awaited<ReturnType<typeof getCostingTab>>
type View = NonNullable<TabData['view']>

const STEPS = [
  ['new', '新线索'],
  ['costing', '核算中'],
  ['pending', '待决定'],
  ['decided', '已决定'],
] as const

const FBA_TYPES = new Set(['amazon-fba'])

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const marginTone = (m: number) =>
  m >= 0.25 ? 'text-success-strong' : m >= 0.1 ? 'text-warning-strong' : 'text-destructive'

/** 选定组合快照（costing_scenario.result）中的成本结果 */
function snapshotResult(result: unknown): CostingResult | null {
  const r = result as { result?: CostingResult } | null
  return r?.result?.status === 'ok' ? r.result : null
}

export function CostingTab({
  slug,
  clusterId,
  leadId,
  onLeadChanged,
}: {
  slug: string
  clusterId: string
  leadId: string | null
  /** 线索状态变化后刷新页面头部（标签旁的状态） */
  onLeadChanged?: () => Promise<void>
}) {
  const [options, setOptions] = useState<MatrixOptions>({})
  const [data, setData] = useState<TabData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [focusKey, setFocusKey] = useState<string | null>(null)

  async function load(next = options) {
    try {
      const fresh = await getCostingTab({ data: { slug, clusterId, leadId, options: next } })
      const changed = data?.view && fresh.view && data.view.lead.status !== fresh.view.lead.status
      setData(fresh)
      if (changed) void onLeadChanged?.()
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '加载失败')
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选项变化时重算
  useEffect(() => {
    void load(options)
  }, [options])

  if (loadError) return <ErrorText>{loadError}</ErrorText>
  if (!data)
    return (
      <div className="grid gap-4" aria-busy="true">
        <div className="h-24 animate-pulse rounded-xl border bg-muted/40" />
        <div className="h-64 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    )

  const view = data.view
  const writable = data.canWrite && (view?.editable ?? true)
  const lockedReason =
    view && !view.editable ? '线索已作出决定，核算已锁定（档案库保留决定时的快照）。' : null

  return (
    <div className="grid min-w-0 gap-4" data-testid="costing-tab">
      {view ? (
        <StatusStrip
          slug={slug}
          view={view}
          writable={writable}
          modes={options.modes ?? view.modes}
          onModes={async (modes, persist) => {
            if (persist && writable && modes.length === 1)
              await setFollowMode({
                data: { slug, leadId: view.lead.id, mode: modes[0] as FollowMode },
              })
            setOptions({ ...options, modes })
          }}
        />
      ) : (
        <p className="rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground">
          该商品簇还没有线索：可以先录入报价，流水线生成线索后即可在这里核算与选定组合。
        </p>
      )}

      <QuoteSection
        slug={slug}
        clusterId={clusterId}
        suppliers={data.suppliers}
        quotes={data.quotes}
        writable={writable}
        lockedReason={lockedReason}
        onChanged={() => load()}
      />

      {view ? (
        <>
          <Matrix
            view={view}
            options={options}
            focusKey={focusKey}
            onFocus={setFocusKey}
            onOptions={setOptions}
          />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <ScenarioPanel
              slug={slug}
              view={view}
              options={options}
              focusKey={focusKey}
              writable={writable}
              onSelected={() => load()}
            />
            {(options.modes ?? view.modes).includes('improved') ? (
              <ImprovementCard slug={slug} view={view} writable={writable} onSaved={() => load()} />
            ) : (
              <InputsCard view={view} />
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

// ---- 状态与跟卖方式 ----

function StatusStrip({
  view,
  writable,
  modes,
  onModes,
}: {
  slug: string
  view: View
  writable: boolean
  modes: FollowMode[]
  onModes: (modes: FollowMode[], persist: boolean) => Promise<void>
}) {
  const status =
    view.lead.status === 'followed' || view.lead.status === 'dropped' ? 'decided' : view.lead.status
  const current = STEPS.findIndex(([k]) => k === status)
  const [busy, setBusy] = useState(false)
  const compare = modes.length > 1
  const choose = async (next: FollowMode[], persist: boolean) => {
    setBusy(true)
    try {
      await onModes(next, persist)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
      <ol className="flex items-center gap-1.5 text-xs" aria-label="核算进度">
        {STEPS.map(([key, label], i) => (
          <li key={key} className="flex items-center gap-1.5">
            {i > 0 ? (
              <span className={cn('h-px w-5', i <= current ? 'bg-primary' : 'bg-border')} />
            ) : null}
            <span
              aria-current={i === current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1',
                i === current
                  ? 'bg-primary text-primary-foreground font-medium'
                  : i < current
                    ? 'bg-primary-soft text-primary'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              <span className="font-mono text-[10px] opacity-80">{i + 1}</span>
              {key === 'decided' && view.lead.status === 'dropped'
                ? '已放弃'
                : key === 'decided' && view.lead.status === 'followed'
                  ? '已跟卖'
                  : label}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">跟卖方式</span>
        <fieldset aria-label="跟卖方式" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
          {(
            [
              [['same-source'], FOLLOW_MODE_LABELS['same-source'], true],
              [['improved'], FOLLOW_MODE_LABELS.improved, true],
              [['same-source', 'improved'], '两种对比', false],
            ] as const
          ).map(([value, label, persist]) => {
            const active = compare ? value.length > 1 : value.length === 1 && modes[0] === value[0]
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                disabled={busy}
                onClick={() => choose([...value], persist)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  active
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            )
          })}
        </fieldset>
        {!writable ? null : (
          <span className="text-[11px] text-muted-foreground">
            线索默认：{FOLLOW_MODE_LABELS[view.lead.followMode]}
          </span>
        )}
      </div>
    </section>
  )
}

// ---- 矩阵 ----

function MatrixToolbar({
  view,
  options,
  onOptions,
}: {
  view: View
  options: MatrixOptions
  onOptions: (next: MatrixOptions) => void
}) {
  const [qty, setQty] = useState(String(view.plannedQty))
  const [price, setPrice] = useState(
    options.salePriceMinor ? moneyInput(options.salePriceMinor) : '',
  )
  const [attrs, setAttrs] = useState((options.attributes ?? []).join(', '))
  const [fba, setFba] = useState(options.fbaFeeMinor != null ? moneyInput(options.fbaFeeMinor) : '')
  const [error, setError] = useState('')
  const hasFba = view.profiles.some((p) => FBA_TYPES.has(p.type))
  const currency = view.salePrice?.currency ?? view.competitorMedian?.currency ?? 'USD'

  function apply() {
    const q = parseNumber(qty)
    const p = parseMoney(price)
    const f = parseMoney(fba)
    if (q === null || Number.isNaN(q) || !Number.isInteger(q) || q <= 0)
      return setError('计划数量须为正整数')
    if (Number.isNaN(p) || (p !== null && p <= 0)) return setError('售价格式不正确')
    if (Number.isNaN(f)) return setError('FBA 配送费格式不正确')
    setError('')
    const attributes = attrs
      .split(/[,，、\s]+/)
      .map((a) => a.trim())
      .filter(Boolean)
    onOptions({
      ...options,
      plannedQty: q,
      ...(p !== null ? { salePriceMinor: p } : { salePriceMinor: undefined }),
      ...(attributes.length ? { attributes } : { attributes: undefined }),
      ...(f !== null ? { fbaFeeMinor: f } : { fbaFeeMinor: undefined }),
    })
  }

  return (
    <form
      aria-label="核算输入"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      <Field label="计划数量（件）" className="w-32">
        {(id) => (
          <Input
            id={id}
            className="h-8"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        )}
      </Field>
      <Field label={`售价（${currency}）`} className="w-40">
        {(id) => (
          <Input
            id={id}
            className="h-8"
            inputMode="decimal"
            placeholder={
              view.competitorMedian ? moneyInput(view.competitorMedian.amountMinor) : '无竞品价格'
            }
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        )}
      </Field>
      <Field label="商品属性（比对禁运）" className="w-48">
        {(id) => (
          <Input
            id={id}
            className="h-8"
            placeholder="如 battery, liquid"
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
          />
        )}
      </Field>
      {hasFba ? (
        <Field label={`FBA 配送费（费率表，${currency}）`} className="w-44">
          {(id) => (
            <Input
              id={id}
              className="h-8"
              inputMode="decimal"
              value={fba}
              onChange={(e) => setFba(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Button type="submit" size="sm" variant="outline">
        重新计算
      </Button>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </form>
  )
}

function Chip({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]',
        tone === 'warning'
          ? 'border-warning/30 bg-warning-soft text-warning-strong'
          : 'bg-muted/50 text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function SourcesLine({ view }: { view: View }) {
  const median = view.competitorMedian
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="matrix-sources">
      {view.salePrice?.source === 'manual' ? (
        <Chip>
          售价已手动设为 {formatMoney(view.salePrice.amountMinor, view.salePrice.currency)}
        </Chip>
      ) : null}
      {median ? (
        <Chip>
          竞品中位价 {formatMoney(median.amountMinor, median.currency)} · {median.sampleSize} 个成员
        </Chip>
      ) : (
        <Chip tone="warning">无竞品价格，请手动填写售价</Chip>
      )}
      {view.fx.length
        ? view.fx.map((r) => (
            <Chip key={r.pair}>
              汇率 {r.pair} {r.rate} · {r.observedOn} ·{' '}
              {r.sourceId === 'manual' ? '手填' : r.sourceId}
            </Chip>
          ))
        : null}
      {view.node ? (
        <Chip>
          节点 {view.node.name} · {view.node.saleStartDate} 起卖
        </Chip>
      ) : (
        <Chip tone="warning">方向未关联节点，不算最晚决定日</Chip>
      )}
      <Chip>
        提前期默认：上架准备 {view.leadTimes.listingPrepDays} 天 · 采购{' '}
        {view.leadTimes.procurementDays} 天
        {view.platform === 'amazon' ? ` · FBA 入库 ${view.leadTimes.fbaInboundDays ?? 0} 天` : ''}
      </Chip>
    </div>
  )
}

function MatrixCellBox({
  cell,
  selectedKey,
  focused,
  onFocus,
}: {
  cell: MatrixCellView
  selectedKey: string | null
  focused: boolean
  onFocus: () => void
}) {
  const r = cell.result
  const selected = cell.key === selectedKey
  return (
    <button
      type="button"
      onClick={onFocus}
      aria-pressed={focused}
      data-testid="matrix-cell"
      data-best={cell.best || undefined}
      data-available={cell.available}
      className={cn(
        'group relative grid h-full min-h-[92px] w-full content-start gap-1 rounded-lg border p-2.5 text-left transition-colors',
        cell.best
          ? 'border-success bg-success-soft/60 ring-1 ring-success/40'
          : cell.available
            ? 'bg-background hover:border-primary/50'
            : 'border-dashed bg-muted/30',
        focused && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-1">
        {r ? (
          <span
            className={cn(
              'font-mono text-lg font-semibold leading-none',
              cell.available ? marginTone(r.grossMargin) : 'text-muted-foreground',
            )}
          >
            {pct(r.grossMargin)}
          </span>
        ) : (
          <span className="font-mono text-lg leading-none text-muted-foreground">—</span>
        )}
        <span className="flex flex-wrap justify-end gap-1">
          {cell.best ? <Tag tone="success">最优</Tag> : null}
          {selected ? <Tag tone="info">已选定</Tag> : null}
        </span>
      </div>
      {r ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-4 text-muted-foreground">
          <dt>落地</dt>
          <dd className="text-right font-mono text-foreground">
            {formatMoney(r.landedCostMinor, null)}
          </dd>
          <dt>保本</dt>
          <dd className="text-right font-mono text-foreground">
            {formatMoney(r.breakEvenMinor, null)}
          </dd>
        </dl>
      ) : null}
      {cell.deadline ? (
        <span className="text-[11px] text-muted-foreground">
          最晚决定 <span className="font-mono text-foreground">{cell.deadline.slice(5)}</span>
        </span>
      ) : null}
      {cell.issues.length ? (
        <span className="flex flex-wrap gap-1">
          {cell.issues.map((i) => (
            <span
              key={i}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] leading-4',
                i.startsWith('缺少')
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-destructive-soft text-destructive',
              )}
            >
              {i}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  )
}

function Matrix({
  view,
  options,
  focusKey,
  onFocus,
  onOptions,
}: {
  view: View
  options: MatrixOptions
  focusKey: string | null
  onFocus: (key: string) => void
  onOptions: (next: MatrixOptions) => void
}) {
  const modes = options.modes ?? view.modes
  const cellAt = useMemo(() => new Map(view.cells.map((c) => [c.key, c])), [view.cells])
  const currency = view.salePrice?.currency ?? 'USD'
  const effectiveFocus = focusKey ?? view.selected?.key ?? view.bestKey
  const empty = view.quotes.length === 0 || view.profiles.length === 0

  return (
    <section
      className="grid min-w-0 gap-3 rounded-xl border bg-card p-4"
      aria-label="核算矩阵"
      data-testid="costing-matrix"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-sm font-semibold">核算矩阵</h2>
          <p className="text-xs text-muted-foreground">
            报价 × {view.platform === 'amazon' ? 'Amazon' : 'eBay'} 物流方案 × 跟卖方式。每格为售价{' '}
            {currency} 下的毛利率、单件落地成本与保本价；
            绿色为毛利率最高且来得及的组合，点一格查看成本瀑布。
          </p>
        </div>
        {view.bestKey ? null : !empty ? <Tag tone="warning">没有可用组合</Tag> : null}
      </div>
      <MatrixToolbar
        key={JSON.stringify(options)}
        view={view}
        options={options}
        onOptions={onOptions}
      />
      <SourcesLine view={view} />
      {empty ? (
        <EmptyState
          title={
            view.quotes.length === 0
              ? '先录入供应商报价'
              : `还没有 ${view.platform === 'amazon' ? 'Amazon' : 'eBay'} 物流方案`
          }
        >
          {view.quotes.length === 0
            ? '矩阵按 报价 × 物流方案 × 跟卖方式 计算，录入至少一条报价后显示。'
            : '在“设置 · 物流方案”中为该平台添加头程 / 直发 / 海外仓方案。'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-1.5 text-[13px]">
            <thead>
              <tr>
                <th className="w-[220px] min-w-[180px] px-1 text-left align-bottom text-xs font-medium text-muted-foreground">
                  报价（计划 {view.plannedQty} 件）
                </th>
                {view.profiles.map((p) => (
                  <th key={p.id} colSpan={modes.length} className="px-1 text-left align-bottom">
                    <div className="grid gap-0.5">
                      <span className="text-[13px] font-medium">{p.name}</span>
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {LOGISTICS_TYPE_LABELS[p.type]} · {p.transitDays} 天
                        {p.bannedAttributes.length ? ` · 禁运 ${p.bannedAttributes.join('/')}` : ''}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
              {modes.length > 1 ? (
                <tr>
                  <th />
                  {view.profiles.flatMap((p) =>
                    modes.map((m) => (
                      <th
                        key={`${p.id}-${m}`}
                        className="px-1 text-left text-[11px] font-normal text-muted-foreground"
                      >
                        {FOLLOW_MODE_LABELS[m]}
                      </th>
                    )),
                  )}
                </tr>
              ) : null}
            </thead>
            <tbody>
              {view.quotes.map((q) => (
                <tr key={q.id}>
                  <th scope="row" className="px-1 text-left align-top font-normal">
                    <div className="grid gap-0.5 pt-1">
                      <span className="font-medium">{q.supplierName}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {q.tiers
                          .map((t) => `${t.minQty}+ ${formatMoney(t.unitPriceMinor, null)}`)
                          .join(' / ')}{' '}
                        {q.currency}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        MOQ {q.moqEffective} · {q.confidence === 'confirmed' ? '已确认' : '公开价'}
                      </span>
                    </div>
                  </th>
                  {view.profiles.flatMap((p) =>
                    modes.map((m) => {
                      const key = `${q.id}:${p.id}:${m}`
                      const cell = cellAt.get(key)
                      return (
                        <td key={key} className="min-w-[150px] align-top">
                          {cell ? (
                            <MatrixCellBox
                              cell={cell}
                              selectedKey={view.selected?.key ?? null}
                              focused={effectiveFocus === key}
                              onFocus={() => onFocus(key)}
                            />
                          ) : null}
                        </td>
                      )
                    }),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---- 所选组合：成本瀑布与选定 ----

function ScenarioPanel({
  slug,
  view,
  options,
  focusKey,
  writable,
  onSelected,
}: {
  slug: string
  view: View
  options: MatrixOptions
  focusKey: string | null
  writable: boolean
  onSelected: () => Promise<void>
}) {
  const action = useAction(onSelected)
  const key = focusKey ?? view.selected?.key ?? view.bestKey
  const cell = key ? view.cells.find((c) => c.key === key) : undefined
  const isSelected = key !== null && key === view.selected?.key
  // 已选定组合优先显示选定时的快照（决定后矩阵可能已随参数变化）
  const snapshot = isSelected ? snapshotResult(view.selected?.result) : null
  const result = (isSelected && (snapshot || !cell?.result) ? snapshot : cell?.result) ?? null
  const quote = view.quotes.find((q) => q.id === (cell?.quoteId ?? view.selected?.quoteId))
  const profile = view.profiles.find((p) => p.id === (cell?.profileId ?? view.selected?.profileId))
  const mode = (cell?.mode ?? view.selected?.mode) as FollowMode | undefined

  return (
    <section
      className="grid content-start gap-3 rounded-xl border bg-card p-4"
      aria-label="成本瀑布"
      data-testid="scenario-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-sm font-semibold">
            成本瀑布
            {isSelected ? (
              <Tag tone="info" className="ml-2 align-middle">
                已选定
              </Tag>
            ) : cell?.best ? (
              <Tag tone="success" className="ml-2 align-middle">
                最优
              </Tag>
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground">
            {quote && profile && mode
              ? `${quote.supplierName} × ${profile.name} × ${FOLLOW_MODE_LABELS[mode]}`
              : '在矩阵中点一格查看'}
            {isSelected && view.selected
              ? ` · 选定于 ${new Date(view.selected.computedAt).toLocaleDateString('sv-SE')}`
              : ''}
          </p>
        </div>
        {writable && cell && !isSelected ? (
          <Button
            size="sm"
            disabled={action.busy || !cell.available}
            title={cell.available ? undefined : cell.issues.join('；')}
            onClick={() =>
              action.run(() =>
                selectScenario({
                  data: {
                    slug,
                    leadId: view.lead.id,
                    pick: { quoteId: cell.quoteId, profileId: cell.profileId, mode: cell.mode },
                    options: { ...options, plannedQty: view.plannedQty },
                  },
                }),
              )
            }
          >
            {action.busy ? '选定中…' : '选定此组合，进入待决定'}
          </Button>
        ) : null}
      </div>
      <ErrorText>{action.error}</ErrorText>
      {result ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <CostWaterfall
            salePriceMinor={result.salePriceMinor}
            steps={result.waterfall}
            currency={result.currency}
          />
          <Breakdown
            result={result}
            view={view}
            certainty={isSelected && snapshot ? null : (cell?.certainty ?? null)}
          />
        </div>
      ) : cell ? (
        <EmptyState title="该组合无法计算">{cell.issues.join('；')}</EmptyState>
      ) : (
        <EmptyState title="暂无可展示的组合">录入报价并配置物流方案、成本参数后显示。</EmptyState>
      )}
      {cell && !cell.available && result ? (
        <p className="text-xs text-destructive">不可选定：{cell.issues.join('；')}</p>
      ) : null}
    </section>
  )
}

function Breakdown({
  result,
  view,
  certainty,
}: {
  result: CostingResult
  view: View
  certainty: number | null
}) {
  const price = result.salePriceMinor
  const share = (v: number) => (price > 0 ? `${((v / price) * 100).toFixed(1)}%` : '—')
  const sources = view.costParams.sources
  const defaultTag = (k: keyof typeof sources) =>
    sources[k] === 'platform-default' ? <Tag className="ml-1">平台默认</Tag> : null
  return (
    <div className="grid content-start gap-3 text-[13px]">
      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            ['毛利率', pct(result.grossMargin), marginTone(result.grossMargin)],
            [
              '净利润',
              formatMoney(result.netProfitMinor, null),
              result.netProfitMinor >= 0 ? 'text-success-strong' : 'text-destructive',
            ],
            ['保本价', formatMoney(result.breakEvenMinor, null), ''],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="grid gap-0.5 rounded-lg bg-muted/40 px-2.5 py-2">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className={cn('font-mono text-base font-semibold', tone)}>{value}</dd>
          </div>
        ))}
      </dl>
      <table className="w-full text-[12px]">
        <tbody>
          <tr className="border-b">
            <td className="py-1 text-muted-foreground">售价</td>
            <td className="py-1 text-right font-mono">{formatMoney(price, result.currency)}</td>
            <td className="w-14 py-1 text-right font-mono text-muted-foreground">100%</td>
          </tr>
          {result.waterfall
            .filter((s) => s.key !== 'netProfit')
            .map((s) => (
              <tr key={s.key} className="border-b border-dashed">
                <td className="py-1 text-muted-foreground">
                  {WATERFALL_LABELS[s.key]}
                  {s.key === 'platformFee' ? defaultTag('commissionRate') : null}
                  {s.key === 'ads' ? defaultTag('adRate') : null}
                  {s.key === 'returns' ? defaultTag('returnRate') : null}
                </td>
                <td className="py-1 text-right font-mono">
                  {s.amountMinor === 0 ? '' : '-'}
                  {formatMoney(s.amountMinor, null)}
                </td>
                <td className="py-1 text-right font-mono text-muted-foreground">
                  {share(s.amountMinor)}
                </td>
              </tr>
            ))}
          <tr>
            <td className="py-1 font-medium">落地成本</td>
            <td className="py-1 text-right font-mono font-medium">
              {formatMoney(result.landedCostMinor, null)}
            </td>
            <td className="py-1 text-right font-mono text-muted-foreground">
              {share(result.landedCostMinor)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span>阶梯单价 {formatMoney(result.unitPrice.amountMinor, result.unitPrice.currency)}</span>
        {result.chargeableWeightG ? (
          <span>· 计费重量 {(result.chargeableWeightG / 1000).toFixed(2)} kg</span>
        ) : null}
        {result.dimensionsMissing ? (
          <span className="text-warning-strong">· 缺尺寸，已按实重计费</span>
        ) : null}
        {result.fulfillmentSource === 'rate-table' ? <span>· FBA 配送费来自费率表</span> : null}
        {certainty != null ? <span>· 成本确定性 {Math.round(certainty * 100)}%</span> : null}
      </div>
    </div>
  )
}

// ---- 右侧：微改良参数 / 输入说明 ----

function InputsCard({ view }: { view: View }) {
  const p = view.costParams.values
  const s = view.costParams.sources
  const rows: [string, string, string][] = [
    ['佣金率', formatRate(p.commissionRate), s.commissionRate],
    ['固定费', formatMoney(p.fixedFeeMinor, null), s.fixedFeeMinor],
    ['广告率', formatRate(p.adRate), s.adRate],
    ['退货预留率', formatRate(p.returnRate), s.returnRate],
    ['月仓储费', formatMoney(p.storageMonthlyMinor, null), s.storageMonthlyMinor],
    ['库存月数', p.storageMonths == null ? '—' : String(p.storageMonths), s.storageMonths],
    ...(view.platform === 'amazon'
      ? ([['入库配置费', formatMoney(p.inboundFeeMinor, null), s.inboundFeeMinor]] as [
          string,
          string,
          string,
        ][])
      : []),
  ]
  return (
    <section
      className="grid content-start gap-3 rounded-xl border bg-card p-4"
      aria-label="成本参数"
    >
      <div className="grid gap-0.5">
        <h2 className="text-sm font-semibold">成本参数</h2>
        <p className="text-xs text-muted-foreground">
          按平台 × 类目取值，类目未配置的项回退到平台默认；在“设置 · 成本参数”中修改。
        </p>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map(([label, value, source]) => (
            <tr key={label} className="border-b border-dashed last:border-0">
              <td className="py-1.5 text-muted-foreground">{label}</td>
              <td className="py-1.5 text-right font-mono">{value}</td>
              <td className="w-20 py-1.5 text-right">
                {source === 'category' ? (
                  <Tag tone="info">类目</Tag>
                ) : source === 'platform-default' ? (
                  <Tag>平台默认</Tag>
                ) : (
                  <Tag tone="warning">未配置</Tag>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ImprovementCard({
  slug,
  view,
  writable,
  onSaved,
}: {
  slug: string
  view: View
  writable: boolean
  onSaved: () => Promise<void>
}) {
  const value = view.lead.improvement
  const [rate, setRate] = useState(percentInput(value?.unitSurchargeRate))
  const [tooling, setTooling] = useState(moneyInput(value?.toolingCost?.amountMinor))
  const [toolingCurrency, setToolingCurrency] = useState(value?.toolingCost?.currency ?? 'CNY')
  const [sampleDays, setSampleDays] = useState(
    value?.sampleDays == null ? '' : String(value.sampleDays),
  )
  const [note, setNote] = useState(value?.note ?? '')
  const action = useAction(onSaved)
  return (
    <form
      aria-label="微改良参数"
      className="grid content-start gap-3 rounded-xl border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault()
        const r = parsePercent(rate)
        const t = parseMoney(tooling)
        const d = parseNumber(sampleDays)
        if ([r, t, d].some((v) => Number.isNaN(v))) {
          action.setError('数字格式不正确')
          return
        }
        action.run(() =>
          saveImprovement({
            data: {
              slug,
              leadId: view.lead.id,
              improvement: {
                unitSurchargeRate: r,
                toolingCost: t === null ? null : { amountMinor: t, currency: toolingCurrency },
                sampleDays: d,
                note: note || null,
              },
            },
          }),
        )
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-sm font-semibold">微改良参数</h2>
          <p className="text-xs text-muted-foreground">
            单价加成计入采购，一次性改款费按计划数量分摊，打样天数计入最晚决定日。
          </p>
        </div>
        {view.lead.improvementReady ? (
          <Tag tone="success">可计算</Tag>
        ) : (
          <Tag tone="warning">待补参数</Tag>
        )}
      </div>
      <Field label="改良点">
        {(id) => (
          <Input
            id={id}
            value={note}
            disabled={!writable}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：底部加防滑硅胶圈"
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="单价加成（%）">
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              disabled={!writable}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-1">
          <label htmlFor="tooling-cost" className="text-xs font-medium text-muted-foreground">
            改款费
          </label>
          <div className="flex gap-1">
            <Input
              id="tooling-cost"
              inputMode="decimal"
              disabled={!writable}
              value={tooling}
              onChange={(e) => setTooling(e.target.value)}
            />
            <select
              aria-label="改款费币种"
              className={cn(controlClass, 'w-20')}
              disabled={!writable}
              value={toolingCurrency}
              onChange={(e) => setToolingCurrency(e.target.value)}
            >
              {['CNY', 'USD'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <Field label="打样天数">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              disabled={!writable}
              value={sampleDays}
              onChange={(e) => setSampleDays(e.target.value)}
            />
          )}
        </Field>
      </div>
      <ErrorText>{action.error}</ErrorText>
      {writable ? (
        <Button type="submit" size="sm" className="w-fit" disabled={action.busy}>
          {action.busy ? '保存中…' : '保存微改良参数'}
        </Button>
      ) : null}
    </form>
  )
}
