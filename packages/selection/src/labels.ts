import { addDays, diffDays } from './dates.ts'

/**
 * 影子推荐到期打标签（design D2，docs/plan/selection-workbench.md 第 10 节）。
 * 纯函数：调用方负责读取窗口内的簇销量与竞品中位价序列，这里只做判定。
 */

export const LABEL_WINDOWS = [14, 30, 60] as const
export type LabelWindow = (typeof LABEL_WINDOWS)[number]

export type LabelOutcome = 'hit' | 'miss' | 'insufficient'

export const LABEL_OUTCOME_LABELS: Readonly<Record<LabelOutcome, string>> = {
  hit: '命中',
  miss: '未命中',
  insufficient: '数据不足',
}

export interface HitCriteria {
  /** X：窗口内簇销量增量下限（件） */
  readonly minUnits: number
  /** Y：竞品中位价跌幅上限（0–1） */
  readonly maxPriceDrop: number
  /** 季节类高峰周预测误差上限（周） */
  readonly maxPeakErrorWeeks: number
  /** 关键观测覆盖率下限；缺失超过一半即数据不足，所以默认 0.5 */
  readonly minCoverage: number
}

export const DEFAULT_HIT_CRITERIA: HitCriteria = {
  minUnits: 30,
  maxPriceDrop: 0.15,
  maxPeakErrorWeeks: 2,
  minCoverage: 0.5,
}

/** 一天的观测；value 为 null 表示当天缺失。ObservationPoint 可直接传入 */
export interface LabelObservation {
  /** YYYY-MM-DD */
  readonly observedOn: string
  readonly value: number | null
  readonly sourceId?: string | undefined
}

export interface SeasonPeak {
  /** 推荐时预测的高峰周（该周任一日，通常取周一）；无预测时为 null */
  readonly predictedPeakWeek: string | null
  /** 实际高峰周；尚无数据时为 null */
  readonly actualPeakWeek: string | null
}

export interface LabelInput {
  /** 推荐冻结日 YYYY-MM-DD */
  readonly frozenOn: string
  readonly window: LabelWindow
  /** 簇每日销量（件/天，Amazon 用估算主值）；只统计 (冻结日, 冻结日 + 窗口] 内的观测 */
  readonly dailySales: readonly LabelObservation[]
  /** 竞品中位价；冻结日当天或之前最近的一条作为基准价，窗口内最后一条作为期末价 */
  readonly medianPrices: readonly LabelObservation[]
  /** 季节类（主导维度为增长与季节）时提供；省略表示非季节类 */
  readonly season?: SeasonPeak | undefined
}

export interface LabelResult {
  readonly outcome: LabelOutcome
  readonly window: LabelWindow
  /** 窗口内销量增量（件）；有缺失天时按已观测日均外推到整个窗口 */
  readonly salesIncrement: number | null
  /** 竞品中位价跌幅（0–1，上涨为负） */
  readonly priceDrop: number | null
  readonly peakErrorWeeks: number | null
  /** 已观测天数 ÷ 窗口天数 */
  readonly coverage: { readonly sales: number; readonly price: number }
  /** 打标签所用的数据来源 */
  readonly sources: readonly string[]
  readonly reason: string
}

/** 标签到期日 = 冻结日 + 窗口天数 */
export function labelDueOn(frozenOn: string, window: LabelWindow): string {
  return addDays(frozenOn, window)
}

/** 到期且尚未打标签的窗口（按窗口从小到大） */
export function dueWindows(
  frozenOn: string,
  today: string,
  labeled: readonly LabelWindow[] = [],
  windows: readonly LabelWindow[] = LABEL_WINDOWS,
): LabelWindow[] {
  const done = new Set(labeled)
  return [...windows]
    .sort((a, b) => a - b)
    .filter((w) => !done.has(w) && labelDueOn(frozenOn, w) <= today)
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** 同一天多条观测时取第一条非空值，避免多来源重复累计 */
function byDay(points: readonly LabelObservation[], from: string, to: string) {
  const days = new Map<string, LabelObservation>()
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) continue
    if (p.observedOn <= from || p.observedOn > to || days.has(p.observedOn)) continue
    days.set(p.observedOn, p)
  }
  return days
}

