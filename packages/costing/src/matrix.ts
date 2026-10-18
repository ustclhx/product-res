import { certaintyOf } from './certainty.ts'
import { computeCosting } from './costing.ts'
import { isTooLate, latestDecisionDate } from './deadline.ts'
import { assertPositiveInt } from './money.ts'
import { isBelowMoq } from './quote.ts'
import type {
  CostingResult,
  CostParams,
  FollowMode,
  FulfillmentFee,
  FxRate,
  Improvement,
  LogisticsProfile,
  MissingInput,
  Money,
  Platform,
  SupplierQuote,
} from './types.ts'

export type UnavailableReason = 'below-moq' | 'shipping-ban' | 'too-late' | 'missing-input'

export type MatrixSchedule = {
  /** 节点销售开始日 YYYY-MM-DD */
  saleStartDate: string
  /** 今天 YYYY-MM-DD（由调用方传入，保持纯函数） */
  today: string
  listingPrepDays?: number | null
  /** FBA 入库上架时长 */
  inboundDays?: number | null
  /** 报价未给采购时长时使用的默认值 */
  defaultProcurementDays?: number | null
}

export type MatrixInput = {
  plannedQty: number
  salePrice: Money | null
  quotes: SupplierQuote[]
  profiles: LogisticsProfile[]
  modes: FollowMode[]
  improvement?: Improvement | null
  /** 已完成类目回退的平台成本参数 */
  costParams: Partial<Record<Platform, CostParams>>
  fulfillmentFee?: FulfillmentFee | null
  fxRates: FxRate[]
  /** 商品属性，与方案禁运属性冲突时不可用 */
  productAttributes?: string[]
  /** 无季节节点时不算最晚决定日，也不判“来不及” */
  schedule?: MatrixSchedule | null
}

export type MatrixCell = {
  quoteId: string
  profileId: string
  mode: FollowMode
  available: boolean
  reasons: UnavailableReason[]
  missing: MissingInput[]
  /** 与方案禁运冲突的商品属性 */
  bannedAttributes: string[]
  /** 成本输入齐全时给出；不可用（如低于 MOQ、来不及）仍展示数字供对比 */
  result: CostingResult | null
  deadline: string | null
  certainty: number | null
}

export type CostingMatrix = {
  cells: MatrixCell[]
  /** 毛利率最高且可用（来得及、不低于 MOQ、无禁运、输入齐全）的组合 */
  best: MatrixCell | null
}

function evaluateCell(
  input: MatrixInput,
  quote: SupplierQuote,
  profile: LogisticsProfile,
  mode: FollowMode,
): MatrixCell {
  const reasons: UnavailableReason[] = []
  const missing = new Set<MissingInput>()

  if (isBelowMoq(quote, input.plannedQty)) reasons.push('below-moq')

  const banned = new Set((profile.bannedAttributes ?? []).map((a) => a.toLowerCase()))
  const bannedAttributes = (input.productAttributes ?? []).filter((a) =>
    banned.has(a.toLowerCase()),
  )
  if (bannedAttributes.length > 0) reasons.push('shipping-ban')

  const outcome = computeCosting({
    plannedQty: input.plannedQty,
    salePrice: input.salePrice,
    quote,
    profile,
    mode,
    improvement: input.improvement ?? null,
    costParams: input.costParams[profile.platform] ?? {},
    fulfillmentFee: input.fulfillmentFee ?? null,
    fxRates: input.fxRates,
  })
  if (outcome.status === 'missing') for (const m of outcome.missing) missing.add(m)
  const result = outcome.status === 'ok' ? outcome : null

  let deadline: string | null = null
  const schedule = input.schedule
  if (schedule) {
    const d = latestDecisionDate({
      saleStartDate: schedule.saleStartDate,
      logisticsType: profile.type,
      transitDays: profile.transitDays,
      inboundDays: schedule.inboundDays ?? null,
      procurementDays: quote.procurementDays ?? schedule.defaultProcurementDays ?? null,
      mode,
      sampleDays: input.improvement?.sampleDays ?? null,
      listingPrepDays: schedule.listingPrepDays ?? null,
    })
    if (d.status === 'missing') for (const m of d.missing) missing.add(m)
    else {
      deadline = d.date
      if (isTooLate(d.date, schedule.today)) reasons.push('too-late')
    }
  }
  if (missing.size > 0) reasons.push('missing-input')

  return {
    quoteId: quote.id,
    profileId: profile.id,
    mode,
    available: reasons.length === 0,
    reasons,
    missing: [...missing],
    bannedAttributes,
    result,
    deadline,
    certainty: result ? certaintyOf(result, quote.confidence) : null,
  }
}

/** 选最优：可用组合中毛利率最高者，同毛利率取落地成本低者 */
export function pickBest(cells: MatrixCell[]): MatrixCell | null {
  let best: MatrixCell | null = null
  for (const cell of cells) {
    if (!cell.available || !cell.result) continue
    if (
      !best?.result ||
      cell.result.grossMargin > best.result.grossMargin ||
      (cell.result.grossMargin === best.result.grossMargin &&
        cell.result.landedCostMinor < best.result.landedCostMinor)
    ) {
      best = cell
    }
  }
  return best
}

/** 对比矩阵：供应商报价 × 物流方案 × 跟卖方式 */
export function buildCostingMatrix(input: MatrixInput): CostingMatrix {
  assertPositiveInt('plannedQty', input.plannedQty)
  const cells: MatrixCell[] = []
  for (const quote of input.quotes) {
    for (const profile of input.profiles) {
      for (const mode of input.modes) cells.push(evaluateCell(input, quote, profile, mode))
    }
  }
  return { cells, best: pickBest(cells) }
}
