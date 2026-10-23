import { formatInterval } from '@product-res/datasources'
import { Button, DataTable, type DataTableColumn, Tag } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { Section } from '../data-center/shared.tsx'
import { ProductThumb } from '../follow/follow-ui.tsx'
import { ErrorText, useAction } from '../workbench/fields.tsx'
import { getStoreDetail, updateTrackedStore } from './store-tracking.functions.ts'
import type { ListingItem } from './store-tracking.server.ts'
import {
  DisabledSourceNotice,
  formatPercent,
  formatTime,
  StoreBadges,
  StoreSettingsForm,
  TIER_TONE,
  tierLabel,
  tierReasonLabel,
  toSettingsInput,
} from './store-ui.tsx'

export type StoreDetailData = Awaited<ReturnType<typeof getStoreDetail>>

const PAGE_SIZE = 20
const empty = () => m.store_tracking_empty_value()

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-1 rounded-lg border bg-background p-3" data-testid="store-metric">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value ?? empty()}</span>
      {value === null ? (
        <span className="text-[11px] text-muted-foreground">
          {m.store_tracking_metric_empty_hint()}
        </span>
      ) : null}
    </div>
  )
}

const listingColumns = (platform: 'ebay' | 'amazon'): DataTableColumn<ListingItem>[] => [
  {
    id: 'product',
    header: m.store_tracking_col_product(),
    className: 'min-w-[240px]',
    cell: (l) => (
      <div className="flex items-center gap-3">
        <ProductThumb src={l.imageUrl} title={l.title ?? l.platformId} />
        <div className="grid min-w-0 gap-0.5">
          {l.url ? (
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              className="line-clamp-2 text-[13px] font-medium leading-snug hover:text-primary"
            >
              {l.title ?? l.platformId}
            </a>
          ) : (
            <span className="line-clamp-2 text-[13px] font-medium">{l.title ?? l.platformId}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {platform === 'amazon' ? 'ASIN' : 'Item'}: {l.platformId}
          </span>
        </div>
      </div>
    ),
  },
  {
    id: 'firstSeen',
    header: m.store_tracking_col_first_seen(),
    cell: (l) => <span className="text-xs tabular-nums">{l.firstSeenOn}</span>,
  },
  {
    id: 'listed',
    header: m.store_tracking_col_listed(),
    cell: (l) => (
      <div className="grid gap-0.5 text-xs">
        <span className="tabular-nums">{l.listedOn ?? m.store_tracking_unknown_listed()}</span>
        {l.isNew === true ? (
          <Tag tone="success">{m.store_tracking_new_badge()}</Tag>
        ) : l.isNew === false ? (
          <Tag tone="neutral">{m.store_tracking_old_badge()}</Tag>
        ) : null}
      </div>
    ),
  },
  {
    id: 'tier',
    header: m.store_tracking_col_tier(),
    cell: (l) => (
      <div className="grid gap-0.5">
        {l.tier ? (
          <Tag tone={TIER_TONE[l.tier]}>{tierLabel(l.tier)}</Tag>
        ) : (
          <span className="text-xs text-muted-foreground">{tierLabel(null)}</span>
        )}
        {l.tierReason ? (
          <span className="text-[11px] text-muted-foreground">{tierReasonLabel(l.tierReason)}</span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'signal',
    header: m.store_tracking_col_signal(),
    cell: (l) =>
      l.signal ? (
        <div className="grid gap-0.5 text-xs">
          <span className="tabular-nums">{l.signal.on}</span>
          <span className="text-muted-foreground">
            {l.signal.kind === 'amazon-bought'
              ? `${m.store_tracking_signal_amazon()} ${formatInterval(l.signal.low, l.signal.high)}`
              : `${m.store_tracking_signal_ebay()} +${l.signal.low}`}
          </span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{empty()}</span>
      ),
  },
  {
    id: 'sales',
    header: m.store_tracking_col_sales(),
    cell: (l) => (
      <span className="tabular-nums">
        {l.sales ? formatInterval(l.sales.low, l.sales.high) : empty()}
      </span>
    ),
  },
  {
    id: 'state',
    header: m.store_tracking_col_listing_status(),
    cell: (l) =>
      l.delistedOn ? (
        <span className="text-xs text-muted-foreground">
          {m.store_tracking_delisted({ date: l.delistedOn })}
        </span>
      ) : (
        <span className="text-xs">{m.store_tracking_on_sale()}</span>
      ),
  },
]

/** 店铺详情：覆盖率说明、店铺指标、新品列表（档位、出单信号、区间）与设置 */
export function StoreDetailPage({ slug, initial }: { slug: string; initial: StoreDetailData }) {
  const [data, setData] = useState(initial)
  // 路由返回缓存数据后会在后台重新加载：加载结果更新时同步到页面
  useEffect(() => setData(initial), [initial])
  const [editing, setEditing] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const reload = async () => setData(await getStoreDetail({ data: { slug, id: data.store.id } }))
  const { busy, error, run } = useAction(reload)
  const { store, metrics, coverage } = data
  const rows = data.listings.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)
  const notConfigured = store.source === 'not-configured' || store.source === 'unregistered'

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <nav className="text-xs text-muted-foreground">
          <Link to="/app/$slug/stores" params={{ slug }} className="hover:text-primary">
            {m.store_tracking_back()}
          </Link>
          <span className="px-1">/</span>
          <span>{store.displayName}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{store.displayName}</h1>
          <StoreBadges store={store} />
        </div>
        <p className="text-xs text-muted-foreground">
          {store.sellerKey}
          {store.url ? (
            <>
              {' · '}
              <a
                href={store.url}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:text-primary"
              >
                {m.store_tracking_open_store()}
              </a>
            </>
          ) : null}
          {' · '}
          {m.store_tracking_col_last_sync()}: {formatTime(store.lastSyncAt)}
        </p>
      </div>

      <DisabledSourceNotice slug={slug} sources={data.disabledSources} />

      <Section title={m.store_tracking_coverage_title()}>
        <div className="grid gap-1 text-[13px]" data-testid="store-coverage">
          <p>
            {coverage.method === 'search-offer'
              ? m.store_tracking_coverage_amazon()
              : m.store_tracking_coverage_ebay()}
          </p>
          {store.platform === 'amazon' ? (
            <p className="text-xs text-muted-foreground">
              {store.searchKeywords.length > 0
                ? m.store_tracking_coverage_keywords({ keywords: store.searchKeywords.join('、') })
                : m.store_tracking_coverage_no_keywords()}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {m.store_tracking_coverage_found({ count: String(coverage.found30d) })}
          </p>
          {notConfigured ? (
            <p className="text-xs text-warning-strong">
              {store.platform === 'ebay'
                ? m.store_tracking_ebay_not_configured()
                : m.store_tracking_amazon_not_configured()}
            </p>
          ) : null}
        </div>
      </Section>

      <Section title={m.store_tracking_metrics_title()}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Metric
            label={m.store_tracking_metric_new_per_week()}
            value={metrics.newPerWeek === null ? null : String(metrics.newPerWeek)}
          />
          <Metric
            label={m.store_tracking_metric_survival()}
            value={metrics.survivalRate === null ? null : formatPercent(metrics.survivalRate)}
          />
          <Metric
            label={m.store_tracking_metric_hit_rate()}
            value={metrics.hitRate === null ? null : formatPercent(metrics.hitRate)}
          />
          <Metric
            label={m.store_tracking_metric_sales_sum()}
            value={
              metrics.salesSum === null
                ? null
                : formatInterval(metrics.salesSum.low, metrics.salesSum.high)
            }
          />
          <Metric
            label={m.store_tracking_metric_shift()}
            value={metrics.directionShift === null ? null : formatPercent(metrics.directionShift)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {m.store_tracking_metrics_sample({ count: String(metrics.sample) })}
        </p>
      </Section>

      {data.canWrite ? (
        <Section
          title={m.store_tracking_edit()}
          actions={
            editing ? null : (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                {m.store_tracking_edit()}
              </Button>
            )
          }
        >
          {editing ? (
            <StoreSettingsForm
              initial={{
                kind: store.kind,
                directionIds: store.directionIds,
                keywords: store.keywords,
                displayName: store.displayName,
                reason: store.reason ?? '',
              }}
              directions={data.directions.filter((d) => d.marketplaces.includes(store.marketplace))}
              platform={store.platform}
              busy={busy}
              error={error}
              onCancel={() => setEditing(false)}
              onSubmit={async (value) => {
                const ok = await run(() =>
                  updateTrackedStore({ data: { slug, id: store.id, ...toSettingsInput(value) } }),
                )
                if (ok) setEditing(false)
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {[store.directionNames.join('、'), store.reason].filter(Boolean).join(' · ') ||
                empty()}
            </p>
          )}
          {!editing ? <ErrorText>{error}</ErrorText> : null}
        </Section>
      ) : null}

      <Section title={m.store_tracking_listings_title()}>
        <DataTable
          label={m.store_tracking_listings_label()}
          columns={listingColumns(store.platform)}
          rows={rows}
          getRowId={(l) => l.productId}
          page={{ pageIndex, pageSize: PAGE_SIZE, rowCount: data.listings.length }}
          onPageChange={setPageIndex}
          labels={{
            empty: m.store_tracking_listings_empty(),
            previous: m.store_tracking_previous(),
            next: m.store_tracking_next(),
            page: (page, pageCount) =>
              pageCount === null
                ? m.store_tracking_page({ page: String(page) })
                : m.store_tracking_page_of({ page: String(page), pageCount: String(pageCount) }),
          }}
        />
      </Section>
    </div>
  )
}
