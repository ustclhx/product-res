import { Button, cn, Input, Tag } from '@product-res/ui'
import { type FormEvent, useState } from 'react'
import {
  type CostingSettingsData,
  CostParamsTab,
  LogisticsTab,
  useCostingSettings,
} from '../costing/settings-tabs.tsx'
import { Section, SimpleTable } from '../data-center/shared.tsx'
import {
  DIRECTION_MARKETPLACES,
  type DirectionMarketplace,
  MARKETPLACE_LABELS,
  marketplaceLabel,
  splitList,
} from '../follow/marketplaces.ts'
import {
  controlClass,
  EmptyState,
  ErrorText,
  Field,
  ReadOnlyNotice,
  useAction,
} from '../workbench/fields.tsx'
import {
  getConfigPage,
  removeBrandEntry,
  removeRiskRule,
  removeSeasonalNode,
  saveBrandEntry,
  saveRiskRule,
  saveSeasonalNode,
} from './config.functions.ts'
import type { BrandRow, NodeRow, RuleRow } from './config.server.ts'
import {
  BRAND_KIND_LABELS,
  BRAND_KINDS,
  RULE_KIND_LABELS,
  RULE_KINDS,
  RULE_LEVEL_LABELS,
  RULE_LEVELS,
} from './labels.ts'

export type ConfigData = Awaited<ReturnType<typeof getConfigPage>>

const TABS = [
  ['nodes', '节点日历'],
  ['brands', '品牌库'],
  ['rules', '风险规则'],
  ['logistics', '物流方案'],
  ['costs', '成本参数'],
] as const
type Tab = (typeof TABS)[number][0]

/** 设置页（docs/plan/selection-workbench.md §4）：节点日历、品牌库、风险规则、物流方案与成本参数 */
export function ConfigPage({
  slug,
  initial,
  costing: costingInitial,
}: {
  slug: string
  initial: ConfigData
  costing: CostingSettingsData
}) {
  const [tab, setTab] = useState<Tab>('nodes')
  const [data, setData] = useState(initial)
  const costing = useCostingSettings(slug, costingInitial)
  const reload = async () => setData(await getConfigPage({ data: { slug } }))
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="text-[13px] text-muted-foreground">
          节点日历、品牌库、风险规则、物流方案与成本参数由团队维护，次日流水线起生效。
        </p>
      </div>
      <ReadOnlyNotice show={!data.canWrite} />
      <div role="tablist" aria-label="设置" className="flex flex-wrap gap-1 border-b">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground',
            )}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'nodes' ? (
        <NodesTab slug={slug} rows={data.nodes} canWrite={data.canWrite} onChanged={reload} />
      ) : null}
      {tab === 'brands' ? (
        <BrandsTab slug={slug} rows={data.brands} canWrite={data.canWrite} onChanged={reload} />
      ) : null}
      {tab === 'rules' ? (
        <RulesTab slug={slug} rows={data.rules} canWrite={data.canWrite} onChanged={reload} />
      ) : null}
      {tab === 'logistics' ? (
        <LogisticsTab slug={slug} data={costing.data} onChanged={costing.reload} />
      ) : null}
      {tab === 'costs' ? (
        <CostParamsTab slug={slug} data={costing.data} onChanged={costing.reload} />
      ) : null}
    </div>
  )
}

interface TabProps<T> {
  slug: string
  rows: T[]
  canWrite: boolean
  onChanged: () => Promise<void>
}

const PLATFORM_LABELS = { amazon: 'Amazon', ebay: 'eBay' } as const

const pad = (n: number) => String(n).padStart(2, '0')

function RowActions({
  canWrite,
  busy,
  onEdit,
  onDelete,
}: {
  canWrite: boolean
  busy: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  if (!canWrite) return null
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>
        编辑
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={onDelete}
        disabled={busy}
      >
        删除
      </Button>
    </div>
  )
}

function FormActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? '保存中…' : '保存'}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>
        取消
      </Button>
    </div>
  )
}

