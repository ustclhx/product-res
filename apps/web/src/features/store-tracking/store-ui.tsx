import { Button, Tag, type Tone } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { marketplaceLabel, splitList } from '../follow/marketplaces.ts'
import { CheckboxGroup, controlClass, ErrorText, Field } from '../workbench/fields.tsx'
import type { DisabledSource, SourceState, StoreRowView } from './store-tracking.server.ts'

/** 店铺追踪页面共用的标签、格式化与设置表单（文案见 messages/<locale>/store-tracking.json） */

export type StoreKind = StoreRowView['kind']
export type StoreStatus = StoreRowView['status']
export type Tier = 'hot' | 'normal' | 'cold'

export const STORE_KINDS: readonly StoreKind[] = ['benchmark', 'hot', 'watch']

export function kindLabel(kind: StoreKind) {
  if (kind === 'benchmark') return m.store_tracking_kind_benchmark()
  if (kind === 'hot') return m.store_tracking_kind_hot()
  return m.store_tracking_kind_watch()
}

export function statusLabel(status: StoreStatus) {
  if (status === 'active') return m.store_tracking_status_active()
  if (status === 'paused') return m.store_tracking_status_paused()
  return m.store_tracking_status_removed()
}

export const STATUS_TONE: Record<StoreStatus, Tone> = {
  active: 'success',
  paused: 'warning',
  removed: 'neutral',
}

export function tierLabel(tier: Tier | null) {
  if (tier === 'hot') return m.store_tracking_tier_hot()
  if (tier === 'normal') return m.store_tracking_tier_normal()
  if (tier === 'cold') return m.store_tracking_tier_cold()
  return m.store_tracking_tier_untracked()
}

export const TIER_TONE: Record<Tier, Tone> = { hot: 'danger', normal: 'info', cold: 'neutral' }

/** 档位变更原因（packages/follow stores/rules.ts 写入的代码）→ 文案 */
export function tierReasonLabel(reason: string | null) {
  if (!reason) return ''
  if (reason === 'new-lead') return m.store_tracking_reason_new_lead()
  if (reason === 'sale-signal') return m.store_tracking_reason_sale_signal()
  if (reason === 'bought-up') return m.store_tracking_reason_bought_up()
  if (reason === 'sold-up') return m.store_tracking_reason_sold_up()
  if (reason.startsWith('stale-')) return m.store_tracking_reason_stale()
  if (reason.startsWith('added:')) return m.store_tracking_reason_added()
  return reason
}

export const platformLabel = (platform: string) => (platform === 'ebay' ? 'eBay' : 'Amazon')

/** 所需数据源停用的醒目提示，链接到数据中心对应来源卡片 */
export function DisabledSourceNotice({
  slug,
  sources,
}: {
  slug: string
  sources: readonly DisabledSource[]
}) {
  if (sources.length === 0) return null
  return (
    <div
      className="grid gap-1 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] font-medium text-warning-strong"
      role="alert"
      data-testid="store-source-disabled"
    >
      {sources.map((s) => (
        <p key={`${s.platform}|${s.id}`}>
          {s.role === 'cross'
            ? m.store_tracking_source_disabled_cross({ source: s.label })
            : m.store_tracking_source_disabled_notice({
                source: s.label,
                platform: platformLabel(s.platform),
              })}{' '}
          <Link
            to="/app/$slug/data"
            params={{ slug }}
            hash={`source-${s.id}`}
            className="underline hover:text-primary"
          >
            {m.store_tracking_source_disabled_link()}
          </Link>
        </p>
      ))}
    </div>
  )
}

export function sourceLabel(state: SourceState) {
  if (state === 'not-configured' || state === 'unregistered')
    return m.store_tracking_source_not_configured()
  if (state === 'paused') return m.store_tracking_source_paused()
  if (state === 'disabled') return m.store_tracking_source_disabled()
  return ''
}

export const formatPercent = (value: number | null) =>
  value === null ? m.store_tracking_empty_value() : `${Math.round(value * 1000) / 10}%`

export const formatTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Singapore',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso))
    : m.store_tracking_never()

