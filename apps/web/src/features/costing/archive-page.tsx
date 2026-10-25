import { Button, Input, Tag } from '@product-res/ui'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { type FormEvent, Fragment, type ReactNode, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { formatTime, Section, SimpleTable } from '../data-center/shared.tsx'
import { marketplaceLabel } from '../follow/marketplaces.ts'
import {
  canTransfer,
  SelectBox,
  TransferBar,
  useTransferSelection,
} from '../transfer/transfer-actions.tsx'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import type { ArchiveRow } from './archive.server.ts'
import {
  type ArchiveSearch,
  type getArchivePage,
  getDecisionDetail,
  saveFollowOutcome,
} from './decisions.functions.ts'
import { formatMoney, formatRate, moneyInput, parseMoney } from './format.ts'
import { ScoreCell } from './home-page.tsx'
import { DROP_REASON_LABELS, FOLLOW_MODE_LABELS, PLATFORM_LABELS } from './labels.ts'

export type ArchiveData = Awaited<ReturnType<typeof getArchivePage>>
type Detail = Awaited<ReturnType<typeof getDecisionDetail>>

/** 选品档案库（specs/selection-archive）：已决定线索、决定快照、30 天回看与品类报告归档 */
export function ArchivePage({
  slug,
  data,
  search,
}: {
  slug: string
  data: ArchiveData
  search: ArchiveSearch
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const selection = useTransferSelection(data.rows.map((r) => r.id))
  const selectable = canTransfer(data.transfer)
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">选品档案库</h1>
        <p className="text-[13px] text-muted-foreground">
          这里显示决定当时保存的分数、置信度、权重版本与所选组合，不随线索重算变化。跟卖决定在计划上架日
          30 天后提醒回看。
        </p>
      </div>
      <Filters slug={slug} search={search} directions={data.directions} />
      {data.pendingReviews > 0 ? (
        <p
          role="status"
          className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong"
        >
          有 {data.pendingReviews} 条跟卖记录待回看：请录入实际销量与售价。
        </p>
      ) : null}
      {selectable ? (
        <TransferBar
          slug={slug}
          root="decision"
          availability={data.transfer}
          selection={selection}
        />
      ) : null}
      <Section title={`已决定线索（${data.rows.length}${data.truncated ? '+' : ''}）`}>
        {data.rows.length === 0 ? (
          <EmptyState title="还没有已决定的线索">
            在工作台的待决定队列中作出跟卖或放弃决定。
          </EmptyState>
        ) : (
          <SimpleTable
            head={[
              ...(selectable ? [m.transfer_actions_col_select()] : []),
              '决定时间',
              '商品簇',
              '方向 · 平台',
              '决定',
              '分数（决定时）',
              '所选组合',
              '回看',
              '',
            ]}
          >
            {data.rows.map((r) => (
              <Fragment key={r.id}>
                <tr data-testid="archive-row">
                  {selectable ? (
                    <td className="px-3 py-2">
                      <SelectBox
                        checked={selection.has(r.id)}
                        onChange={(on) => selection.toggle(r.id, on)}
                        label={m.transfer_actions_select_item({ name: r.clusterName })}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{formatTime(r.decidedAt)}</td>
                  <td className="px-3 py-2 font-medium">{r.clusterName}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{r.directionName}</div>
                    <div className="text-muted-foreground">
                      {r.marketplace ? marketplaceLabel(r.marketplace) : '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <KindCell row={r} />
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={r.score} grade={r.grade} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.scenario ? `毛利率 ${formatRate(r.scenario.grossMargin)}` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <ReviewTag row={r} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                    >
                      {openId === r.id ? '收起' : '查看快照'}
                    </Button>
                  </td>
                </tr>
                {openId === r.id ? (
                  <tr>
                    <td colSpan={selectable ? 9 : 8} className="bg-muted/30 px-3 py-3">
                      <DetailPanel slug={slug} id={r.id} canWrite={data.canWrite} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </SimpleTable>
        )}
      </Section>
      <Section title="品类研究报告">
        {data.studies.length === 0 ? (
          <EmptyState title="暂无品类研究报告">
            在“品类洞察”中归档的研究报告会出现在这里。
          </EmptyState>
        ) : (
          <SimpleTable head={['研究名称', '站点', '最近快照', '报告']}>
            {data.studies.map((study) => (
              <tr key={study.id} data-testid="archived-study-row">
                <td className="px-3 py-2 font-medium">{study.name}</td>
                <td className="px-3 py-2">{marketplaceLabel(study.marketplace)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                  {study.latestSnapshotAt ? formatTime(study.latestSnapshotAt) : '暂无快照'}
                </td>
                <td className="px-3 py-2">
                  <Link
                    to="/app/$slug/category/$studyId"
                    params={{ slug, studyId: study.id }}
                    className="text-primary hover:underline"
                  >
                    查看报告
                  </Link>
                </td>
              </tr>
            ))}
          </SimpleTable>
        )}
      </Section>
    </div>
  )
}

function KindCell({ row }: { row: ArchiveRow }) {
  if (row.kind === 'follow')
    return (
      <div className="grid gap-0.5 text-xs">
        <Tag tone="success" className="w-fit">
          跟卖
        </Tag>
        <span className="text-muted-foreground">
          首批 {row.firstBatchQty ?? '—'} · {formatMoney(row.targetPriceMinor, row.currency)}
        </span>
      </div>
    )
  return (
    <div className="grid gap-0.5 text-xs">
      <Tag tone="neutral" className="w-fit">
        放弃
      </Tag>
      <span className="text-muted-foreground">
        {row.dropReason ? DROP_REASON_LABELS[row.dropReason] : '—'}
        {row.dropNote ? `：${row.dropNote}` : ''}
      </span>
    </div>
  )
}

function ReviewTag({ row }: { row: ArchiveRow }) {
  const r = row.review
  if (r.status === 'n/a') return <span className="text-muted-foreground">—</span>
  if (r.status === 'reviewed') return <Tag tone="success">已回看</Tag>
  if (r.status === 'due')
    return (
      <Tag tone="warning" data-review="due">
        待回看
      </Tag>
    )
  return <span className="text-xs text-muted-foreground">{r.dueOn} 回看</span>
}

function Filters({
  slug,
  search,
  directions,
}: {
  slug: string
  search: ArchiveSearch
  directions: ArchiveData['directions']
}) {
  const navigate = useNavigate()
  const set = (patch: Partial<ArchiveSearch>) => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries({ ...search, ...patch })) if (v) next[k] = v
    void navigate({ to: '/app/$slug/archive', params: { slug }, search: next })
  }
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
      <Field label="平台" className="w-32">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={search.platform ?? ''}
            onChange={(e) =>
              set({ platform: (e.target.value || undefined) as ArchiveSearch['platform'] })
            }
          >
            <option value="">全部</option>
            <option value="amazon">{PLATFORM_LABELS.amazon}</option>
            <option value="ebay">{PLATFORM_LABELS.ebay}</option>
          </select>
        )}
      </Field>
      <Field label="方向" className="w-44">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={search.directionId ?? ''}
            onChange={(e) => set({ directionId: e.target.value || undefined })}
          >
            <option value="">全部</option>
            {directions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="决定" className="w-28">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={search.kind ?? ''}
            onChange={(e) => set({ kind: (e.target.value || undefined) as ArchiveSearch['kind'] })}
          >
            <option value="">全部</option>
            <option value="follow">跟卖</option>
            <option value="drop">放弃</option>
          </select>
        )}
      </Field>
      <Field label="决定日期从" className="w-40">
        {(id) => (
          <Input
            id={id}
            type="date"
            className="h-8 text-[13px]"
            value={search.from ?? ''}
            onChange={(e) => set({ from: e.target.value || undefined })}
          />
        )}
      </Field>
      <Field label="到" className="w-40">
        {(id) => (
          <Input
            id={id}
            type="date"
            className="h-8 text-[13px]"
            value={search.to ?? ''}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        )}
      </Field>
    </div>
  )
}

function DetailPanel({ slug, id, canWrite }: { slug: string; id: string; canWrite: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  // 展开时读取完整快照（含 cluster_signal 输入引用）
  useEffect(() => {
    let active = true
    getDecisionDetail({ data: { slug, id } })
      .then((d) => active && setDetail(d))
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : '读取失败'))
    return () => {
      active = false
    }
  }, [slug, id])
  if (error) return <ErrorText>{error}</ErrorText>
  if (!detail) return <p className="text-xs text-muted-foreground">加载中…</p>
  const snap = detail.snapshot
  const sc = detail.scenario
  return (
    <div className="grid gap-3 text-[13px]" data-testid="decision-snapshot">
      <div className="grid gap-2 md:grid-cols-4">
        <Fact label="综合分">{snap.lead.score == null ? '—' : snap.lead.score}</Fact>
        <Fact label="置信度">{formatRate(snap.lead.confidence, 0)}</Fact>
        <Fact label="权重版本">v{snap.lead.settingVersion}</Fact>
        <Fact label="线索日期">{snap.lead.leadOn}</Fact>
      </div>
      {snap.scenario && sc ? (
        <div className="grid gap-2 md:grid-cols-4">
          <Fact label="跟卖方式">
            {FOLLOW_MODE_LABELS[snap.scenario.mode as keyof typeof FOLLOW_MODE_LABELS] ??
              snap.scenario.mode}
          </Fact>
          <Fact label="计划数量">{snap.scenario.plannedQty}</Fact>
          <Fact label="售价">{formatMoney(sc.salePriceMinor, sc.currency)}</Fact>
          <Fact label="落地成本">{formatMoney(sc.landedCostMinor, sc.currency)}</Fact>
          <Fact label="毛利率">{formatRate(sc.grossMargin)}</Fact>
          <Fact label="保本价">{formatMoney(sc.breakEvenMinor, sc.currency)}</Fact>
          <Fact label="最晚决定日">{sc.deadline ?? snap.lead.latestDecisionOn ?? '—'}</Fact>
          <Fact label="核算时间">{formatTime(snap.scenario.computedAt)}</Fact>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">决定时没有选定的核算组合。</p>
      )}
      {snap.signals.length > 0 ? (
        <div className="text-xs">
          <span className="text-muted-foreground">维度信号（{snap.signals[0]?.observedOn}）：</span>
          {snap.signals
            .map((s) => `${s.dimension} ${s.score == null ? '缺失' : Math.round(s.score)}`)
            .join('，')}
        </div>
      ) : null}
      {detail.kind === 'follow' ? (
        <OutcomeBlock
          slug={slug}
          detail={detail}
          canWrite={canWrite}
          onSaved={(next) => setDetail(next)}
        />
      ) : null}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  )
}

function OutcomeBlock({
  slug,
  detail,
  canWrite,
  onSaved,
}: {
  slug: string
  detail: Detail
  canWrite: boolean
  onSaved: (next: Detail) => void
}) {
  const reviewed = detail.review.status === 'reviewed' ? detail.review.outcome : null
  const [units, setUnits] = useState(reviewed ? String(reviewed.actualUnits) : '')
  const [price, setPrice] = useState(moneyInput(reviewed?.actualPriceMinor))
  const [note, setNote] = useState(reviewed?.note ?? '')
  const router = useRouter()
  // 保存后刷新列表中的“待回看 / 已回看”标记
  const { busy, error, setError, run } = useAction(() => router.invalidate())

  async function submit(e: FormEvent) {
    e.preventDefault()
    const actualUnits = Number(units)
    const actualPriceMinor = parseMoney(price)
    if (!units.trim() || !Number.isInteger(actualUnits) || actualUnits < 0)
      return setError('实际销量为非负整数')
    if (actualPriceMinor != null && (Number.isNaN(actualPriceMinor) || actualPriceMinor <= 0))
      return setError('实际售价格式不正确')
    await run(async () =>
      onSaved(
        await saveFollowOutcome({
          data: {
            slug,
            decisionId: detail.id,
            outcome: { actualUnits, actualPriceMinor, note: note || null },
          },
        }),
      ),
    )
  }

  const c = reviewed?.comparison
  return (
    <div className="grid gap-2 rounded-md border bg-background p-3">
      <div className="text-xs font-medium">
        30 天回看
        {detail.review.status !== 'n/a' ? (
          <span className="ml-2 font-normal text-muted-foreground">
            到期日 {detail.review.dueOn}
          </span>
        ) : null}
      </div>
      {c ? (
        <SimpleTable head={['', '当初预测', '实际']}>
          <tr>
            <td className="px-3 py-1.5 text-muted-foreground">销量</td>
            <td className="px-3 py-1.5">首批 {c.firstBatchQty ?? '—'}</td>
            <td className="px-3 py-1.5">
              {c.actualUnits}（售罄率 {formatRate(c.sellThrough, 0)}）
            </td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 text-muted-foreground">售价</td>
            <td className="px-3 py-1.5">{formatMoney(c.targetPriceMinor, detail.currency)}</td>
            <td className="px-3 py-1.5">
              {formatMoney(c.actualPriceMinor, detail.currency)}
              {c.priceDeltaRate != null ? `（${formatRate(c.priceDeltaRate)}）` : ''}
            </td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 text-muted-foreground">毛利率</td>
            <td className="px-3 py-1.5">{formatRate(c.predictedMargin)}</td>
            <td className="px-3 py-1.5">
              {c.estimatedMargin == null ? '—' : `${formatRate(c.estimatedMargin)}（估算）`}
            </td>
          </tr>
        </SimpleTable>
      ) : null}
      {canWrite ? (
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="回看录入">
          <Field label="实际销量" className="w-32">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                className="h-8 text-[13px]"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              />
            )}
          </Field>
          <Field label={`实际售价（${detail.currency ?? '售价币种'}）`} className="w-40">
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="h-8 text-[13px]"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            )}
          </Field>
          <Field label="备注" className="min-w-48 flex-1">
            {(id) => (
              <Input
                id={id}
                className="h-8 text-[13px]"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" size="sm" disabled={busy}>
            {reviewed ? '更新回看' : '保存回看'}
          </Button>
        </form>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
