import { z } from 'zod'
import { COSTING_PLATFORMS, DROP_REASONS, LOGISTICS_TYPES } from './labels.ts'

/** 物流方案、成本参数与决定的输入校验；server function 与 service 共用 */

const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, '币种为 3 位代码，如 USD / CNY')
  .transform((v) => v.toUpperCase())
const minor = z.number().int().min(0).max(1_000_000_000)
const positiveInt = z.number().int().positive().max(1_000_000)

/**
 * 与 packages/costing 的 ShippingFormula 一致；体积重是带 volumetricDivisor 的首重续重。
 * 可选字段在 zod 输出中带 `| undefined`（存 JSON 时丢弃），因此不用 satisfies 约束。
 */
export const shippingFormulaInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('first-additional'),
    currency,
    firstWeightG: positiveInt,
    firstPriceMinor: minor,
    stepWeightG: positiveInt,
    stepPriceMinor: minor,
    volumetricDivisor: z.number().int().min(1000).max(10_000).optional(),
  }),
  z.object({
    kind: z.literal('volume'),
    currency,
    pricePerCbmMinor: minor,
    minCbm: z.number().min(0).max(1000).optional(),
  }),
])

const attribute = z.string().trim().min(1).max(64)

export const logisticsProfileInput = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.enum(COSTING_PLATFORMS),
  type: z.enum(LOGISTICS_TYPES),
  transitDays: z.number().int().min(0).max(365),
  headFreight: shippingFormulaInput.nullish(),
  lastMile: shippingFormulaInput.nullish(),
  bannedAttributes: z.array(attribute).max(50),
})
export type LogisticsProfileInput = z.input<typeof logisticsProfileInput>

const rate = z.number().min(0).max(1).nullish()
export const costParamInput = z.object({
  platform: z.enum(COSTING_PLATFORMS),
  /** 空 = 平台默认 */
  categoryId: z.string().trim().max(128).nullish(),
  commissionRate: rate,
  fixedFeeMinor: minor.nullish(),
  adRate: rate,
  returnRate: rate,
  storageMonthlyMinor: minor.nullish(),
  storageMonths: z.number().min(0).max(99).nullish(),
  inboundFeeMinor: minor.nullish(),
})
export type CostParamInput = z.input<typeof costParamInput>

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式为 YYYY-MM-DD')

export const decisionInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('follow'),
    firstBatchQty: positiveInt,
    targetPriceMinor: z.number().int().positive().max(1_000_000_000),
    currency,
    plannedListingOn: isoDate,
  }),
  z.object({
    kind: z.literal('drop'),
    reason: z.enum(DROP_REASONS),
    note: z.string().trim().max(500).nullish(),
  }),
])
export type DecisionInput = z.input<typeof decisionInput>

export const outcomeInput = z.object({
  actualUnits: z.number().int().min(0).max(10_000_000),
  actualPriceMinor: z.number().int().positive().max(1_000_000_000).nullish(),
  note: z.string().trim().max(500).nullish(),
})
export type OutcomeInput = z.input<typeof outcomeInput>
