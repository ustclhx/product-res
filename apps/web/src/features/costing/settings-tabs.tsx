import type { CostParams, LogisticsType, Platform, ShippingFormula } from '@product-res/costing'
import { Button, Input, Tag } from '@product-res/ui'
import { type FormEvent, useState } from 'react'
import { Section, SimpleTable } from '../data-center/shared.tsx'
import { splitList } from '../follow/marketplaces.ts'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import {
  formatMoney,
  formatRate,
  moneyInput,
  numberInput,
  parseMoney,
  parseNumber,
  parsePercent,
  percentInput,
} from './format.ts'
import {
  COSTING_PLATFORMS,
  LOGISTICS_TYPE_LABELS,
  LOGISTICS_TYPE_RULES,
  LOGISTICS_TYPES,
  PLATFORM_LABELS,
} from './labels.ts'
import {
  getCostingSettings,
  removeCostParam,
  removeLogisticsProfile,
  saveCostParam,
  saveLogisticsProfile,
} from './settings.functions.ts'
import type { CostParamView, LogisticsProfileView } from './settings.server.ts'

export type CostingSettingsData = Awaited<ReturnType<typeof getCostingSettings>>

interface TabProps {
  slug: string
  data: CostingSettingsData
  onChanged: () => Promise<void>
}

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

const small = 'h-8 text-[13px]'

// ---- 计费公式 ----

/** 界面上的三种计费方式；体积重 = 首重续重 + 体积重系数（与 packages/costing 一致） */
type FormulaMode = 'first-additional' | 'volumetric' | 'volume'
const FORMULA_LABELS: Record<FormulaMode, string> = {
  'first-additional': '首重续重',
  volumetric: '体积重系数',
  volume: '按方计费',
}

export function describeFormula(f: ShippingFormula | null): string {
  if (!f) return '—'
  if (f.kind === 'volume')
    return `按方 ${formatMoney(f.pricePerCbmMinor, f.currency)}/m³${f.minCbm ? `，最低 ${f.minCbm} m³` : ''}`
  const base = `首重 ${f.firstWeightG}g ${formatMoney(f.firstPriceMinor, f.currency)}，续重每 ${f.stepWeightG}g ${formatMoney(f.stepPriceMinor, f.currency)}`
  return f.volumetricDivisor ? `${base}；体积重系数 ${f.volumetricDivisor}` : base
}

interface FormulaDraft {
  mode: FormulaMode
  currency: string
  firstWeightG: string
  firstPrice: string
  stepWeightG: string
  stepPrice: string
  divisor: string
  perCbm: string
  minCbm: string
}

function draftOf(f: ShippingFormula | null): FormulaDraft {
  if (f?.kind === 'volume')
    return {
      ...draftOf(null),
      mode: 'volume',
      currency: f.currency,
      perCbm: moneyInput(f.pricePerCbmMinor),
      minCbm: numberInput(f.minCbm),
    }
  return {
    mode: f?.volumetricDivisor ? 'volumetric' : 'first-additional',
    currency: f?.currency ?? 'CNY',
    firstWeightG: numberInput(f?.firstWeightG ?? 500),
    firstPrice: moneyInput(f?.firstPriceMinor),
    stepWeightG: numberInput(f?.stepWeightG ?? 500),
    stepPrice: moneyInput(f?.stepPriceMinor),
    divisor: numberInput(f?.volumetricDivisor ?? 6000),
    perCbm: '',
    minCbm: '',
  }
}

