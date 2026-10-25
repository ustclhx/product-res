import type { TransferPreview } from '@product-res/follow/transfer'
import { Button, cn } from '@product-res/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { workbenchErrorText } from '../workbench/errors.ts'
import { controlClass, ErrorText, Field } from '../workbench/fields.tsx'
import type { TransferAvailability } from './availability.ts'
import { tableLabel, transferActionError } from './labels.ts'
import { Modal } from './modal.tsx'
import {
  getTransferPreview,
  getTransferTargets,
  startWorkspaceCopy,
  startWorkspaceMove,
} from './transfer.functions.ts'
import type { TransferTarget } from './transfer.server.ts'

/**
 * 列表多选“复制到空间… / 移动到空间…”（add-workspace-data-transfer design D2、D4、D6、D11，tasks 6.2）。
 * 方向、店铺、追踪商品、品类研究与档案列表共用：选择 → 目标空间与冲突策略 → 预览 → 确认 → 流转记录。
 */

/** 可作为根条目的列表（TransferRoots 的键） */
export type TransferRootKind =
  | 'direction'
  | 'store'
  | 'trackedProduct'
  | 'categoryStudy'
  | 'decision'
export type TransferKind = 'copy' | 'move'
type Strategy = 'rename' | 'merge'

/** 发起后跳转的流转进度页（tasks 6.3 的数据流转记录详情） */
export function transferRecordTarget(slug: string, transferId: string) {
  return {
    to: '/app/$slug/settings/transfers/$transferId' as const,
    params: { slug, transferId },
  }
}

/** 列表的多选状态：列表刷新后丢弃已不存在的 id */
export function useTransferSelection(ids: readonly string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const key = ids.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 以 id 列表内容为依赖，避免数组引用变化反复触发
  useEffect(() => {
    const present = new Set(ids)
    setSelected((current) => {
      const next = new Set([...current].filter((id) => present.has(id)))
      return next.size === current.size ? current : next
    })
  }, [key])
  return {
    selected,
    has: (id: string) => selected.has(id),
    toggle: (id: string, on: boolean) =>
      setSelected((current) => {
        const next = new Set(current)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
    setAll: (on: boolean) => setSelected(on ? new Set(ids) : new Set()),
    clear: () => setSelected(new Set()),
    allSelected: ids.length > 0 && ids.every((id) => selected.has(id)),
  }
}

export type TransferSelectionState = ReturnType<typeof useTransferSelection>

export const canTransfer = (availability: TransferAvailability | undefined) =>
  Boolean(availability && (availability.copy || availability.move))

export function SelectBox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  className?: string
}) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 shrink-0 accent-primary', className)}
      checked={checked}
      aria-label={label}
      data-testid="transfer-select"
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