// ---- 节点日历 ----

function NodesTab({ slug, rows, canWrite, onChanged }: TabProps<NodeRow>) {
  const [editing, setEditing] = useState<NodeRow | 'new' | null>(null)
  const { busy, error, run } = useAction(onChanged)
  return (
    <Section
      title="节点日历"
      actions={
        canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增节点
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        日期为每年的起卖日，销售期从起卖日起算。母亲节、黑五等按星期计算的节点使用近似日期，请每年核对。
      </p>
      {editing !== null ? (
        <NodeForm
          slug={slug}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await onChanged()
          }}
        />
      ) : null}
      <ErrorText>{error}</ErrorText>
      {rows.length === 0 ? (
        <EmptyState title="节点日历为空">新增节点后可在选品方向中关联。</EmptyState>
      ) : (
        <SimpleTable head={['节点', '起卖日', '销售期', '关联关键词', '']}>
          {rows.map((n) => (
            <tr key={n.id}>
              <td className="px-3 py-2">
                <span className="font-medium">{n.name}</span>
                {n.preset ? (
                  <Tag className="ml-2" tone="neutral">
                    预置
                  </Tag>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                {pad(n.startMonth)}-{pad(n.startDay)}
              </td>
              <td className="px-3 py-2">{n.salesDays} 天</td>
              <td className="px-3 py-2 text-muted-foreground">{n.keywords.join('、') || '—'}</td>
              <td className="px-3 py-2">
                <RowActions
                  canWrite={canWrite}
                  busy={busy}
                  onEdit={() => setEditing(n)}
                  onDelete={() => {
                    if (window.confirm(`删除节点“${n.name}”？关联它的方向会同时取消关联。`))
                      void run(() => removeSeasonalNode({ data: { slug, id: n.id } }))
                  }}
                />
              </td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  )
}

function NodeForm({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  initial: NodeRow | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [date, setDate] = useState(
    initial ? `${pad(initial.startMonth)}-${pad(initial.startDay)}` : '',
  )
  const [salesDays, setSalesDays] = useState(String(initial?.salesDays ?? 30))
  const [keywords, setKeywords] = useState(initial?.keywords.join(', ') ?? '')
  const { busy, error, setError, run } = useAction(onSaved)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(date.trim())
    const month = Number(m?.[1])
    const day = Number(m?.[2])
    const days = Number(salesDays)
    if (!name.trim()) return setError('请填写节点名称')
    if (!m || month < 1 || month > 12 || day < 1 || day > 31)
      return setError('起卖日格式为 月-日，如 07-15')
    if (!Number.isInteger(days) || days < 1 || days > 366)
      return setError('销售期为 1–366 天的整数')
    await run(() =>
      saveSeasonalNode({
        data: {
          slug,
          ...(initial ? { id: initial.id } : {}),
          node: {
            name,
            startMonth: month,
            startDay: day,
            salesDays: days,
            keywords: splitList(keywords),
          },
        },
      }),
    )
  }

  return (
    <form
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={submit}
      aria-label="节点"
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="节点名称">
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
        <Field label="起卖日（月-日）">
          {(id) => (
            <Input
              id={id}
              className="h-8 font-mono text-[13px]"
              placeholder="07-15"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="销售期（天）">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={366}
              className="h-8 text-[13px]"
              value={salesDays}
              onChange={(e) => setSalesDays(e.target.value)}
            />
          )}
        </Field>
        <Field label="关联关键词" hint="逗号分隔">
          {(id) => (
            <Input
              id={id}
              className="h-8 text-[13px]"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          )}
        </Field>
      </div>
      <ErrorText>{error}</ErrorText>
      <FormActions busy={busy} onCancel={onClose} />
    </form>
  )
}

// ---- 品牌库 ----

function BrandsTab({ slug, rows, canWrite, onChanged }: TabProps<BrandRow>) {
  const [editing, setEditing] = useState<BrandRow | 'new' | null>(null)
  const { busy, error, run } = useAction(onChanged)
  return (
    <Section
      title="品牌库"
      actions={
        canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增条目
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        标题或品牌属性命中品牌库的商品簇会出现品牌风险；Amazon 品牌备案的直接跟卖一票否决。
      </p>
      {editing !== null ? (
        <BrandForm
          slug={slug}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await onChanged()
          }}
        />
      ) : null}
      <ErrorText>{error}</ErrorText>
      {rows.length === 0 ? (
        <EmptyState title="品牌库为空">添加需要规避的品牌、VeRO 权利人或品牌备案品牌。</EmptyState>
      ) : (
        <SimpleTable head={['品牌', '类型', '平台', '备注', '']}>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className="px-3 py-2 font-medium">{b.name}</td>
              <td className="px-3 py-2">
                <Tag tone={b.kind === 'brand' ? 'neutral' : 'warning'}>
                  {BRAND_KIND_LABELS[b.kind]}
                </Tag>
              </td>
              <td className="px-3 py-2">
                {b.marketplace ? marketplaceLabel(b.marketplace) : '全部'}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{b.note || '—'}</td>
              <td className="px-3 py-2">
                <RowActions
                  canWrite={canWrite}
                  busy={busy}
                  onEdit={() => setEditing(b)}
                  onDelete={() => {
                    if (window.confirm(`删除品牌库条目“${b.name}”？`))
                      void run(() => removeBrandEntry({ data: { slug, id: b.id } }))
                  }}
                />
              </td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  )
}

function BrandForm({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  initial: BrandRow | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<BrandRow['kind']>(initial?.kind ?? 'brand')
  const [marketplace, setMarketplace] = useState<DirectionMarketplace | ''>(
    (initial?.marketplace as DirectionMarketplace | null) ?? '',
  )
  const [note, setNote] = useState(initial?.note ?? '')
  const { busy, error, setError, run } = useAction(onSaved)
  return (
    <form
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      aria-label="品牌库条目"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!name.trim()) return setError('请填写品牌名')
        await run(() =>
          saveBrandEntry({
            data: {
              slug,
              ...(initial ? { id: initial.id } : {}),
              brand: { name, kind, marketplace: marketplace || null, note: note || null },
            },
          }),
        )
      }}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="品牌名">
          {(id) => (
            <Input
              id={id}
              className="h-8 text-[13px]"
              value={name}
              maxLength={128}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="类型">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as BrandRow['kind'])}
            >
              {BRAND_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BRAND_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="平台">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value as DirectionMarketplace | '')}
            >
              <option value="">全部平台</option>
              {DIRECTION_MARKETPLACES.map((m) => (
                <option key={m} value={m}>
                  {MARKETPLACE_LABELS[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
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
      </div>
      <ErrorText>{error}</ErrorText>
      <FormActions busy={busy} onCancel={onClose} />
    </form>
  )
}

// ---- 风险规则 ----

function RulesTab({ slug, rows, canWrite, onChanged }: TabProps<RuleRow>) {
  const [editing, setEditing] = useState<RuleRow | 'new' | null>(null)
  const { busy, error, run } = useAction(onChanged)
  return (
    <Section
      title="风险规则"
      actions={
        canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增规则
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        按类目 ID 或商品属性（如 battery、liquid）匹配商品；勾选“一票否决”的规则命中时线索被否决。
      </p>
      {editing !== null ? (
        <RuleForm
          slug={slug}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await onChanged()
          }}
        />
      ) : null}
      <ErrorText>{error}</ErrorText>
      {rows.length === 0 ? (
        <EmptyState title="还没有风险规则">
          添加受限类目、认证要求、危险品或禁运属性规则。
        </EmptyState>
      ) : (
        <SimpleTable head={['类型', '等级', '匹配条件', '说明', '状态', '']}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2">{RULE_KIND_LABELS[r.kind]}</td>
              <td className="px-3 py-2">
                <Tag tone={RULE_LEVEL_LABELS[r.level].tone}>{RULE_LEVEL_LABELS[r.level].label}</Tag>
                {r.veto ? (
                  <Tag className="ml-1" tone="danger">
                    一票否决
                  </Tag>
                ) : null}
              </td>
              <td className="px-3 py-2 text-xs">
                {r.match.categoryIds.length ? (
                  <div>类目：{r.match.categoryIds.join('、')}</div>
                ) : null}
                {r.match.attributes.length ? (
                  <div>属性：{r.match.attributes.join('、')}</div>
                ) : null}
                <div className="text-muted-foreground">
                  平台：{r.match.platform ? PLATFORM_LABELS[r.match.platform] : '全部'}
                </div>
              </td>
              <td className="px-3 py-2">{r.description}</td>
              <td className="px-3 py-2">
                <Tag tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? '启用' : '停用'}</Tag>
              </td>
              <td className="px-3 py-2">
                <RowActions
                  canWrite={canWrite}
                  busy={busy}
                  onEdit={() => setEditing(r)}
                  onDelete={() => {
                    if (window.confirm('删除这条风险规则？'))
                      void run(() => removeRiskRule({ data: { slug, id: r.id } }))
                  }}
                />
              </td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  )
}

function RuleForm({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  initial: RuleRow | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState<RuleRow['kind']>(initial?.kind ?? 'restricted-category')
  const [level, setLevel] = useState<RuleRow['level']>(initial?.level ?? 'high')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [categories, setCategories] = useState(initial?.match.categoryIds.join(', ') ?? '')
  const [attributes, setAttributes] = useState(initial?.match.attributes.join(', ') ?? '')
  const [platform, setPlatform] = useState<'amazon' | 'ebay' | ''>(initial?.match.platform ?? '')
  const [veto, setVeto] = useState(initial?.veto ?? false)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const { busy, error, setError, run } = useAction(onSaved)
  return (
    <form
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      aria-label="风险规则"
      onSubmit={async (e) => {
        e.preventDefault()
        const categoryIds = splitList(categories)
        const attrs = splitList(attributes)
        if (!description.trim()) return setError('请填写说明')
        if (categoryIds.length === 0 && attrs.length === 0)
          return setError('至少填写一个类目 ID 或商品属性')
        await run(() =>
          saveRiskRule({
            data: {
              slug,
              ...(initial ? { id: initial.id } : {}),
              rule: {
                kind,
                level,
                description,
                veto,
                enabled,
                match: { platform: platform || null, categoryIds, attributes: attrs },
              },
            },
          }),
        )
      }}
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="类型">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as RuleRow['kind'])}
            >
              {RULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RULE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="等级">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={level}
              onChange={(e) => setLevel(e.target.value as RuleRow['level'])}
            >
              {RULE_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {RULE_LEVEL_LABELS[l].label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="说明">
          {(id) => (
            <Input
              id={id}
              className="h-8 text-[13px]"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <Field label="类目 ID" hint="逗号分隔">
          {(id) => (
            <Input
              id={id}
              className="h-8 text-[13px]"
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
            />
          )}
        </Field>
        <Field label="商品属性" hint="逗号分隔，如 battery, liquid">
          {(id) => (
            <Input
              id={id}
              className="h-8 text-[13px]"
              value={attributes}
              onChange={(e) => setAttributes(e.target.value)}
            />
          )}
        </Field>
        <Field label="适用平台">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={platform}
              onChange={(e) => setPlatform(e.target.value as 'amazon' | 'ebay' | '')}
            >
              <option value="">全部平台</option>
              <option value="amazon">{PLATFORM_LABELS.amazon}</option>
              <option value="ebay">{PLATFORM_LABELS.ebay}</option>
            </select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={veto}
            onChange={(e) => setVeto(e.target.checked)}
          />
          一票否决
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <FormActions busy={busy} onCancel={onClose} />
    </form>
  )
}
