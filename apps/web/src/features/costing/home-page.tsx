import { Button, cn, GRADE_LABELS, Input, StatCard, Tag, type Tone } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { type FormEvent, Fragment, useState } from 'react'
import { formatNumber, Section, SimpleTable } from '../data-center/shared.tsx'
import { marketplaceLabel } from '../follow/marketplaces.ts'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import type { DeadlineTone } from './dates.ts'
import { decideLead, getWorkbenchHome } from './decisions.functions.ts'
import type { QueueRow } from './decisions.server.ts'
import { formatMoney, formatRate, moneyInput, parseMoney } from './format.ts'
import { DROP_REASON_LABELS, DROP_REASONS, type DropReason, FOLLOW_MODE_LABELS } from './labels.ts'

export type WorkbenchHomeData = Awaited<ReturnType<typeof getWorkbenchHome>>

const TONES: Record<DeadlineTone, Tone> = {
  overdue: 'danger',
  soon: 'warning',
  normal: 'neutral',
  none: 'neutral',
}

function daysLeft(deadline: string, today: string) {
  return Math.round((Date.parse(deadline) - Date.parse(today)) / 86_400_000)
}

export function DeadlineTag({
  deadline,
  tone,
  today,
}: {
  deadline: string | null
  tone: DeadlineTone
  today: string
}) {
  if (!deadline) return <span className="text-muted-foreground">未计算</span>
  const left = daysLeft(deadline, today)
  const text = left < 0 ? `已过 ${-left} 天` : left === 0 ? '今天' : `${left} 天后`
  return (
    <div className="grid gap-0.5">
      <span className="font-mono text-xs">{deadline}</span>
      <Tag tone={TONES[tone]} data-deadline-tone={tone} className="w-fit">
        {text}
      </Tag>
    </div>
  )
}

