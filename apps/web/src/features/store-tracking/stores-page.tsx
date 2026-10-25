import { Button, DataTable, type DataTableColumn } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { Section } from '../data-center/shared.tsx'
import { marketplaceLabel } from '../follow/marketplaces.ts'
import {
  canTransfer,
  SelectBox,
  TransferBar,
  type TransferSelectionState,
  useTransferSelection,
} from '../transfer/transfer-actions.tsx'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import {
  addTrackedStore,
  getStoresPage,
  parseStoreUrl,
  runStoreRound,
  setTrackedStoreStatus,
} from './store-tracking.functions.ts'
import type { StoreRowView, TrackedProductRowView } from './store-tracking.server.ts'
import {
  DisabledSourceNotice,
  formatPercent,
  formatTime,
  kindLabel,
  platformLabel,
  StoreSettingsFields,
  type StoreSettingsValue,
  sourceLabel,
  statusLabel,
  toSettingsInput,
} from './store-ui.tsx'

export type StoresData = Awaited<ReturnType<typeof getStoresPage>>

const EMPTY_SETTINGS: StoreSettingsValue = {
  kind: 'benchmark',
  directionIds: [],
  keywords: [],
  displayName: '',
  reason: '',
}

type Parsed = Awaited<ReturnType<typeof parseStoreUrl>>

