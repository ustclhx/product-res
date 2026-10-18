import { Button, cn, Input, Tag } from '@product-res/ui'
import { type FormEvent, useState } from 'react'
import { SimpleTable } from '../data-center/shared.tsx'
import { controlClass, EmptyState, ErrorText, Field, useAction } from '../workbench/fields.tsx'
import { removeQuote, removeSupplier, saveQuote, saveSupplier } from './costing.functions.ts'
import { formatMoney, moneyInput, numberInput, parseMoney, parseNumber } from './format.ts'
import { QUOTE_CONFIDENCES, SUPPLIER_PLATFORMS } from './inputs.ts'
import { QUOTE_CONFIDENCE_LABELS, SUPPLIER_PLATFORM_LABELS } from './labels.ts'
import type { QuoteView } from './quotes.server.ts'

/**
 * 核算标签的“供应商报价”区块（specs/supplier-quotes，tasks 2.3）：报价列表与录入
 * （阶梯、币种、MOQ、重量、尺寸、可信度、报价日期），供应商可在录入时新建或编辑。
 */

export interface SupplierRow {
  id: string
  name: string
  url: string | null
  platform: (typeof SUPPLIER_PLATFORMS)[number]
  note: string | null
}

const NEW_SUPPLIER = '__new__'
const today = () => new Date().toISOString().slice(0, 10)

function tiersText(q: Pick<QuoteView, 'tiers' | 'currency'>) {
  return q.tiers.map((t) => `${t.minQty}+ ${formatMoney(t.unitPriceMinor, q.currency)}`)
}