export function labelRecommendation(
  input: LabelInput,
  criteria: HitCriteria = DEFAULT_HIT_CRITERIA,
): LabelResult {
  const { frozenOn, window } = input
  const end = labelDueOn(frozenOn, window)
  const sales = byDay(input.dailySales, frozenOn, end)
  const prices = byDay(input.medianPrices, frozenOn, end)
  const coverage = { sales: round(sales.size / window, 3), price: round(prices.size / window, 3) }

  // 基准价：冻结日当天或之前最近的观测
  let base: LabelObservation | undefined
  for (const p of input.medianPrices) {
    if (p.value === null || !Number.isFinite(p.value) || p.value <= 0) continue
    if (p.observedOn > frozenOn) continue
    if (base === undefined || p.observedOn > base.observedOn) base = p
  }
  const last = [...prices.values()].sort((a, b) => a.observedOn.localeCompare(b.observedOn)).at(-1)

  const used = [...sales.values(), ...prices.values(), ...(base ? [base] : [])]
  const sources = [...new Set(used.map((p) => p.sourceId).filter((s): s is string => !!s))].sort()

  const observedSales = [...sales.values()].reduce((sum, p) => sum + (p.value as number), 0)
  const salesIncrement = sales.size === 0 ? null : round((observedSales / sales.size) * window, 1)
  const priceDrop =
    base === undefined || last === undefined
      ? null
      : round(((base.value as number) - (last.value as number)) / (base.value as number), 4)

  let peakErrorWeeks: number | null = null
  if (input.season?.predictedPeakWeek && input.season.actualPeakWeek) {
    peakErrorWeeks = round(
      Math.abs(diffDays(input.season.predictedPeakWeek, input.season.actualPeakWeek)) / 7,
      1,
    )
  }

  const result = { window, salesIncrement, priceDrop, peakErrorWeeks, coverage, sources }
  const insufficient = (reason: string): LabelResult => ({
    ...result,
    outcome: 'insufficient',
    reason,
  })

  // 关键观测缺失超过一半 → 数据不足，不计入命中率分母
  if (coverage.sales < criteria.minCoverage) {
    return insufficient(`窗口 ${window} 天中只有 ${sales.size} 天有销量观测`)
  }
  if (coverage.price < criteria.minCoverage || priceDrop === null) {
    return insufficient(
      base === undefined
        ? '缺少冻结日的竞品中位价'
        : `窗口 ${window} 天中只有 ${prices.size} 天有竞品价格观测`,
    )
  }
  if (input.season !== undefined && peakErrorWeeks === null) {
    return insufficient('季节类缺少预测或实际高峰周')
  }

  const failures: string[] = []
  if ((salesIncrement as number) < criteria.minUnits) {
    failures.push(`销量增量 ${salesIncrement} 件 < ${criteria.minUnits}`)
  }
  if (priceDrop > criteria.maxPriceDrop) {
    failures.push(`竞品中位价跌 ${round(priceDrop * 100, 1)}% > ${criteria.maxPriceDrop * 100}%`)
  }
  if (peakErrorWeeks !== null && peakErrorWeeks > criteria.maxPeakErrorWeeks) {
    failures.push(`高峰周误差 ${peakErrorWeeks} 周 > ${criteria.maxPeakErrorWeeks}`)
  }
  if (failures.length > 0) return { ...result, outcome: 'miss', reason: failures.join('；') }
  return {
    ...result,
    outcome: 'hit',
    reason: `销量增量 ${salesIncrement} 件，竞品中位价跌 ${round(priceDrop * 100, 1)}%${
      peakErrorWeeks === null ? '' : `，高峰周误差 ${peakErrorWeeks} 周`
    }`,
  }
}
