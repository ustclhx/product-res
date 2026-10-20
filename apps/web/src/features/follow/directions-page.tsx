import { Button, Input, Tag } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Section } from '../data-center/shared.tsx'
import {
  CheckboxGroup,
  controlClass,
  EmptyState,
  ErrorText,
  Field,
  ReadOnlyNotice,
  useAction,
} from '../workbench/fields.tsx'
import {
  addDirectionSeller,
  getDirectionsPage,
  removeDirection,
  removeDirectionSeller,
  reviewDirectionSeller,
  saveDirection,
  searchDirectionCategories,
  toggleDirection,
} from './directions.functions.ts'
import type { DirectionRow, SellerRow } from './directions.server.ts'
import {
  DIRECTION_MARKETPLACES,
  type DirectionMarketplace,
  MARKETPLACE_LABELS,
  marketplaceLabel,
  splitList,
} from './marketplaces.ts'

export type DirectionsData = Awaited<ReturnType<typeof getDirectionsPage>>

const MARKETPLACE_OPTIONS = DIRECTION_MARKETPLACES.map((value) => ({
  value,
  label: MARKETPLACE_LABELS[value],
}))

/** 选品方向与对标店铺池（specs/selection-directions） */
export function DirectionsPage({ slug, initial }: { slug: string; initial: DirectionsData }) {
  const [data, setData] = useState(initial)
  const [editing, setEditing] = useState<DirectionRow | 'new' | null>(null)
  const reload = async () => setData(await getDirectionsPage({ data: { slug } }))
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <nav className="text-xs text-muted-foreground">
            <Link to="/app/$slug/follow" params={{ slug }} className="hover:text-primary">
              跟卖选品
            </Link>
            <span className="px-1">/</span>
            <span>选品方向与店铺池</span>
          </nav>
          <h1 className="text-lg font-semibold">选品方向与店铺池</h1>
          <p className="text-[13px] text-muted-foreground">
            每个方向限定平台站点、类目、关键词与关联节点；对标店铺只有种子和已接受的参与同行扩散计算。停用的方向不再进入每日流水线，历史线索保留。
          </p>
        </div>
        {data.canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新建方向
          </Button>
        ) : null}
      </div>
      <ReadOnlyNotice show={!data.canWrite} />
      {editing !== null ? (
        <DirectionForm
          slug={slug}
          nodes={data.nodes}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
          }}
        />
      ) : null}
      {data.directions.length === 0 && editing === null ? (
        <EmptyState title="还没有选品方向">
          {data.canWrite
            ? '新建一个方向，选择平台站点并填写类目或关键词，每日流水线就会按方向生成候选。'
            : '空间所有者或管理员新建方向后，这里会列出方向与店铺池。'}
        </EmptyState>
      ) : null}
      {data.directions.map((d) => (
        <DirectionCard
          key={d.id}
          slug={slug}
          direction={d}
          nodes={data.nodes}
          sellers={data.sellers.filter((s) => s.directionId === d.id)}
          trackedStores={data.trackedStores.filter((s) => s.directionIds.includes(d.id))}
          canWrite={data.canWrite}
          onEdit={() => setEditing(d)}
          onChanged={reload}
        />
      ))}
    </div>
  )
}