/** 选中条目后出现的操作条：按 D6 只显示可用的操作 */
export function TransferBar({
  slug,
  root,
  availability,
  selection,
}: {
  slug: string
  root: TransferRootKind
  availability: TransferAvailability
  selection: TransferSelectionState
}) {
  const [open, setOpen] = useState<TransferKind | null>(null)
  const count = selection.selected.size
  if (count === 0 && open === null) return null
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[13px]"
        data-testid="transfer-bar"
      >
        <span className="font-medium" role="status">
          {m.transfer_actions_selected({ count: String(count) })}
        </span>
        {availability.copy ? (
          <Button size="sm" variant="outline" onClick={() => setOpen('copy')}>
            {m.transfer_actions_copy()}
          </Button>
        ) : null}
        {availability.move ? (
          <Button size="sm" variant="outline" onClick={() => setOpen('move')}>
            {m.transfer_actions_move()}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={selection.clear}>
          {m.transfer_actions_clear()}
        </Button>
      </div>
      {open ? (
        <TransferDialog
          slug={slug}
          kind={open}
          root={root}
          ids={[...selection.selected]}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  )
}

/** 同名方向的冲突策略只在流转会带上方向时有意义（方向根，或以档案为根时方向随线索复制） */
export const rootCarriesDirections = (root: TransferRootKind) =>
  root === 'direction' || root === 'decision'

export function targetLabel(target: TransferTarget) {
  const role =
    target.role === 'owner'
      ? m.transfer_actions_target_role_owner()
      : m.transfer_actions_target_role_admin()
  const name = target.isPersonal
    ? m.transfer_actions_target_personal({ name: target.name })
    : target.name
  return `${name} · ${role}`
}

export function selectionFor(root: TransferRootKind, ids: readonly string[], strategy: Strategy) {
  return {
    roots: { [root]: [...ids] },
    ...(rootCarriesDirections(root) ? { conflicts: { direction: strategy } } : {}),
  }
}

/** 流转错误码按 labels.ts 选文案（与升级、记录页同一套）；流转锁沿用工作台文案 */
function errorText(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'WORKSPACE_TRANSFERRING'
  )
    return workbenchErrorText(error)
  return transferActionError(error, fallback)
}

function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function TransferDialog({
  slug,
  kind,
  root,
  ids,
  onClose,
}: {
  slug: string
  kind: TransferKind
  root: TransferRootKind
  ids: readonly string[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const strategyName = useId()
  // 打开对话框时生成幂等键：重复提交（双击、网络重试）返回同一流转
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [targets, setTargets] = useState<TransferTarget[] | null>(null)
  const [targetId, setTargetId] = useState('')
  const [strategy, setStrategy] = useState<Strategy>('rename')
  const [preview, setPreview] = useState<{ key: string; value: TransferPreview } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'submit' | null>(null)
  const [error, setError] = useState('')
  const [started, setStarted] = useState(false)

  useEffect(() => {
    let live = true
    getTransferTargets({ data: { slug } })
      .then((list) => {
        if (!live) return
        setTargets(list)
        if (list.length === 1) setTargetId(list[0]?.id ?? '')
      })
      .catch((e: unknown) => {
        if (!live) return
        setTargets([])
        setError(errorText(e, m.transfer_actions_error_targets()))
      })
    return () => {
      live = false
    }
  }, [slug])

  const selection = useMemo(() => selectionFor(root, ids, strategy), [root, ids, strategy])
  const previewKey = `${targetId}|${strategy}`
  const current = preview?.key === previewKey ? preview.value : null

  async function runPreview() {
    if (!targetId) return
    setBusy('preview')
    setError('')
    try {
      const value = await getTransferPreview({
        data: { slug, kind, targetWorkspaceId: targetId, selection },
      })
      setPreview({ key: previewKey, value })
    } catch (e) {
      setError(errorText(e, workbenchErrorText(e)))
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    if (!targetId || !current || current.tooLarge) return
    setBusy('submit')
    setError('')
    try {
      const start = kind === 'copy' ? startWorkspaceCopy : startWorkspaceMove
      const result = await start({
        data: { slug, targetWorkspaceId: targetId, selection, idempotencyKey },
      })
      setStarted(true)
      await navigate(transferRecordTarget(slug, result.transferId))
    } catch (e) {
      setError(errorText(e, workbenchErrorText(e)))
      setBusy(null)
    }
  }

  const count = String(ids.length)
  const footer = (
    <>
      <Button size="sm" variant="ghost" onClick={onClose} disabled={busy === 'submit'}>
        {m.transfer_actions_cancel()}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!targetId || busy !== null}
        onClick={() => void runPreview()}
      >
        {busy === 'preview' ? m.transfer_actions_previewing() : m.transfer_actions_preview()}
      </Button>
      <Button
        size="sm"
        variant={kind === 'move' ? 'destructive' : 'default'}
        disabled={!current || current.tooLarge || busy !== null || started}
        onClick={() => void submit()}
      >
        {busy === 'submit'
          ? m.transfer_actions_submitting()
          : kind === 'copy'
            ? m.transfer_actions_confirm_copy()
            : m.transfer_actions_confirm_move()}
      </Button>
    </>
  )
  return (
    <Modal
      open
      className="max-w-xl"
      title={
        kind === 'copy'
          ? m.transfer_actions_dialog_copy_title()
          : m.transfer_actions_dialog_move_title()
      }
      onClose={() => {
        if (busy !== 'submit') onClose()
      }}
      footer={footer}
    >
      <div className="grid min-w-0 gap-3" data-testid="transfer-dialog">
        <p className="text-xs text-muted-foreground">
          {kind === 'copy'
            ? m.transfer_actions_dialog_copy_intro({ count })
            : m.transfer_actions_dialog_move_intro({ count })}
        </p>
        {targets === null ? (
          <p className="text-xs text-muted-foreground">{m.transfer_actions_targets_loading()}</p>
        ) : targets.length === 0 ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="note">
            {m.transfer_actions_targets_empty()}
          </p>
        ) : (
          <Field label={m.transfer_actions_target_label()} hint={m.transfer_actions_target_hint()}>
            {(id) => (
              <select
                id={id}
                className={controlClass}
                value={targetId}
                data-testid="transfer-target"
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">{m.transfer_actions_target_placeholder()}</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {targetLabel(t)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {rootCarriesDirections(root) ? (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {m.transfer_actions_strategy_label()}
            </legend>
            {(['rename', 'merge'] as const).map((value) => (
              <label key={value} className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  name={`${strategyName}-strategy`}
                  className="mt-0.5 accent-primary"
                  checked={strategy === value}
                  onChange={() => setStrategy(value)}
                />
                <span>
                  {value === 'rename'
                    ? m.transfer_actions_strategy_rename()
                    : m.transfer_actions_strategy_merge()}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {preview && !current ? (
          <p className="text-xs text-warning-strong" role="status">
            {m.transfer_actions_preview_stale()}
          </p>
        ) : null}
        {current ? <PreviewPanel preview={current} /> : null}

        <ErrorText>{error}</ErrorText>
        {started ? (
          <p role="status" className="text-xs text-muted-foreground">
            {m.transfer_actions_started()}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function conflictText(c: TransferPreview['conflicts'][number]) {
  if (c.action === 'rename') return m.transfer_actions_conflict_rename({ name: c.newName ?? '' })
  if (c.action === 'merge') return m.transfer_actions_conflict_merge()
  return m.transfer_actions_conflict_keep_target()
}

export function PreviewPanel({ preview }: { preview: TransferPreview }) {
  const tables = Object.entries(preview.tables).sort((a, b) => b[1] - a[1])
  const roots = Object.values(preview.roots).reduce((a, b) => a + b, 0)
  return (
    <section
      className="grid gap-2 rounded-lg border bg-muted/20 p-3"
      data-testid="transfer-preview"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">
          {m.transfer_actions_preview_title({
            source: preview.sourceName,
            target: preview.targetName,
          })}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {m.transfer_actions_preview_total({ count: String(preview.total) })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {m.transfer_actions_preview_roots({ count: String(roots) })}
      </p>
      {preview.tooLarge ? (
        <p role="alert" className="text-xs text-destructive">
          {m.transfer_actions_too_large({
            count: String(preview.total),
            limit: String(preview.rowLimit),
          })}
        </p>
      ) : null}
      <div className="grid gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">
          {m.transfer_actions_preview_tables()}
        </h4>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          {tables.map(([table, n]) => (
            <li key={table} className="flex justify-between gap-2">
              <span>{tableLabel(table)}</span>
              <span className="tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">
          {m.transfer_actions_preview_conflicts({ count: String(preview.conflicts.length) })}
        </h4>
        {preview.conflicts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {m.transfer_actions_preview_no_conflicts()}
          </p>
        ) : (
          <ul className="grid gap-0.5 text-xs" data-testid="transfer-conflicts">
            {preview.conflicts.map((c) => (
              <li key={`${c.table}:${c.sourceId}`} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{tableLabel(c.table)}</span>
                <span className="font-medium">{c.label}</span>
                <span>→ {conflictText(c)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">{m.transfer_actions_conflict_rules()}</p>
      </div>
      <ul className="grid list-disc gap-1 pl-4 text-xs text-muted-foreground">
        {preview.scoringVersions.length ? (
          <li>
            {m.transfer_actions_note_scoring({ versions: preview.scoringVersions.join(', v') })}
          </li>
        ) : null}
        {preview.directionsFollowLeads ? <li>{m.transfer_actions_note_leads()}</li> : null}
        {preview.quota.additionalBrowseCallsPerDay > 0 ? (
          <li className={preview.quota.exceeds ? 'text-warning-strong' : undefined}>
            {preview.quota.exceeds
              ? m.transfer_actions_note_quota({
                  count: String(preview.quota.additionalBrowseCallsPerDay),
                  threshold: String(preview.quota.threshold),
                })
              : m.transfer_actions_note_quota_small({
                  count: String(preview.quota.additionalBrowseCallsPerDay),
                })}
          </li>
        ) : null}
        {preview.kind === 'copy' ? <li>{m.transfer_actions_note_no_samples()}</li> : null}
        <li>{m.transfer_actions_note_readonly()}</li>
      </ul>
    </section>
  )
}