/** 草稿 → 公式；不合法时返回错误文字 */
export function formulaOf(d: FormulaDraft): ShippingFormula | string {
  const currency = d.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return '币种为 3 位代码，如 CNY'
  if (d.mode === 'volume') {
    const perCbm = parseMoney(d.perCbm)
    const minCbm = parseNumber(d.minCbm)
    if (perCbm == null || Number.isNaN(perCbm)) return '请填写每立方米价格'
    if (minCbm != null && (Number.isNaN(minCbm) || minCbm < 0)) return '最低方数须为非负数'
    return {
      kind: 'volume',
      currency,
      pricePerCbmMinor: perCbm,
      ...(minCbm ? { minCbm } : {}),
    }
  }
  const firstWeightG = parseNumber(d.firstWeightG)
  const stepWeightG = parseNumber(d.stepWeightG)
  const firstPrice = parseMoney(d.firstPrice)
  const stepPrice = parseMoney(d.stepPrice)
  const positiveInt = (n: number | null): n is number => n != null && Number.isInteger(n) && n > 0
  if (!positiveInt(firstWeightG) || !positiveInt(stepWeightG)) return '首重与续重单位为正整数克'
  if (
    firstPrice == null ||
    Number.isNaN(firstPrice) ||
    stepPrice == null ||
    Number.isNaN(stepPrice)
  )
    return '请填写首重与续重价格'
  const formula: ShippingFormula = {
    kind: 'first-additional',
    currency,
    firstWeightG,
    firstPriceMinor: firstPrice,
    stepWeightG,
    stepPriceMinor: stepPrice,
  }
  if (d.mode === 'volumetric') {
    const divisor = parseNumber(d.divisor)
    if (!positiveInt(divisor) || divisor < 1000 || divisor > 10_000)
      return '体积重系数为 1000–10000 的整数，如 6000'
    formula.volumetricDivisor = divisor
  }
  return formula
}

