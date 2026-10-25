import type { TransferDetail, TransferSummary } from '@product-res/follow/transfer'
import { Button, cn, Tag } from '@product-res/ui'
import { type ReactNode, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { ProgressBar, Section } from '../data-center/shared.tsx'
import {
  batchLabel,
  CANCELLED_CODE,
  formatUtc,
  isActiveTransfer,
  kindLabel,
  statusLabel,
  statusTone,
  tableLabel,
  transferErrorText,
} from './labels.ts'
import { Modal } from './modal.tsx'

/**
 * 流转详情 / 进度（add-workspace-data-transfer tasks 6.3）：状态、批次进度、按表计数、
 * 冲突处理、跳过 / 重命名 / 未映射清单、失败原因，以及取消与重试续跑。
 * 空间页与 /admin/workspaces 共用；后台不传 viewer，只读展示。
 */

export type { TransferDetail, TransferSummary }

export interface TransferViewer {
  readonly userId: string
  readonly role: string
}

/** 与服务端 manageable() 同一口径：发起人或当前空间 owner；只有进行中的流转可取消 / 续跑 */
export function transferActions(
  transfer: Pick<TransferSummary, 'status' | 'requestedBy'>,
  viewer: TransferViewer | null,
): { cancel: boolean; retry: boolean } {
  if (!viewer || !isActiveTransfer(transfer.status)) return { cancel: false, retry: false }
  const allowed = viewer.userId === transfer.requestedBy || viewer.role === 'owner'
  return {
    // 已在回滚中的流转再次取消没有意义
    cancel: allowed && transfer.status !== 'compensating',
    retry: allowed,
  }
}

export function TransferStatusTag({
  transfer,
}: {
  transfer: Pick<TransferSummary, 'status' | 'errorCode'>
}) {
  return (
    <Tag tone={statusTone(transfer.status, transfer.errorCode)} data-status={transfer.status}>
      {statusLabel(transfer.status, transfer.errorCode)}
    </Tag>
  )
}

export const workspaceName = (name: string | null) => name ?? m.transfer_unknown_workspace()

const isUndoing = (status: string) => status === 'compensating' || status === 'compensated'

/** 批次进度：补偿中 / 已回滚显示撤销进度，计划完成前显示“计划中” */
export function progressText(transfer: Pick<TransferSummary, 'status' | 'progress'>): string {
  const { done, compensated, total } = transfer.progress
  if (isUndoing(transfer.status)) {
    // 回滚时只看撤销进度；计划前或首批完成前取消没有需要撤销的批次
    if (done + compensated === 0)
      return transfer.status === 'compensating'
        ? m.transfer_progress_nothing_to_undo()
        : m.transfer_progress_nothing_undone()
    return m.transfer_progress_compensated({
      done: String(compensated),
      total: String(done + compensated),
    })
  }
  if (total === 0) return isActiveTransfer(transfer.status) ? m.transfer_progress_planning() : '—'
  return m.transfer_progress_batches({ done: String(done), total: String(total) })
}

function progressValue(transfer: Pick<TransferSummary, 'status' | 'progress'>) {
  const { done, compensated, total } = transfer.progress
  if (transfer.status === 'compensating' || transfer.status === 'compensated')
    return { value: compensated, max: done + compensated }
  return { value: done, max: total }
}

const COUNT_COLUMNS = ['moved', 'copied', 'merged', 'skipped', 'renamed'] as const
const countHeader: Record<(typeof COUNT_COLUMNS)[number], () => string> = {
  moved: () => m.transfer_count_moved(),
  copied: () => m.transfer_count_copied(),
  merged: () => m.transfer_count_merged(),
  skipped: () => m.transfer_count_skipped(),
  renamed: () => m.transfer_count_renamed(),
}

export interface CountRow {
  readonly table: string
  readonly planned: number
  readonly actions: Readonly<Record<string, number>>
  readonly unmapped: number
}

/** 按表合并计划行数与执行计数；`unmapped:<列>` 汇总为未映射引用 */
export function countRows(detail: Pick<TransferDetail, 'counts' | 'plannedTables'>): CountRow[] {
  const tables = new Set([...Object.keys(detail.plannedTables), ...Object.keys(detail.counts)])
  return [...tables]
    .map((table) => {
      const actions: Record<string, number> = {}
      let unmapped = 0
      for (const [action, n] of Object.entries(detail.counts[table] ?? {})) {
        if (action.startsWith('unmapped:')) unmapped += n ?? 0
        else actions[action] = n ?? 0
      }
      return { table, planned: detail.plannedTables[table] ?? 0, actions, unmapped }
    })
    .filter((r) => r.planned > 0 || r.unmapped > 0 || Object.values(r.actions).some((n) => n > 0))
}

/** 未映射引用清单：表 · 列 → 条数 */
export function unmappedEntries(counts: TransferDetail['counts']) {
  return Object.entries(counts).flatMap(([table, actions]) =>
    Object.entries(actions ?? {})
      .filter(([action, n]) => action.startsWith('unmapped:') && (n ?? 0) > 0)
      .map(([action, n]) => ({ table, column: action.slice('unmapped:'.length), count: n ?? 0 })),
  )
}

function conflictText(c: TransferDetail['conflicts'][number]): string {
  if (c.action === 'rename') return m.transfer_detail_conflict_rename({ name: c.newName ?? '' })
  if (c.action === 'merge') return m.transfer_detail_conflict_merge()
  return m.transfer_detail_conflict_keep_target()
}

function List({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <ul className="grid gap-1 text-[13px]">{children}</ul>
    </Section>
  )
}

export interface TransferDetailViewProps {
  readonly detail: TransferDetail
  readonly viewer: TransferViewer | null
  /** 升级完成后进入新团队空间（仅空间页提供） */
  readonly onOpenTarget?: (() => void) | undefined
  readonly onCancel?: () => Promise<void>
  readonly onRetry?: () => Promise<void>
  readonly busy?: boolean
  readonly message?: string
  readonly polling?: boolean
}

export function TransferDetailView({
  detail,
  viewer,
  onOpenTarget,
  onCancel,
  onRetry,
  busy = false,
  message = '',
  polling = false,
}: TransferDetailViewProps) {
  const [confirming, setConfirming] = useState(false)
  const actions = transferActions(detail, viewer)
  const active = isActiveTransfer(detail.status)
  const rows = countRows(detail)
  const unmapped = unmappedEntries(detail.counts)
  const progress = progressValue(detail)
  const cancelled = detail.errorCode === CANCELLED_CODE
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4" data-testid="transfer-detail">
      <Section
        title={
          <span className="flex flex-wrap items-center gap-2">
            {kindLabel(detail.kind)}
            <TransferStatusTag transfer={detail} />
          </span>
        }
      >
        <p className="text-[13px]">
          {m.transfer_detail_route({
            source: workspaceName(detail.sourceName),
            target: workspaceName(detail.targetName),
          })}
        </p>
        <p className="text-muted-foreground text-xs">
          {m.transfer_detail_requested({
            name: detail.requestedByName ?? detail.requestedBy,
            time: formatUtc(detail.createdAt),
          })}
          {detail.finishedAt
            ? ` · ${m.transfer_detail_finished({ time: formatUtc(detail.finishedAt) })}`
            : null}
        </p>
        <div className="grid gap-1">
          <div className="flex justify-between text-xs">
            <span>{m.transfer_col_progress()}</span>
            <span className="font-mono" data-testid="transfer-progress">
              {progressText(detail)}
            </span>
          </div>
          {progress.max > 0 || !isUndoing(detail.status) ? (
            <ProgressBar value={progress.value} max={progress.max} />
          ) : null}
        </div>
        {active ? (
          <p
            role="status"
            className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong"
          >
            {detail.status === 'compensating'
              ? m.transfer_detail_compensating_hint()
              : m.transfer_detail_readonly_banner()}
            {polling ? ` ${m.transfer_detail_polling()}` : null}
          </p>
        ) : null}
        {detail.errorCode ? (
          <div
            role={cancelled ? 'status' : 'alert'}
            className={cn(
              'grid gap-0.5 rounded-md px-3 py-2 text-xs',
              cancelled ? 'bg-muted text-muted-foreground' : 'bg-destructive-soft text-destructive',
            )}
            data-testid="transfer-error"
          >
            <span className="font-semibold">
              {cancelled ? m.transfer_detail_cancelled_title() : m.transfer_detail_failure_title()}
            </span>
            <span>{transferErrorText(detail.errorCode)}</span>
          </div>
        ) : null}
        {detail.status === 'compensated' ? (
          <p className="text-muted-foreground text-xs">
            {m.transfer_detail_compensated_hint()}{' '}
            {detail.kind === 'upgrade' ? m.transfer_detail_upgrade_compensated_hint() : null}
          </p>
        ) : null}
        {detail.status === 'completed' && detail.kind === 'upgrade' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-success-soft px-3 py-2 text-xs text-success-strong">
            <span>{m.transfer_detail_completed_upgrade()}</span>
            {onOpenTarget ? (
              <Button size="sm" onClick={onOpenTarget}>
                {m.transfer_detail_open_target()}
              </Button>
            ) : null}
          </div>
        ) : null}
        {detail.quota?.exceeds ? (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            {m.transfer_detail_quota_notice({
              calls: String(detail.quota.additionalBrowseCallsPerDay),
              threshold: String(detail.quota.threshold),
            })}
          </p>
        ) : null}
        {actions.cancel || actions.retry ? (
          <div className="grid gap-1.5 border-t pt-3">
            <div className="flex flex-wrap gap-2">
              {actions.retry ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onRetry?.()}
                >
                  {m.transfer_action_retry()}
                </Button>
              ) : null}
              {actions.cancel ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  {m.transfer_action_cancel()}
                </Button>
              ) : null}
            </div>
            {actions.retry ? (
              <p className="text-muted-foreground text-xs">{m.transfer_action_retry_hint()}</p>
            ) : null}
          </div>
        ) : null}
        {message ? (
          <p role="status" className="text-xs">
            {message}
          </p>
        ) : null}
      </Section>

      <Section title={m.transfer_detail_counts_title()}>
        {rows.length ? (
          <div className="min-w-0 max-w-full overflow-x-auto">
            <table
              className="w-full min-w-[560px] text-left text-[13px]"
              data-testid="transfer-counts"
            >
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{m.transfer_count_table()}</th>
                  <th className="px-3 py-2 text-right font-medium">{m.transfer_count_planned()}</th>
                  {COUNT_COLUMNS.map((c) => (
                    <th key={c} className="px-3 py-2 text-right font-medium">
                      {countHeader[c]()}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">
                    {m.transfer_count_unmapped()}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.table}>
                    <td className="px-3 py-1.5">{tableLabel(r.table)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{r.planned}</td>
                    {COUNT_COLUMNS.map((c) => (
                      <td key={c} className="px-3 py-1.5 text-right font-mono">
                        {r.actions[c] ?? 0}
                      </td>
                    ))}
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right font-mono',
                        r.unmapped > 0 && 'text-warning-strong',
                      )}
                    >
                      {r.unmapped}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{m.transfer_detail_counts_empty()}</p>
        )}
      </Section>

      {detail.conflicts.length ? (
        <List title={m.transfer_detail_conflicts_title()}>
          {detail.conflicts.map((c) => (
            <li key={`${c.table}:${c.sourceId}`} className="flex flex-wrap gap-2">
              <Tag tone="neutral">{tableLabel(c.table)}</Tag>
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground">{conflictText(c)}</span>
            </li>
          ))}
        </List>
      ) : null}
      {detail.skipped.length ? (
        <List title={m.transfer_detail_skipped_title()}>
          {detail.skipped.map((e) => (
            <li key={`${e.table}:${e.sourceId}`} className="flex flex-wrap gap-2">
              <Tag tone="neutral">{tableLabel(e.table)}</Tag>
              <span>{e.label ?? e.sourceId}</span>
            </li>
          ))}
        </List>
      ) : null}
      {detail.renamed.length ? (
        <List title={m.transfer_detail_renamed_title()}>
          {detail.renamed.map((e) => (
            <li key={`${e.table}:${e.sourceId}`} className="flex flex-wrap gap-2">
              <Tag tone="neutral">{tableLabel(e.table)}</Tag>
              <span>{e.label ?? e.sourceId}</span>
              {e.newName ? <span className="text-muted-foreground">→ {e.newName}</span> : null}
            </li>
          ))}
        </List>
      ) : null}
      {unmapped.length ? (
        <List title={m.transfer_detail_unmapped_title()}>
          <li className="text-muted-foreground text-xs">{m.transfer_detail_unmapped_hint()}</li>
          {unmapped.map((u) => (
            <li key={`${u.table}:${u.column}`}>
              {m.transfer_detail_unmapped_row({
                table: tableLabel(u.table),
                column: u.column,
                count: String(u.count),
              })}
            </li>
          ))}
        </List>
      ) : null}
      {detail.batches.length ? (
        <Section title={m.transfer_detail_batches_title()}>
          <ol className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {detail.batches.map((b) => (
              <li
                key={b.key}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1"
              >
                <span className="min-w-0 truncate">
                  {b.seq}. {batchLabel(b.key)}
                </span>
                <Tag
                  tone={
                    b.status === 'done'
                      ? 'success'
                      : b.status === 'compensated'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {b.status === 'done'
                    ? m.transfer_batch_done()
                    : b.status === 'compensated'
                      ? m.transfer_batch_compensated()
                      : m.transfer_batch_pending()}
                </Tag>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Modal
        open={confirming}
        title={m.transfer_cancel_dialog_title()}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {m.transfer_cancel_dialog_keep()}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setConfirming(false)
                await onCancel?.()
              }}
            >
              {m.transfer_cancel_dialog_confirm()}
            </Button>
          </>
        }
      >
        <p>{m.transfer_cancel_dialog_body()}</p>
      </Modal>
    </div>
  )
}