/** 粘贴链接 → 解析预览 → 设置 → 加入店铺池 */
function AddStoreForm({
  slug,
  directions,
  onDone,
}: {
  slug: string
  directions: StoresData['directions']
  onDone: () => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [settings, setSettings] = useState(EMPTY_SETTINGS)
  const [formKey, setFormKey] = useState(0)
  const { busy, error, run } = useAction(onDone)

  async function preview(value: string) {
    if (!value.trim()) {
      setParsed(null)
      return
    }
    setParsed(await parseStoreUrl({ data: { slug, url: value } }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const ok = await run(() =>
      addTrackedStore({ data: { slug, url, ...toSettingsInput(settings) } }),
    )
    if (ok) {
      setUrl('')
      setParsed(null)
      setSettings(EMPTY_SETTINGS)
      setFormKey((k) => k + 1)
    }
  }

  const platform = parsed?.ok ? parsed.platform : null
  return (
    <form aria-label={m.store_tracking_add_title()} className="grid gap-3" onSubmit={submit}>
      <Field label={m.store_tracking_link_label()} hint={m.store_tracking_link_hint()}>
        {(id) => (
          <input
            id={id}
            className={controlClass}
            value={url}
            placeholder={m.store_tracking_link_placeholder()}
            maxLength={2048}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={(e) => void preview(e.target.value)}
          />
        )}
      </Field>
      {parsed ? (
        parsed.ok ? (
          <p className="text-xs text-success-strong" data-testid="store-link-parsed">
            {parsed.form === 'ebay-store'
              ? m.store_tracking_parsed_store_name({ storeName: parsed.sellerKey })
              : m.store_tracking_parsed({
                  platform: platformLabel(parsed.platform),
                  marketplace: marketplaceLabel(parsed.marketplace),
                  sellerKey: parsed.sellerKey,
                })}
          </p>
        ) : (
          <p role="alert" className="text-xs text-destructive" data-testid="store-link-error">
            {parsed.message}
          </p>
        )
      ) : null}
      <StoreSettingsFields
        key={formKey}
        value={settings}
        onChange={setSettings}
        directions={directions.filter(
          (d) => !parsed?.ok || d.marketplaces.includes(parsed.marketplace),
        )}
        platform={platform}
      />
      <ErrorText>{error}</ErrorText>
      <div>
        <Button type="submit" size="sm" disabled={busy || !url.trim()}>
          {m.store_tracking_add_submit()}
        </Button>
      </div>
    </form>
  )
}

/** 数据流转多选列（add-workspace-data-transfer 6.2）；不可流转时不加列 */
export function selectColumn<T extends { id: string }>(
  selection: TransferSelectionState | undefined,
  name: (row: T) => string,
): DataTableColumn<T>[] {
  if (!selection) return []
  return [
    {
      id: 'select',
      header: (
        <SelectBox
          checked={selection.allSelected}
          onChange={selection.setAll}
          label={m.transfer_actions_select_all()}
        />
      ),
      cell: (row) => (
        <SelectBox
          checked={selection.has(row.id)}
          onChange={(on) => selection.toggle(row.id, on)}
          label={m.transfer_actions_select_item({ name: name(row) })}
        />
      ),
    },
  ]
}

function columns(
  slug: string,
  canWrite: boolean,
  act: (id: string, status: StoreRowView['status']) => void,
  busy: boolean,
  selection: TransferSelectionState | undefined,
): DataTableColumn<StoreRowView>[] {
  return [
    ...selectColumn<StoreRowView>(selection, (s) => s.displayName),
    {
      id: 'store',
      header: m.store_tracking_col_store(),
      className: 'min-w-[200px]',
      cell: (s) => (
        <div className="grid gap-0.5">
          <Link
            to="/app/$slug/stores/$storeId"
            params={{ slug, storeId: s.id }}
            className="text-[13px] font-medium hover:text-primary"
          >
            {s.displayName}
          </Link>
          <span className="text-xs text-muted-foreground">{s.sellerKey}</span>
        </div>
      ),
    },
    {
      id: 'platform',
      header: m.store_tracking_col_platform(),
      cell: (s) => (
        <div className="grid gap-0.5 text-[13px]">
          <span>{marketplaceLabel(s.marketplace)}</span>
          {sourceLabel(s.source) ? (
            <span className="text-xs text-warning-strong">{sourceLabel(s.source)}</span>
          ) : null}
        </div>
      ),
    },
    { id: 'kind', header: m.store_tracking_col_kind(), cell: (s) => kindLabel(s.kind) },
    {
      id: 'new',
      header: m.store_tracking_col_new(),
      cell: (s) => (
        <div className="grid gap-0.5 text-[13px] tabular-nums">
          <span>
            {s.new7d} / {s.new30d}
          </span>
          {s.pending > 0 ? (
            <span className="text-xs text-muted-foreground">
              {m.store_tracking_pending({ count: String(s.pending) })}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'hit',
      header: m.store_tracking_col_hit_rate(),
      cell: (s) => <span className="tabular-nums">{formatPercent(s.hitRate)}</span>,
    },
    {
      id: 'sync',
      header: m.store_tracking_col_last_sync(),
      cell: (s) => <span className="text-xs">{formatTime(s.lastSyncAt)}</span>,
    },
    { id: 'status', header: m.store_tracking_col_status(), cell: (s) => statusLabel(s.status) },
    {
      id: 'actions',
      header: m.store_tracking_col_actions(),
      cell: (s) =>
        canWrite ? (
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(s.id, s.status === 'active' ? 'paused' : 'active')}
            >
              {s.status === 'active' ? m.store_tracking_pause() : m.store_tracking_resume()}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (window.confirm(m.store_tracking_remove_confirm())) act(s.id, 'removed')
              }}
            >
              {m.store_tracking_remove()}
            </Button>
          </div>
        ) : null,
    },
  ]
}

/** 店铺追踪：店铺池列表、添加与手动触发（design D8） */
export function StoresPage({ slug, initial }: { slug: string; initial: StoresData }) {
  const [data, setData] = useState(initial)
  // 路由返回缓存数据后会在后台重新加载：加载结果更新时同步到页面
  useEffect(() => setData(initial), [initial])
  const [roundNote, setRoundNote] = useState('')
  const [roundDisabled, setRoundDisabled] = useState<StoresData['disabledSources']>([])
  const reload = async () => setData(await getStoresPage({ data: { slug } }))
  const action = useAction(reload)
  const round = useAction(async () => {})
  const transferable = canTransfer(data.transfer)
  const storeSelection = useTransferSelection(data.stores.map((s) => s.id))
  const cols = columns(
    slug,
    data.canWrite,
    (id, status) => void action.run(() => setTrackedStoreStatus({ data: { slug, id, status } })),
    action.busy,
    transferable ? storeSelection : undefined,
  )
  const hasEbay = data.stores.some((s) => s.platform === 'ebay')
  const hasAmazon = data.stores.some((s) => s.platform === 'amazon')
  const ebayMissing =
    data.sources['ebay-browse'] === 'not-configured' ||
    data.sources['ebay-browse'] === 'unregistered'
  const amazonMissing =
    data.sources.dataforseo === 'not-configured' || data.sources.dataforseo === 'unregistered'

  async function triggerRound() {
    setRoundNote('')
    setRoundDisabled([])
    await round.run(async () => {
      const result = await runStoreRound({ data: { slug } })
      if (result.queued) setRoundNote(m.store_tracking_round_queued())
      else if (result.reason === 'sources-disabled') {
        setRoundNote(m.store_tracking_round_sources_disabled())
        setRoundDisabled(result.disabledSources)
      } else setRoundNote(m.store_tracking_round_already())
    })
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid max-w-3xl gap-1">
          <h1 className="text-lg font-semibold">{m.store_tracking_title()}</h1>
          <p className="text-[13px] text-muted-foreground">{m.store_tracking_intro()}</p>
        </div>
        {data.canWrite ? (
          <div className="grid justify-items-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={round.busy || !data.roundAvailable}
              title={
                data.roundAvailable
                  ? m.store_tracking_run_round_hint()
                  : m.store_tracking_round_unavailable()
              }
              onClick={() => void triggerRound()}
            >
              {m.store_tracking_run_round()}
            </Button>
            {roundNote ? (
              <p role="status" className="text-xs text-muted-foreground">
                {roundNote}
              </p>
            ) : null}
            <ErrorText>{round.error}</ErrorText>
          </div>
        ) : null}
      </div>

      <DisabledSourceNotice
        slug={slug}
        sources={roundDisabled.length > 0 ? roundDisabled : data.disabledSources}
      />
      {hasEbay && ebayMissing ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong" role="note">
          {m.store_tracking_ebay_not_configured()}
        </p>
      ) : null}
      {hasAmazon && amazonMissing ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong" role="note">
          {m.store_tracking_amazon_not_configured()}
        </p>
      ) : null}
      {!data.canWrite ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {m.store_tracking_read_only()}
        </p>
      ) : null}

      {data.canWrite ? (
        <Section title={m.store_tracking_add_title()}>
          <AddStoreForm slug={slug} directions={data.directions} onDone={reload} />
        </Section>
      ) : null}

      <Section title={m.store_tracking_table_label()}>
        {transferable ? (
          <TransferBar
            slug={slug}
            root="store"
            availability={data.transfer}
            selection={storeSelection}
          />
        ) : null}
        {data.stores.length === 0 ? (
          <EmptyState title={m.store_tracking_empty()}>{m.store_tracking_empty_hint()}</EmptyState>
        ) : (
          <DataTable
            label={m.store_tracking_table_label()}
            columns={cols}
            rows={data.stores}
            getRowId={(s) => s.id}
            page={{
              pageIndex: 0,
              pageSize: Math.max(1, data.stores.length),
              rowCount: data.stores.length,
            }}
            onPageChange={() => {}}
            labels={{
              empty: m.store_tracking_empty(),
              previous: m.store_tracking_previous(),
              next: m.store_tracking_next(),
              page: (page, pageCount) =>
                pageCount === null
                  ? m.store_tracking_page({ page: String(page) })
                  : m.store_tracking_page_of({ page: String(page), pageCount: String(pageCount) }),
            }}
          />
        )}
        <ErrorText>{action.error}</ErrorText>
        {data.removedCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {m.store_tracking_removed_count({ count: String(data.removedCount) })}
          </p>
        ) : null}
      </Section>

      {transferable && data.trackedProducts ? (
        <TrackedProductsSection
          slug={slug}
          rows={data.trackedProducts.rows}
          truncated={data.trackedProducts.truncated}
          availability={data.transfer}
        />
      ) : null}
    </div>
  )
}