function FormulaFields({
  title,
  draft,
  onChange,
}: {
  title: string
  draft: FormulaDraft
  onChange: (next: FormulaDraft) => void
}) {
  const set = (patch: Partial<FormulaDraft>) => onChange({ ...draft, ...patch })
  const input = (label: string, key: keyof FormulaDraft, hint?: string) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      {(id) => (
        <Input
          id={id}
          className={small}
          value={draft[key]}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
    </Field>
  )
  return (
    <fieldset className="grid gap-2 rounded-md border bg-background p-3">
      <legend className="px-1 text-xs font-medium">{title}</legend>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="计费方式">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={draft.mode}
              onChange={(e) => set({ mode: e.target.value as FormulaMode })}
            >
              {(Object.keys(FORMULA_LABELS) as FormulaMode[]).map((m) => (
                <option key={m} value={m}>
                  {FORMULA_LABELS[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {input('币种', 'currency')}
        {draft.mode === 'volume' ? (
          <>
            {input('每立方米价格', 'perCbm')}
            {input('最低计费方数', 'minCbm', '可空')}
          </>
        ) : (
          <>
            {input('首重（克）', 'firstWeightG')}
            {input('首重价格', 'firstPrice')}
            {input('续重单位（克）', 'stepWeightG')}
            {input('续重价格', 'stepPrice')}
            {draft.mode === 'volumetric'
              ? input('体积重系数', 'divisor', '计费重量取实重与 长×宽×高÷系数 的较大者')
              : null}
          </>
        )}
      </div>
    </fieldset>
  )
}

// ---- 物流方案 ----

export function LogisticsTab({ slug, data, onChanged }: TabProps) {
  const [editing, setEditing] = useState<LogisticsProfileView | 'new' | null>(null)
  const { busy, error, run } = useAction(onChanged)
  return (
    <Section
      title="物流方案"
      actions={
        data.canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增方案
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        eBay 直发 / 海外仓、Amazon FBA 头程 / FBM
        直发。时效为直发到买家或头程到仓的天数；与商品属性冲突的禁运方案在核算矩阵中不可用。
      </p>
      {editing !== null ? (
        <ProfileForm
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
      {data.profiles.length === 0 ? (
        <EmptyState title="还没有物流方案">新增方案后才能在核算矩阵中比较物流成本。</EmptyState>
      ) : (
        <SimpleTable head={['方案', '类型', '时效', '头程', '直发 / 尾程', '禁运属性', '']}>
          {data.profiles.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 font-medium">{p.name}</td>
              <td className="px-3 py-2">
                <Tag tone="neutral">{LOGISTICS_TYPE_LABELS[p.type]}</Tag>
              </td>
              <td className="px-3 py-2">{p.transitDays} 天</td>
              <td className="px-3 py-2 text-xs">{describeFormula(p.headFreight)}</td>
              <td className="px-3 py-2 text-xs">{describeFormula(p.lastMile)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {p.bannedAttributes.join('、') || '—'}
              </td>
              <td className="px-3 py-2">
                <RowActions
                  canWrite={data.canWrite}
                  busy={busy}
                  onEdit={() => setEditing(p)}
                  onDelete={() => {
                    if (window.confirm(`删除物流方案“${p.name}”？`))
                      void run(() => removeLogisticsProfile({ data: { slug, id: p.id } }))
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

function ProfileForm({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  initial: LogisticsProfileView | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<LogisticsType>(initial?.type ?? 'ebay-direct')
  const [transitDays, setTransitDays] = useState(String(initial?.transitDays ?? 10))
  const [head, setHead] = useState(() => draftOf(initial?.headFreight ?? null))
  const [lastMile, setLastMile] = useState(() => draftOf(initial?.lastMile ?? null))
  const [banned, setBanned] = useState(initial?.bannedAttributes.join(', ') ?? '')
  const { busy, error, setError, run } = useAction(onSaved)
  const rule = LOGISTICS_TYPE_RULES[type]

  async function submit(e: FormEvent) {
    e.preventDefault()
    const days = Number(transitDays)
    if (!name.trim()) return setError('请填写方案名称')
    if (!Number.isInteger(days) || days < 0 || days > 365) return setError('时效为 0–365 天的整数')
    const headFreight = rule.headFreight ? formulaOf(head) : null
    if (typeof headFreight === 'string') return setError(`头程：${headFreight}`)
    const last = rule.lastMile ? formulaOf(lastMile) : null
    if (typeof last === 'string') return setError(`直发 / 尾程：${last}`)
    await run(() =>
      saveLogisticsProfile({
        data: {
          slug,
          ...(initial ? { id: initial.id } : {}),
          profile: {
            name,
            platform: rule.platform,
            type,
            transitDays: days,
            headFreight,
            lastMile: last,
            bannedAttributes: splitList(banned),
          },
        },
      }),
    )
  }

  return (
    <form
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={submit}
      aria-label="物流方案"
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="方案名称">
          {(id) => (
            <Input
              id={id}
              className={small}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="平台 · 类型">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={type}
              onChange={(e) => setType(e.target.value as LogisticsType)}
            >
              {LOGISTICS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LOGISTICS_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="时效（天）">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={365}
              className={small}
              value={transitDays}
              onChange={(e) => setTransitDays(e.target.value)}
            />
          )}
        </Field>
        <Field label="禁运属性" hint="逗号分隔，如 battery, liquid">
          {(id) => (
            <Input
              id={id}
              className={small}
              value={banned}
              onChange={(e) => setBanned(e.target.value)}
            />
          )}
        </Field>
      </div>
      {rule.headFreight ? (
        <FormulaFields title="头程计费（整批）" draft={head} onChange={setHead} />
      ) : null}
      {rule.lastMile ? (
        <FormulaFields
          title={type === 'ebay-overseas' ? '海外仓尾程（单件）' : '直发运费（单件）'}
          draft={lastMile}
          onChange={setLastMile}
        />
      ) : null}
      {type === 'amazon-fba' ? (
        <p className="text-xs text-muted-foreground">
          FBA 配送费优先使用 SP-API 预估，取不到时使用费率表；仓储与入库配置费在“成本参数”中设置。
        </p>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <FormActions busy={busy} onCancel={onClose} />
    </form>
  )
}

// ---- 成本参数 ----

const PARAM_FIELDS: readonly {
  key: keyof CostParams
  label: string
  kind: 'rate' | 'money' | 'number'
}[] = [
  { key: 'commissionRate', label: '佣金率', kind: 'rate' },
  { key: 'fixedFeeMinor', label: '固定费', kind: 'money' },
  { key: 'adRate', label: '广告率', kind: 'rate' },
  { key: 'returnRate', label: '退货预留', kind: 'rate' },
  { key: 'storageMonthlyMinor', label: '月仓储费', kind: 'money' },
  { key: 'storageMonths', label: '库存月数', kind: 'number' },
  { key: 'inboundFeeMinor', label: '入库配置费', kind: 'money' },
]

function formatParam(kind: 'rate' | 'money' | 'number', value: number | null | undefined) {
  if (kind === 'rate') return formatRate(value)
  if (kind === 'money') return formatMoney(value)
  return value == null ? '—' : String(value)
}

export function CostParamsTab({ slug, data, onChanged }: TabProps) {
  const [editing, setEditing] = useState<CostParamView | 'new' | null>(null)
  const { busy, error, run } = useAction(onChanged)
  return (
    <Section
      title="成本参数"
      actions={
        data.canWrite && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增参数
          </Button>
        ) : null
      }
    >
      <p className="text-xs text-muted-foreground">
        按平台 ×
        类目配置；类目留空即平台默认。类目没有单独填写的项使用该平台默认值，核算明细标注“平台默认”。
        固定费与仓储、入库费用按售价币种填写。
      </p>
      {editing !== null ? (
        <ParamForm
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
      {data.params.length === 0 ? (
        <EmptyState title="还没有成本参数">
          先为 Amazon 与 eBay 各配置一份平台默认参数，再按需覆盖个别类目。
        </EmptyState>
      ) : (
        <SimpleTable head={['平台', '类目', ...PARAM_FIELDS.map((f) => f.label), '']}>
          {data.params.map((p) => (
            <tr key={p.id} data-testid="cost-param-row">
              <td className="px-3 py-2">{PLATFORM_LABELS[p.platform]}</td>
              <td className="px-3 py-2">
                {p.categoryId ? (
                  <span className="font-mono text-xs">{p.categoryId}</span>
                ) : (
                  <Tag tone="info">平台默认</Tag>
                )}
              </td>
              {PARAM_FIELDS.map((f) => (
                <td key={f.key} className="px-3 py-2 whitespace-nowrap">
                  {formatParam(f.kind, p.effective[f.key])}
                  {p.categoryId && p.sources[f.key] === 'platform-default' ? (
                    <div className="text-[11px] text-muted-foreground">平台默认</div>
                  ) : null}
                </td>
              ))}
              <td className="px-3 py-2">
                <RowActions
                  canWrite={data.canWrite}
                  busy={busy}
                  onEdit={() => setEditing(p)}
                  onDelete={() => {
                    if (window.confirm('删除这组成本参数？'))
                      void run(() => removeCostParam({ data: { slug, id: p.id } }))
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

function ParamForm({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string
  initial: CostParamView | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [platform, setPlatform] = useState<Platform>(initial?.platform ?? 'amazon')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '')
  const [values, setValues] = useState<Record<keyof CostParams, string>>(() => {
    const v = initial?.values ?? {}
    return {
      commissionRate: percentInput(v.commissionRate),
      fixedFeeMinor: moneyInput(v.fixedFeeMinor),
      adRate: percentInput(v.adRate),
      returnRate: percentInput(v.returnRate),
      storageMonthlyMinor: moneyInput(v.storageMonthlyMinor),
      storageMonths: numberInput(v.storageMonths),
      inboundFeeMinor: moneyInput(v.inboundFeeMinor),
    }
  })
  const { busy, error, setError, run } = useAction(onSaved)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const param: Record<string, number | null> = {}
    for (const f of PARAM_FIELDS) {
      const text = values[f.key]
      const n =
        f.kind === 'rate'
          ? parsePercent(text)
          : f.kind === 'money'
            ? parseMoney(text)
            : parseNumber(text)
      if (n != null && (Number.isNaN(n) || n < 0)) return setError(`${f.label}格式不正确`)
      param[f.key] = n
    }
    if (Object.values(param).every((v) => v == null)) return setError('至少填写一项成本参数')
    await run(() =>
      saveCostParam({
        data: {
          slug,
          ...(initial ? { id: initial.id } : {}),
          param: { platform, categoryId: categoryId.trim() || null, ...param },
        },
      }),
    )
  }

  return (
    <form
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={submit}
      aria-label="成本参数"
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="平台">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
            >
              {COSTING_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="类目 ID" hint="留空 = 平台默认">
          {(id) => (
            <Input
              id={id}
              className={small}
              value={categoryId}
              maxLength={128}
              onChange={(e) => setCategoryId(e.target.value)}
            />
          )}
        </Field>
        {PARAM_FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.kind === 'rate' ? `${f.label}（%）` : f.label}
            {...(categoryId.trim() ? { hint: '留空使用平台默认' } : {})}
          >
            {(id) => (
              <Input
                id={id}
                className={small}
                inputMode="decimal"
                value={values[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      <FormActions busy={busy} onCancel={onClose} />
    </form>
  )
}

/** 设置页两个标签共用一份数据，任一修改后整体刷新 */
export function useCostingSettings(slug: string, initial: CostingSettingsData) {
  const [data, setData] = useState(initial)
  const reload = async () => setData(await getCostingSettings({ data: { slug } }))
  return { data, reload }
}