/** eBay 类目按名称搜索选择；没有类目数据（尚未同步）时提示手填 */
export function CategorySearch({
  slug,
  onPick,
}: {
  slug: string
  onPick: (categoryId: string) => void
}) {
  const [q, setQ] = useState('')
  const [options, setOptions] = useState<{
    q: string
    items: Awaited<ReturnType<typeof searchDirectionCategories>>
  } | null>(null)
  const [failed, setFailed] = useState(false)
  async function search() {
    setFailed(false)
    try {
      setOptions({
        q,
        items: await searchDirectionCategories({ data: { slug, marketplace: 'ebay-us', q } }),
      })
    } catch {
      setFailed(true)
    }
  }
  return (
    <div className="grid gap-1.5" data-testid="category-search">
      <div className="flex gap-2">
        <Input
          aria-label="按名称搜索 eBay 类目"
          placeholder="按名称搜索 eBay 类目"
          className="h-8 text-[13px]"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void search()
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={!q.trim()} onClick={search}>
          搜索
        </Button>
      </div>
      {failed ? <p className="text-xs text-destructive">类目搜索失败，可直接手填 ID</p> : null}
      {options && options.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          没有匹配的类目（类目数据每周一同步，尚未同步时请手填 ID）
        </p>
      ) : null}
      {options && options.items.length > 0 ? (
        <ul className="grid max-h-48 gap-1 overflow-auto text-xs">
          {options.items.map((item) => (
            <li key={item.categoryId}>
              <button
                type="button"
                className="w-full rounded border px-2 py-1 text-left hover:bg-muted"
                onClick={() => onPick(item.categoryId)}
              >
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {item.categoryId}
                  {item.leaf ? '' : ' · 非叶子'} · {item.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function DirectionForm({
  slug,
  nodes,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  nodes: DirectionsData['nodes']
  initial: DirectionRow | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [marketplaces, setMarketplaces] = useState<DirectionMarketplace[]>(
    (initial?.marketplaces ?? []).filter((m): m is DirectionMarketplace =>
      (DIRECTION_MARKETPLACES as readonly string[]).includes(m),
    ),
  )
  const [categories, setCategories] = useState(initial?.categoryIds.join(', ') ?? '')
  const [keywords, setKeywords] = useState(initial?.keywords.join('\n') ?? '')
  const [nodeIds, setNodeIds] = useState<string[]>(initial?.nodeIds ?? [])
  const [note, setNote] = useState(initial?.note ?? '')
  const { busy, error, setError, run } = useAction(onSaved)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('请填写方向名称')
    if (marketplaces.length === 0) return setError('至少选择一个平台站点')
    await run(() =>
      saveDirection({
        data: {
          slug,
          ...(initial ? { id: initial.id } : {}),
          direction: {
            name,
            marketplaces,
            categoryIds: splitList(categories),
            keywords: splitList(keywords),
            nodeIds,
            note: note || null,
          },
        },
      }),
    )
  }

  return (
    <Section title={initial ? `编辑方向：${initial.name}` : '新建方向'}>
      <form className="grid gap-3" onSubmit={submit} aria-label="选品方向">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="方向名称">
            {(id) => (
              <Input
                id={id}
                className="h-8 text-[13px]"
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-2">
            <Field label="类目 ID" hint="平台类目 ID，多个用逗号分隔">
              {(id) => (
                <Input
                  id={id}
                  className="h-8 text-[13px]"
                  value={categories}
                  onChange={(e) => setCategories(e.target.value)}
                />
              )}
            </Field>
            {marketplaces.includes('ebay-us') ? (
              <CategorySearch
                slug={slug}
                onPick={(categoryId) =>
                  setCategories((current) => splitList(`${current},${categoryId}`).join(', '))
                }
              />
            ) : null}
          </div>
        </div>
        <CheckboxGroup
          label="平台与站点"
          options={MARKETPLACE_OPTIONS}
          value={marketplaces}
          onChange={setMarketplaces}
        />
        <Field label="关键词" hint="每行一个，或用逗号分隔">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              className={`${controlClass} h-auto py-1.5`}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          )}
        </Field>
        <CheckboxGroup
          label="关联节点"
          options={nodes.map((n) => ({ value: n.id, label: n.name }))}
          value={nodeIds}
          onChange={setNodeIds}
          empty="节点日历为空，可在“设置 · 节点日历”中添加"
        />
        <Field label="备注">
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
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      </form>
    </Section>
  )
}

const SELLER_STATUS: Record<
  SellerRow['status'],
  { label: string; tone: 'info' | 'success' | 'warning' | 'neutral' }
> = {
  seed: { label: '种子', tone: 'info' },
  accepted: { label: '已接受', tone: 'success' },
  suggested: { label: '系统推荐', tone: 'warning' },
  rejected: { label: '已拒绝', tone: 'neutral' },
}

function DirectionCard({
  slug,
  direction: d,
  nodes,
  sellers,
  trackedStores,
  canWrite,
  onEdit,
  onChanged,
}: {
  slug: string
  direction: DirectionRow
  nodes: DirectionsData['nodes']
  sellers: SellerRow[]
  trackedStores: DirectionsData['trackedStores']
  canWrite: boolean
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const { busy, error, run } = useAction(onChanged)
  const nodeNames = d.nodeIds
    .map((id) => nodes.find((n) => n.id === id)?.name)
    .filter((n): n is string => Boolean(n))
  const pool = sellers.filter((s) => s.status === 'seed' || s.status === 'accepted')
  const suggested = sellers.filter((s) => s.status === 'suggested')
  const rejected = sellers.filter((s) => s.status === 'rejected')

  return (
    <section
      className="grid gap-3 rounded-lg border bg-card p-4 text-[13px]"
      data-testid="direction-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{d.name}</h2>
            <Tag tone={d.enabled ? 'success' : 'neutral'}>{d.enabled ? '启用中' : '已停用'}</Tag>
          </div>
          {d.note ? <p className="text-xs text-muted-foreground">{d.note}</p> : null}
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(() => toggleDirection({ data: { slug, id: d.id, enabled: !d.enabled } }))
              }
            >
              {d.enabled ? '停用' : '启用'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`删除方向“${d.name}”及其店铺池？`))
                  void run(() => removeDirection({ data: { slug, id: d.id } }))
              }}
            >
              删除
            </Button>
          </div>
        ) : null}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="平台与站点">
          {d.marketplaces.map((m) => (
            <Tag key={m} tone="info">
              {marketplaceLabel(m)}
            </Tag>
          ))}
        </Meta>
        <Meta label="类目 ID">{d.categoryIds.length ? d.categoryIds.join('、') : null}</Meta>
        <Meta label="关键词">{d.keywords.length ? d.keywords.join('、') : null}</Meta>
        <Meta label="关联节点">{nodeNames.length ? nodeNames.join('、') : null}</Meta>
      </dl>
      <ErrorText>{error}</ErrorText>

      <div className="grid gap-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">对标店铺池（{pool.length}）</h3>
        </div>
        {pool.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有对标店铺。添加种子店铺后，系统会按同款重合度推荐更多店铺。
          </p>
        ) : (
          <ul className="grid gap-1">
            {pool.map((s) => (
              <SellerItem key={s.id} seller={s}>
                {canWrite ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(() => removeDirectionSeller({ data: { slug, id: s.id } }))}
                  >
                    移出
                  </Button>
                ) : null}
              </SellerItem>
            ))}
          </ul>
        )}
        {trackedStores.length > 0 ? (
          <div className="grid gap-1" data-testid="direction-tracked-stores">
            <p className="text-xs text-muted-foreground">
              来自店铺追踪（{trackedStores.length}），同样参与同行扩散，在店铺追踪页管理：
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {trackedStores.map((s) => (
                <li key={s.id}>
                  <Link
                    to="/app/$slug/stores/$storeId"
                    params={{ slug, storeId: s.id }}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:text-primary"
                  >
                    {s.displayName ?? s.sellerKey}
                    <span className="text-muted-foreground">{marketplaceLabel(s.marketplace)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {canWrite ? <SeedForm slug={slug} direction={d} busy={busy} run={run} /> : null}
      </div>

      {suggested.length > 0 ? (
        <div className="grid gap-2 border-t pt-3">
          <h3 className="text-[13px] font-medium">系统推荐（{suggested.length}）</h3>
          <ul className="grid gap-1">
            {suggested.map((s) => (
              <SellerItem key={s.id} seller={s}>
                {canWrite ? (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          reviewDirectionSeller({ data: { slug, id: s.id, decision: 'accept' } }),
                        )
                      }
                    >
                      接受
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          reviewDirectionSeller({ data: { slug, id: s.id, decision: 'reject' } }),
                        )
                      }
                    >
                      拒绝
                    </Button>
                  </div>
                ) : null}
              </SellerItem>
            ))}
          </ul>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            已拒绝 {rejected.length} 家（不参与计算，也不会再被推荐；重新添加为种子即可恢复）
          </summary>
          <ul className="mt-2 grid gap-1">
            {rejected.map((s) => (
              <SellerItem key={s.id} seller={s} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || (Array.isArray(children) && children.length === 0)
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap gap-1">
        {empty ? <span className="text-muted-foreground">—</span> : children}
      </dd>
    </div>
  )
}

function SellerItem({ seller: s, children }: { seller: SellerRow; children?: ReactNode }) {
  const status = SELLER_STATUS[s.status]
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Tag tone={status.tone}>{status.label}</Tag>
        <span className="text-xs text-muted-foreground">{marketplaceLabel(s.marketplace)}</span>
        <span className="font-mono text-xs">{s.sellerPlatformId}</span>
        {s.sellerName ? <span>{s.sellerName}</span> : null}
        {s.reason ? <span className="text-xs text-muted-foreground">依据：{s.reason}</span> : null}
      </div>
      {children}
    </li>
  )
}

function SeedForm({
  slug,
  direction: d,
  busy,
  run,
}: {
  slug: string
  direction: DirectionRow
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<boolean>
}) {
  const options = d.marketplaces.filter((m): m is DirectionMarketplace =>
    (DIRECTION_MARKETPLACES as readonly string[]).includes(m),
  )
  const [marketplace, setMarketplace] = useState<DirectionMarketplace | ''>(options[0] ?? '')
  const [sellerId, setSellerId] = useState('')
  const [sellerName, setSellerName] = useState('')
  if (options.length === 0) return null
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={`为${d.name}添加种子店铺`}
      onSubmit={async (e) => {
        e.preventDefault()
        if (!marketplace || !sellerId.trim()) return
        const ok = await run(() =>
          addDirectionSeller({
            data: {
              slug,
              directionId: d.id,
              marketplace,
              sellerPlatformId: sellerId,
              sellerName: sellerName || null,
            },
          }),
        )
        if (ok) {
          setSellerId('')
          setSellerName('')
        }
      }}
    >
      <Field label="站点" className="w-32">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={marketplace}
            onChange={(e) => setMarketplace(e.target.value as DirectionMarketplace)}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {MARKETPLACE_LABELS[m]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="卖家 ID" className="w-48">
        {(id) => (
          <Input
            id={id}
            className="h-8 text-[13px]"
            value={sellerId}
            maxLength={128}
            onChange={(e) => setSellerId(e.target.value)}
          />
        )}
      </Field>
      <Field label="店铺名（可选）" className="w-48">
        {(id) => (
          <Input
            id={id}
            className="h-8 text-[13px]"
            value={sellerName}
            maxLength={128}
            onChange={(e) => setSellerName(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" size="sm" variant="outline" disabled={busy || !sellerId.trim()}>
        添加种子店铺
      </Button>
    </form>
  )
}