export function QuoteSection({
  slug,
  clusterId,
  suppliers,
  quotes,
  writable,
  lockedReason,
  onChanged,
}: {
  slug: string
  clusterId: string
  suppliers: SupplierRow[]
  quotes: QuoteView[]
  writable: boolean
  lockedReason: string | null
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState<QuoteView | 'new' | null>(null)
  const [supplierEditing, setSupplierEditing] = useState<SupplierRow | null>(null)
  const action = useAction(onChanged)
  const supplierById = new Map(suppliers.map((s) => [s.id, s]))

  return (
    <section
      className="grid gap-3 rounded-xl border bg-card p-4"
      aria-label="供应商报价"
      data-testid="quote-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-sm font-semibold">供应商报价</h2>
          <p className="text-xs text-muted-foreground">
            按计划数量取阶梯单价；低于 MOQ
            的报价在矩阵中标为不可用。批量录入可用数据中心的“供应商报价表”导入。
          </p>
        </div>
        {writable && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            新增报价
          </Button>
        ) : null}
      </div>
      {lockedReason ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {lockedReason}
        </p>
      ) : null}

      {quotes.length === 0 && editing === null ? (
        <EmptyState title="还没有报价">
          {writable
            ? '点“新增报价”录入 1688 / Alibaba 的阶梯价、MOQ、重量与尺寸。'
            : '等待所有者或管理员录入报价。'}
        </EmptyState>
      ) : quotes.length > 0 ? (
        <SimpleTable
          head={['供应商', '阶梯价', 'MOQ', '重量', '尺寸 (cm)', '可信度', '报价日期', '来源', '']}
          empty={false}
        >
          {quotes.map((q) => {
            const s = supplierById.get(q.supplierId)
            return (
              <tr key={q.id} data-testid="quote-row">
                <td className="px-3 py-2">
                  <div className="grid gap-0.5">
                    <span className="font-medium">
                      {s?.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-primary"
                        >
                          {s.name} ↗
                        </a>
                      ) : (
                        (s?.name ?? '—')
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {s ? SUPPLIER_PLATFORM_LABELS[s.platform] : ''}
                      {writable && s ? (
                        <button
                          type="button"
                          className="ml-2 text-primary hover:underline"
                          onClick={() => setSupplierEditing(s)}
                        >
                          编辑供应商
                        </button>
                      ) : null}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {tiersText(q).map((t) => (
                    <div key={t}>{t}</div>
                  ))}
                </td>
                <td className="px-3 py-2 font-mono">
                  {q.moq ?? <span className="text-muted-foreground">按最低档</span>}
                </td>
                <td className="px-3 py-2 font-mono">
                  {q.weightG ? `${q.weightG} g` : <Tag tone="warning">未录入</Tag>}
                </td>
                <td className="px-3 py-2 font-mono whitespace-nowrap">
                  {q.dimensions ? (
                    `${q.dimensions.lengthCm}×${q.dimensions.widthCm}×${q.dimensions.heightCm}`
                  ) : (
                    <Tag tone="warning">未录入</Tag>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Tag tone={q.confidence === 'confirmed' ? 'success' : 'neutral'}>
                    {QUOTE_CONFIDENCE_LABELS[q.confidence]}
                  </Tag>
                </td>
                <td className="px-3 py-2 font-mono">{q.quotedOn}</td>
                <td className="px-3 py-2">
                  {q.source === 'import' ? <Tag tone="info">导入</Tag> : <Tag>手工</Tag>}
                </td>
                <td className="px-3 py-2">
                  {writable ? (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(q)}
                        disabled={action.busy}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={action.busy}
                        onClick={() =>
                          action.run(() => removeQuote({ data: { slug, clusterId, id: q.id } }))
                        }
                      >
                        删除
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </SimpleTable>
      ) : null}
      <ErrorText>{action.error}</ErrorText>

      {supplierEditing ? (
        <SupplierForm
          slug={slug}
          initial={supplierEditing}
          onDone={async () => {
            setSupplierEditing(null)
            await onChanged()
          }}
          onCancel={() => setSupplierEditing(null)}
        />
      ) : null}
      {editing ? (
        <QuoteForm
          key={editing === 'new' ? 'new' : editing.id}
          slug={slug}
          clusterId={clusterId}
          suppliers={suppliers}
          initial={editing === 'new' ? null : editing}
          onDone={async () => {
            setEditing(null)
            await onChanged()
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}

function SupplierFields({
  value,
  onChange,
}: {
  value: { name: string; url: string; platform: SupplierRow['platform'] }
  onChange: (next: { name: string; url: string; platform: SupplierRow['platform'] }) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_140px]">
      <Field label="供应商名称">
        {(id) => (
          <Input
            id={id}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="如：义乌某某日用品厂"
          />
        )}
      </Field>
      <Field label="供应商链接">
        {(id) => (
          <Input
            id={id}
            value={value.url}
            onChange={(e) => {
              const url = e.target.value
              // 按链接推断平台，仍可手动改
              const platform = /1688\.com/i.test(url)
                ? '1688'
                : /alibaba\.com/i.test(url)
                  ? 'alibaba'
                  : value.platform
              onChange({ ...value, url, platform })
            }}
            placeholder="https://detail.1688.com/offer/…"
          />
        )}
      </Field>
      <Field label="供应商平台">
        {(id) => (
          <select
            id={id}
            className={controlClass}
            value={value.platform}
            onChange={(e) =>
              onChange({ ...value, platform: e.target.value as SupplierRow['platform'] })
            }
          >
            {SUPPLIER_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {SUPPLIER_PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  )
}

function SupplierForm({
  slug,
  initial,
  onDone,
  onCancel,
}: {
  slug: string
  initial: SupplierRow
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState({
    name: initial.name,
    url: initial.url ?? '',
    platform: initial.platform,
  })
  const action = useAction(onDone)
  return (
    <form
      aria-label="供应商"
      className="grid gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        action.run(() =>
          saveSupplier({
            data: { slug, id: initial.id, supplier: { ...value, url: value.url || null } },
          }),
        )
      }}
    >
      <SupplierFields value={value} onChange={setValue} />
      <ErrorText>{action.error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={action.busy}>
          保存供应商
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={action.busy}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive"
          disabled={action.busy}
          onClick={() => action.run(() => removeSupplier({ data: { slug, id: initial.id } }))}
        >
          删除供应商
        </Button>
      </div>
    </form>
  )
}

interface TierDraft {
  key: number
  qty: string
  price: string
}

function QuoteForm({
  slug,
  clusterId,
  suppliers,
  initial,
  onDone,
  onCancel,
}: {
  slug: string
  clusterId: string
  suppliers: SupplierRow[]
  initial: QuoteView | null
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [supplierId, setSupplierId] = useState(
    initial?.supplierId ?? suppliers[0]?.id ?? NEW_SUPPLIER,
  )
  const [newSupplier, setNewSupplier] = useState({
    name: '',
    url: '',
    platform: '1688' as SupplierRow['platform'],
  })
  const [tiers, setTiers] = useState<TierDraft[]>(
    initial?.tiers.map((t, i) => ({
      key: i,
      qty: String(t.minQty),
      price: moneyInput(t.unitPriceMinor),
    })) ?? [{ key: 0, qty: '100', price: '' }],
  )
  const [currency, setCurrency] = useState(initial?.currency ?? 'CNY')
  const [moq, setMoq] = useState(numberInput(initial?.moq))
  const [weight, setWeight] = useState(numberInput(initial?.weightG))
  const [dims, setDims] = useState({
    l: numberInput(initial?.dimensions?.lengthCm),
    w: numberInput(initial?.dimensions?.widthCm),
    h: numberInput(initial?.dimensions?.heightCm),
  })
  const [confidence, setConfidence] = useState<(typeof QUOTE_CONFIDENCES)[number]>(
    initial?.confidence ?? 'public',
  )
  const [quotedOn, setQuotedOn] = useState(initial?.quotedOn ?? today())
  const [procurementDays, setProcurementDays] = useState(numberInput(initial?.procurementDays))
  const [note, setNote] = useState(initial?.note ?? '')
  const action = useAction(onDone)

  function submit(e: FormEvent) {
    e.preventDefault()
    const parsedTiers = tiers
      .filter((t) => t.qty.trim() || t.price.trim())
      .map((t) => ({ minQty: parseNumber(t.qty), unitPriceMinor: parseMoney(t.price) }))
    if (
      parsedTiers.length === 0 ||
      parsedTiers.some(
        (t) =>
          t.minQty === null ||
          t.unitPriceMinor === null ||
          !Number.isInteger(t.minQty) ||
          (t.minQty as number) <= 0 ||
          Number.isNaN(t.unitPriceMinor),
      )
    ) {
      action.setError('阶梯的数量须为正整数、单价最多两位小数')
      return
    }
    const nums = {
      moq: parseNumber(moq),
      weightG: parseNumber(weight),
      procurementDays: parseNumber(procurementDays),
      l: parseNumber(dims.l),
      w: parseNumber(dims.w),
      h: parseNumber(dims.h),
    }
    if (Object.values(nums).some((v) => Number.isNaN(v))) {
      action.setError('数字格式不正确')
      return
    }
    const dimsFilled = [nums.l, nums.w, nums.h].filter((v) => v !== null).length
    if (dimsFilled !== 0 && dimsFilled !== 3) {
      action.setError('尺寸需同时填写长、宽、高，或全部留空')
      return
    }
    action.run(async () => {
      let sid = supplierId
      if (sid === NEW_SUPPLIER) {
        const created = await saveSupplier({
          data: { slug, supplier: { ...newSupplier, url: newSupplier.url || null } },
        })
        sid = created.id
      }
      await saveQuote({
        data: {
          slug,
          clusterId,
          ...(initial ? { id: initial.id } : {}),
          quote: {
            supplierId: sid,
            tiers: parsedTiers as { minQty: number; unitPriceMinor: number }[],
            currency,
            moq: nums.moq,
            weightG: nums.weightG,
            dimensions:
              dimsFilled === 3
                ? {
                    lengthCm: nums.l as number,
                    widthCm: nums.w as number,
                    heightCm: nums.h as number,
                  }
                : null,
            confidence,
            quotedOn,
            procurementDays: nums.procurementDays,
            note: note || null,
          },
        },
      })
    })
  }

  return (
    <form
      aria-label="报价"
      className="grid gap-4 rounded-lg border bg-muted/30 p-4"
      onSubmit={submit}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{initial ? '编辑报价' : '新增报价'}</h3>
        {initial?.source === 'import' ? (
          <span className="text-[11px] text-muted-foreground">
            保存后改记为手工录入，撤销导入时保留
          </span>
        ) : null}
      </div>
      <div className="grid gap-3">
        <Field label="供应商" className="max-w-sm">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{SUPPLIER_PLATFORM_LABELS[s.platform]}）
                </option>
              ))}
              <option value={NEW_SUPPLIER}>＋ 新建供应商…</option>
            </select>
          )}
        </Field>
        {supplierId === NEW_SUPPLIER ? (
          <SupplierFields value={newSupplier} onChange={setNewSupplier} />
        ) : null}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          数量阶梯（起订数量 → 单价）
        </legend>
        <div className="grid gap-2">
          {tiers.map((t, i) => (
            <div key={t.key} className="flex items-center gap-2" data-testid="tier-row">
              <Input
                aria-label={`第 ${i + 1} 档数量`}
                className="h-8 w-28"
                inputMode="numeric"
                value={t.qty}
                onChange={(e) =>
                  setTiers(tiers.map((x) => (x.key === t.key ? { ...x, qty: e.target.value } : x)))
                }
              />
              <span className="text-xs text-muted-foreground">件起</span>
              <Input
                aria-label={`第 ${i + 1} 档单价`}
                className="h-8 w-32"
                inputMode="decimal"
                placeholder="单价"
                value={t.price}
                onChange={(e) =>
                  setTiers(
                    tiers.map((x) => (x.key === t.key ? { ...x, price: e.target.value } : x)),
                  )
                }
              />
              <span className="text-xs text-muted-foreground">{currency}/件</span>
              {tiers.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setTiers(tiers.filter((x) => x.key !== t.key))}
                >
                  移除
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        {tiers.length < 10 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() =>
              setTiers([
                ...tiers,
                { key: Math.max(...tiers.map((x) => x.key)) + 1, qty: '', price: '' },
              ])
            }
          >
            ＋ 添加一档
          </Button>
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="币种">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {['CNY', 'USD', 'EUR', 'GBP', 'JPY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="MOQ" hint="留空则以最低一档数量为 MOQ">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={moq}
              onChange={(e) => setMoq(e.target.value)}
            />
          )}
        </Field>
        <Field label="单件重量（g）">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          )}
        </Field>
        <Field label="采购天数" hint="生产 + 发货；留空用默认 10 天">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={procurementDays}
              onChange={(e) => setProcurementDays(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <fieldset className="grid gap-1 lg:col-span-2">
          <legend className="text-xs font-medium text-muted-foreground">
            包装尺寸（cm，长 × 宽 × 高）
          </legend>
          <div className="flex items-center gap-1.5">
            {(['l', 'w', 'h'] as const).map((k, i) => (
              <span key={k} className="contents">
                {i > 0 ? <span className="text-muted-foreground">×</span> : null}
                <Input
                  aria-label={{ l: '长（cm）', w: '宽（cm）', h: '高（cm）' }[k]}
                  className="h-8 w-20"
                  inputMode="decimal"
                  value={dims[k]}
                  onChange={(e) => setDims({ ...dims, [k]: e.target.value })}
                />
              </span>
            ))}
          </div>
        </fieldset>
        <Field label="可信度">
          {(id) => (
            <select
              id={id}
              className={controlClass}
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as typeof confidence)}
            >
              {QUOTE_CONFIDENCES.map((c) => (
                <option key={c} value={c}>
                  {QUOTE_CONFIDENCE_LABELS[c]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="报价日期">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={quotedOn}
              onChange={(e) => setQuotedOn(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="备注">
        {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <ErrorText>{action.error}</ErrorText>
      <div className={cn('flex gap-2')}>
        <Button type="submit" size="sm" disabled={action.busy}>
          {action.busy ? '保存中…' : '保存报价'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={action.busy}>
          取消
        </Button>
      </div>
    </form>
  )
}
