import { Button, Input } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { Field } from '../workbench/fields.tsx'
import { getScoringSettings, saveScoringSettings } from './scoring.functions.ts'
import { errorText, formatTime, Section, SimpleTable } from './shared.tsx'

type ScoringData = Awaited<ReturnType<typeof getScoringSettings>>
type Setting = ScoringData['current']
type Dimension = keyof Setting['weights']

const GATES = [
  ['compliance', '合规与侵权低于否决阈值'],
  ['timing', '所有物流方案都来不及'],
  ['margin', '毛利率低于底线（无利润数据时不判）'],
] as const

const rate = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

/** 回测命中率：T+30 加权命中率与 Wilson 下界；没有已打标签样本时显示“无样本”，不按 0 计 */
function BacktestRate({ backtest }: { backtest: ScoringData['dimensions'][number]['backtest'] }) {
  if (!backtest) return <span className="text-xs text-muted-foreground">无样本</span>
  return (
    <div className="grid gap-0.5">
      <span>
        <span className="font-mono font-medium">{rate(backtest.hitRate)}</span>
        <span className="text-xs text-muted-foreground">
          {' '}
          · 下界 <span className="font-mono">{rate(backtest.wilsonLower)}</span>
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        有效样本 {backtest.effectiveSamples}
        {backtest.replaySamples > 0 ? `（含回放 ${backtest.replaySamples} 条）` : ''}
      </span>
    </div>
  )
}

/** 毛利底线以百分比编辑，库中存基点 */
const percentText = (bp: number) => String(bp / 100)

/** 评分维度管理（docs/design/data-center.html）：保存即生成新版本，只影响之后生成的线索 */
export function ScoringSettings({ slug }: { slug: string }) {
  const [data, setData] = useState<ScoringData | null>(null)
  const [draft, setDraft] = useState<Setting | null>(null)
  const [margin, setMargin] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const next = await getScoringSettings({ data: { slug } })
      setData(next)
      setDraft(next.current)
      setMargin(percentText(next.current.marginFloorBp))
    } catch (e) {
      setError(errorText(e))
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首次加载
  useEffect(() => {
    void load()
  }, [])

  if (!data || !draft) {
    return (
      <Section title="评分维度管理">
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">加载中…</p>
        )}
      </Section>
    )
  }

  const readOnly = !data.canWrite
  const setWeight = (id: Dimension, value: string) =>
    setDraft({ ...draft, weights: { ...draft.weights, [id]: Number(value) } })
  const toggleReverse = (id: Dimension, on: boolean) =>
    setDraft({
      ...draft,
      reverseDimensions: on
        ? [...draft.reverseDimensions, id]
        : draft.reverseDimensions.filter((d) => d !== id),
    })

  async function save() {
    if (!draft) return
    setError('')
    setNotice('')
    const marginFloorBp = Math.round(Number(margin) * 100)
    if (!Number.isFinite(marginFloorBp)) {
      setError('毛利底线需要是数字')
      return
    }
    setSaving(true)
    try {
      const saved = await saveScoringSettings({
        data: {
          slug,
          setting: {
            weights: draft.weights,
            reverseDimensions: draft.reverseDimensions,
            vetoThreshold: draft.vetoThreshold,
            minDimensions: draft.minDimensions,
            hardGates: draft.hardGates,
            marginFloorBp,
          },
        },
      })
      setNotice(`已保存为版本 ${saved.version}，从下一次计算起生效；已有线索保留原版本`)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-4">
      <Section
        title={`评分维度管理 · 当前版本 ${data.current.version}`}
        actions={
          <span className="text-xs text-muted-foreground">
            生效于 {formatTime(data.current.effectiveAt)}
          </span>
        }
      >
        <p className="text-xs text-muted-foreground">
          综合分 = 已计算维度的加权平均（反向维度取 100 −
          分数）。每次保存生成新版本，只影响之后的计算；每条线索记录所用版本。
        </p>
        <SimpleTable head={['维度', '权重', '反向维度', '回测命中率']}>
          {data.dimensions.map((d) => {
            const id = d.id as Dimension
            return (
              <tr key={d.id}>
                <td className="px-3 py-2">{d.label}</td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    aria-label={`${d.label}权重`}
                    className="h-8 w-24 text-[13px]"
                    min={0}
                    max={100}
                    step={0.1}
                    disabled={readOnly}
                    value={String(draft.weights[id])}
                    onChange={(e) => setWeight(id, e.target.value)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`${d.label}为反向维度`}
                    className="size-3.5 accent-primary"
                    disabled={readOnly}
                    checked={draft.reverseDimensions.includes(id)}
                    onChange={(e) => toggleReverse(id, e.target.checked)}
                  />
                </td>
                <td className="px-3 py-2" data-testid={`backtest-${d.id}`}>
                  <BacktestRate backtest={d.backtest} />
                </td>
              </tr>
            )
          })}
        </SimpleTable>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="否决阈值" hint="合规分低于此值一票否决">
            {(id) => (
              <Input
                id={id}
                type="number"
                className="h-8 text-[13px]"
                min={0}
                max={100}
                step={1}
                disabled={readOnly}
                value={String(draft.vetoThreshold)}
                onChange={(e) => setDraft({ ...draft, vetoThreshold: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="毛利底线（%）" hint="毛利率低于此值不推荐">
            {(id) => (
              <Input
                id={id}
                type="number"
                className="h-8 text-[13px]"
                min={0}
                max={100}
                step={0.1}
                disabled={readOnly}
                value={margin}
                onChange={(e) => setMargin(e.target.value)}
              />
            )}
          </Field>
          <Field label="最少维度数" hint="可计算维度少于此数不给综合分">
            {(id) => (
              <Input
                id={id}
                type="number"
                className="h-8 text-[13px]"
                min={1}
                max={data.dimensions.length}
                step={1}
                disabled={readOnly}
                value={String(draft.minDimensions)}
                onChange={(e) => setDraft({ ...draft, minDimensions: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">硬门槛</legend>
          <div className="flex flex-wrap gap-4 text-[13px]">
            {GATES.map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  disabled={readOnly}
                  checked={draft.hardGates[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      hardGates: { ...draft.hardGates, [key]: e.target.checked },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-success-strong">
            {notice}
          </p>
        ) : null}
        {readOnly ? (
          <p className="text-xs text-muted-foreground">只有空间所有者和管理员可以修改。</p>
        ) : (
          <div>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              保存为版本 {data.current.version + 1}
            </Button>
          </div>
        )}
      </Section>
      <Section title="版本历史">
        <SimpleTable head={['版本', '生效时间']}>
          {data.history.map((h) => (
            <tr key={h.version}>
              <td className="px-3 py-2">v{h.version}</td>
              <td className="px-3 py-2">{formatTime(h.effectiveAt)}</td>
            </tr>
          ))}
        </SimpleTable>
      </Section>
    </div>
  )
}
