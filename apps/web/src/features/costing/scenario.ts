/**
 * 读取 costing_scenario.result 快照里队列与档案库需要的数字。
 * result 是 packages/costing 的 CostingOutcome（status ok / missing），矩阵写入时可能整格保存
 * （{ result, deadline, certainty }）；两种形状都兼容，缺失时为空，不按 0 显示。
 */
export interface ScenarioSummary {
  currency: string | null
  salePriceMinor: number | null
  landedCostMinor: number | null
  netProfitMinor: number | null
  grossMargin: number | null
  breakEvenMinor: number | null
  deadline: string | null
  missing: string[]
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const obj = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

export function summarizeScenario(result: unknown): ScenarioSummary {
  const outer = obj(result) ?? {}
  const inner = outer.status === 'ok' ? outer : (obj(outer.result) ?? outer)
  const missingList = Array.isArray(outer.missing)
    ? outer.missing
    : Array.isArray(inner.missing)
      ? inner.missing
      : []
  return {
    currency: str(inner.currency),
    salePriceMinor: num(inner.salePriceMinor),
    landedCostMinor: num(inner.landedCostMinor),
    netProfitMinor: num(inner.netProfitMinor),
    grossMargin: num(inner.grossMargin),
    breakEvenMinor: num(inner.breakEvenMinor),
    deadline: str(outer.deadline) ?? str(outer.latestDecisionOn) ?? str(inner.deadline),
    missing: missingList.filter((m): m is string => typeof m === 'string'),
  }
}