export function StoreBadges({
  store,
}: {
  store: Pick<StoreRowView, 'platform' | 'marketplace' | 'kind' | 'status' | 'source'>
}) {
  const source = sourceLabel(store.source)
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Tag tone="neutral">{marketplaceLabel(store.marketplace)}</Tag>
      <Tag tone="info">{kindLabel(store.kind)}</Tag>
      <Tag tone={STATUS_TONE[store.status]}>{statusLabel(store.status)}</Tag>
      {source ? <Tag tone="warning">{source}</Tag> : null}
    </span>
  )
}

export interface StoreSettingsValue {
  kind: StoreKind
  directionIds: string[]
  keywords: string[]
  displayName: string
  reason: string
}

/** 店铺设置字段（添加与编辑共用）；Amazon 店铺显示搜索词 */
export function StoreSettingsFields({
  value,
  onChange,
  directions,
  platform,
}: {
  value: StoreSettingsValue
  onChange: (next: StoreSettingsValue) => void
  directions: readonly { id: string; name: string }[]
  platform: 'ebay' | 'amazon' | null
}) {
  const [keywordText, setKeywordText] = useState(value.keywords.join('\n'))
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={m.store_tracking_kind_label()}>
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={value.kind}
            onChange={(e) => onChange({ ...value, kind: e.target.value as StoreKind })}
          >
            {STORE_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={m.store_tracking_name_label()} hint={m.store_tracking_name_hint()}>
        {(id) => (
          <input
            id={id}
            className={controlClass}
            value={value.displayName}
            maxLength={128}
            onChange={(e) => onChange({ ...value, displayName: e.target.value })}
          />
        )}
      </Field>
      <div className="sm:col-span-2">
        <CheckboxGroup
          label={m.store_tracking_directions_label()}
          options={directions.map((d) => ({ value: d.id, label: d.name }))}
          value={value.directionIds}
          onChange={(directionIds) => onChange({ ...value, directionIds })}
          empty={m.store_tracking_directions_empty()}
        />
      </div>
      {platform !== 'ebay' ? (
        <Field
          label={m.store_tracking_keywords_label()}
          hint={m.store_tracking_keywords_hint()}
          className="sm:col-span-2"
        >
          {(id) => (
            <textarea
              id={id}
              rows={3}
              className={`${controlClass} h-auto py-1.5`}
              value={keywordText}
              onChange={(e) => {
                setKeywordText(e.target.value)
                onChange({ ...value, keywords: splitList(e.target.value) })
              }}
            />
          )}
        </Field>
      ) : null}
      <Field label={m.store_tracking_reason_label()} className="sm:col-span-2">
        {(id) => (
          <input
            id={id}
            className={controlClass}
            value={value.reason}
            maxLength={500}
            onChange={(e) => onChange({ ...value, reason: e.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

/** 编辑已有店铺的设置 */
export function StoreSettingsForm({
  initial,
  directions,
  platform,
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  initial: StoreSettingsValue
  directions: readonly { id: string; name: string }[]
  platform: 'ebay' | 'amazon'
  onSubmit: (value: StoreSettingsValue) => void
  onCancel: () => void
  busy: boolean
  error: string
}) {
  const [value, setValue] = useState(initial)
  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit(value)
  }
  return (
    <form aria-label={m.store_tracking_edit()} className="grid gap-3" onSubmit={submit}>
      <StoreSettingsFields
        value={value}
        onChange={setValue}
        directions={directions}
        platform={platform}
      />
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {m.store_tracking_save()}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {m.store_tracking_cancel()}
        </Button>
      </div>
    </form>
  )
}

/** 每个店铺的搜索词上限（与服务端 MAX_STORE_KEYWORDS 一致） */
export const MAX_KEYWORDS = 5

/** 设置值 → 服务端输入；搜索词超过上限时抛出，由 useAction 显示 */
export function toSettingsInput(value: StoreSettingsValue) {
  if (value.keywords.length > MAX_KEYWORDS) throw new Error(m.store_tracking_keywords_label())
  return {
    kind: value.kind,
    directionIds: value.directionIds,
    keywords: value.keywords,
    displayName: value.displayName.trim() || null,
    reason: value.reason.trim() || null,
  }
}