const TIER_LABELS: Record<string, () => string> = {
  hot: m.transfer_actions_tier_hot,
  normal: m.transfer_actions_tier_normal,
  cold: m.transfer_actions_tier_cold,
}
const ORIGIN_LABELS: Record<string, () => string> = {
  store: m.transfer_actions_origin_store,
  lead: m.transfer_actions_origin_lead,
  manual: m.transfer_actions_origin_manual,
}

const productName = (p: TrackedProductRowView) => p.title ?? p.productId

/** 被追踪商品：只在数据流转可用时展示，供多选复制 / 移动（add-workspace-data-transfer 6.2） */
function TrackedProductsSection({
  slug,
  rows,
  truncated,
  availability,
}: {
  slug: string
  rows: TrackedProductRowView[]
  truncated: boolean
  availability: StoresData['transfer']
}) {
  const selection = useTransferSelection(rows.map((r) => r.id))
  const cols: DataTableColumn<TrackedProductRowView>[] = [
    ...selectColumn<TrackedProductRowView>(selection, productName),
    {
      id: 'product',
      header: m.transfer_actions_col_product(),
      className: 'min-w-[240px]',
      cell: (p) => (
        <div className="grid gap-0.5">
          {p.url ? (
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[13px] font-medium hover:text-primary"
            >
              {productName(p)}
            </a>
          ) : (
            <span className="text-[13px] font-medium">{productName(p)}</span>
          )}
          {p.marketplace ? (
            <span className="text-xs text-muted-foreground">{marketplaceLabel(p.marketplace)}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'tier',
      header: m.transfer_actions_col_tier(),
      cell: (p) => TIER_LABELS[p.tier]?.() ?? p.tier,
    },
    {
      id: 'origin',
      header: m.transfer_actions_col_origin(),
      cell: (p) => ORIGIN_LABELS[p.origin]?.() ?? p.origin,
    },
    {
      id: 'snapshot',
      header: m.transfer_actions_col_last_snapshot(),
      cell: (p) => <span className="text-xs tabular-nums">{p.lastSnapshotOn ?? '—'}</span>,
    },
  ]
  return (
    <Section title={m.transfer_actions_tracked_products_title()}>
      <p className="text-xs text-muted-foreground">{m.transfer_actions_tracked_products_intro()}</p>
      <TransferBar
        slug={slug}
        root="trackedProduct"
        availability={availability}
        selection={selection}
      />
      {rows.length === 0 ? (
        <EmptyState title={m.transfer_actions_tracked_products_empty()} />
      ) : (
        <DataTable
          label={m.transfer_actions_tracked_products_title()}
          columns={cols}
          rows={rows}
          getRowId={(p) => p.id}
          page={{ pageIndex: 0, pageSize: Math.max(1, rows.length), rowCount: rows.length }}
          onPageChange={() => {}}
          labels={{
            empty: m.transfer_actions_tracked_products_empty(),
            previous: m.store_tracking_previous(),
            next: m.store_tracking_next(),
            page: (page, pageCount) =>
              pageCount === null
                ? m.store_tracking_page({ page: String(page) })
                : m.store_tracking_page_of({ page: String(page), pageCount: String(pageCount) }),
          }}
        />
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          {m.transfer_actions_tracked_products_truncated({ count: String(rows.length) })}
        </p>
      ) : null}
    </Section>
  )
}