/** 工作台首页（docs/plan/selection-workbench.md §9、§12）：KPI、待决定队列、节点倒计时 */
export function WorkbenchHome({ slug, initial }: { slug: string; initial: WorkbenchHomeData }) {
  const [data, setData] = useState(initial)
  const reload = async () => setData(await getWorkbenchHome({ data: { slug } }))
  const { kpi } = data
  const quota = kpi.quota
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">工作台</h1>
        <p className="text-[13px] text-muted-foreground">
          核算完成、选定组合的线索进入待决定队列，按最晚决定日处理；7 天内标橙，已过期标红。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="候选线索"
          value={formatNumber(kpi.candidates)}
          hint="未核算或核算中的商品簇"
        />
        <StatCard label="待决定" value={formatNumber(kpi.pending)} hint="已选定核算组合" />
        <StatCard label="本周已决定" value={formatNumber(kpi.decidedThisWeek)} hint="周一起算" />
        <StatCard
          label="数据源今日额度"
          value={quota ? formatRate(quota.top.ratio, 0) : null}
          hint={
            quota
              ? `${quota.top.sourceId} 已用 ${formatNumber(quota.top.used)} / ${formatNumber(quota.top.cap)} ${quota.top.unit}${quota.sources > 1 ? `，共 ${quota.sources} 个数据源` : ''}`
              : '今天还没有额度记录'
          }
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <DecisionQueue
          slug={slug}
          rows={data.queue}
          today={data.today}
          canWrite={data.canWrite}
          onChanged={reload}
        />
        <Section title="节点倒计时">
          {data.countdown.length === 0 ? (
            <EmptyState title="还没有节点">
              在
              <Link to="/app/$slug/config" params={{ slug }} className="text-primary">
                设置
              </Link>
              中维护节点日历。
            </EmptyState>
          ) : (
            <ul className="grid gap-2 text-[13px]">
              {data.countdown.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2">
                  <div className="grid">
                    <span className="font-medium">{n.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{n.start}</span>
                  </div>
                  {n.selling ? (
                    <Tag tone="success">销售中</Tag>
                  ) : (
                    <Tag tone={n.daysLeft <= 30 ? 'warning' : 'neutral'}>{n.daysLeft} 天</Tag>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

const GRADE_TONES: Record<string, Tone> = {
  recommend: 'success',
  caution: 'warning',
  reject: 'danger',
}

/** 分数与等级取线索保存的计算结果（等级为空时不显示） */
export function ScoreCell({ score, grade }: { score: number | null; grade: string | null }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono">{score == null ? '—' : Math.round(score)}</span>
      {grade && grade in GRADE_TONES ? (
        <Tag tone={GRADE_TONES[grade] ?? 'neutral'}>
          {GRADE_LABELS[grade as keyof typeof GRADE_LABELS]}
        </Tag>
      ) : null}
    </div>
  )
}

type Deciding = { leadId: string; kind: 'follow' | 'drop' }

function DecisionQueue({
  slug,
  rows,
  today,
  canWrite,
  onChanged,
}: {
  slug: string
  rows: QueueRow[]
  today: string
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const [deciding, setDeciding] = useState<Deciding | null>(null)
  return (
    <Section title={`待决定队列（${rows.length}）`}>
      {rows.length === 0 ? (
        <EmptyState title="没有待决定的线索">
          在线索详情的核算矩阵中选定组合后，线索会出现在这里。
        </EmptyState>
      ) : (
        <SimpleTable head={['商品簇', '方向 · 平台', '分数', '所选组合', '最晚决定日', '']}>
          {rows.map((r) => (
            <Fragment key={r.leadId}>
              <tr
                data-testid="queue-row"
                data-tone={r.tone}
                className={cn(
                  r.tone === 'overdue' && 'bg-destructive-soft/40',
                  r.tone === 'soon' && 'bg-warning-soft/40',
                )}
              >
                <td className="px-3 py-2 font-medium">{r.clusterName}</td>
                <td className="px-3 py-2 text-xs">
                  <div>{r.directionName}</div>
                  <div className="text-muted-foreground">
                    {r.marketplace ? marketplaceLabel(r.marketplace) : '—'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score} grade={r.grade} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.scenario ? (
                    <div className="grid gap-0.5">
                      <span>
                        毛利率 <b>{formatRate(r.scenario.grossMargin)}</b>
                      </span>
                      <span className="text-muted-foreground">
                        落地成本 {formatMoney(r.scenario.landedCostMinor, r.scenario.currency)} ·{' '}
                        {FOLLOW_MODE_LABELS[r.scenario.mode]}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">未选定组合</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <DeadlineTag deadline={r.deadline} tone={r.tone} today={today} />
                </td>
                <td className="px-3 py-2">
                  {canWrite ? (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        disabled={!r.scenario}
                        onClick={() => setDeciding({ leadId: r.leadId, kind: 'follow' })}
                      >
                        跟卖
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeciding({ leadId: r.leadId, kind: 'drop' })}
                      >
                        放弃
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
              {deciding?.leadId === r.leadId ? (
                <tr>
                  <td colSpan={6} className="bg-muted/30 px-3 py-3">
                    <DecisionForm
                      slug={slug}
                      row={r}
                      kind={deciding.kind}
                      onClose={() => setDeciding(null)}
                      onSaved={async () => {
                        setDeciding(null)
                        await onChanged()
                      }}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </SimpleTable>
      )}
    </Section>
  )
}

function DecisionForm({
  slug,
  row,
  kind,
  onClose,
  onSaved,
}: {
  slug: string
  row: QueueRow
  kind: 'follow' | 'drop'
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [qty, setQty] = useState(String(row.scenario?.plannedQty ?? ''))
  const [price, setPrice] = useState(moneyInput(row.scenario?.salePriceMinor))
  const [currency, setCurrency] = useState(row.scenario?.currency ?? 'USD')
  const [listingOn, setListingOn] = useState('')
  const [reason, setReason] = useState<DropReason>('low-margin')
  const [note, setNote] = useState('')
  const { busy, error, setError, run } = useAction(onSaved)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (kind === 'drop') {
      if (reason === 'other' && !note.trim()) return setError('选择“其他”时请填写说明')
      await run(() =>
        decideLead({
          data: {
            slug,
            leadId: row.leadId,
            decision: { kind: 'drop', reason, note: note || null },
          },
        }),
      )
      return
    }
    const firstBatchQty = Number(qty)
    const targetPriceMinor = parseMoney(price)
    if (!Number.isInteger(firstBatchQty) || firstBatchQty <= 0) return setError('首批数量为正整数')
    if (targetPriceMinor == null || Number.isNaN(targetPriceMinor) || targetPriceMinor <= 0)
      return setError('请填写目标售价')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(listingOn)) return setError('请选择计划上架日')
    await run(() =>
      decideLead({
        data: {
          slug,
          leadId: row.leadId,
          decision: {
            kind: 'follow',
            firstBatchQty,
            targetPriceMinor,
            currency,
            plannedListingOn: listingOn,
          },
        },
      }),
    )
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={submit}
      aria-label={kind === 'follow' ? '跟卖决定' : '放弃决定'}
    >
      <p className="text-xs text-muted-foreground">
        决定后线索进入选品档案库，核算不能再修改；档案库保存此刻的分数、权重版本与所选组合。
      </p>
      {kind === 'follow' ? (
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="首批数量">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                className="h-8 text-[13px]"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          <Field label="目标售价">
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
          <Field label="币种">
            {(id) => (
              <Input
                id={id}
                className="h-8 text-[13px]"
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            )}
          </Field>
          <Field label="计划上架日">
            {(id) => (
              <Input
                id={id}
                type="date"
                className="h-8 text-[13px]"
                value={listingOn}
                onChange={(e) => setListingOn(e.target.value)}
              />
            )}
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
          <Field label="放弃原因">
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={reason}
                onChange={(e) => setReason(e.target.value as DropReason)}
              >
                {DROP_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {DROP_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="说明" hint={reason === 'other' ? '必填' : '可选'}>
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
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? '提交中…' : kind === 'follow' ? '确认跟卖' : '确认放弃'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>
          取消
        </Button>
      </div>
    </form>
  )
}
