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

// ---- 供应商、报价与核算矩阵（tasks 2.3 / 3.1） ----

export const SUPPLIER_PLATFORMS = ['1688', 'alibaba', 'other'] as const
export const QUOTE_CONFIDENCES = ['public', 'confirmed'] as const
export const FOLLOW_MODES = ['same-source', 'improved'] as const

const optionalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => !v || /^https?:\/\//i.test(v), '链接须以 http:// 或 https:// 开头')
  .nullish()

export const supplierInput = z.object({
  name: z.string().trim().min(1, '请填写供应商名称').max(120),
  url: optionalUrl,
  platform: z.enum(SUPPLIER_PLATFORMS),
  note: z.string().trim().max(500).nullish(),
})
export type SupplierInput = z.input<typeof supplierInput>

const dimension = z.number().positive().max(1000)

export const quoteInput = z
  .object({
    supplierId: z.uuid(),
    tiers: z
      .array(z.object({ minQty: positiveInt, unitPriceMinor: minor }))
      .min(1, '至少填写一档价格')
      .max(10),
    currency,
    moq: positiveInt.nullish(),
    weightG: positiveInt.nullish(),
    dimensions: z
      .object({ lengthCm: dimension, widthCm: dimension, heightCm: dimension })
      .nullish(),
    confidence: z.enum(QUOTE_CONFIDENCES),
    quotedOn: isoDate,
    procurementDays: z.number().int().min(0).max(365).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((q) => new Set(q.tiers.map((t) => t.minQty)).size === q.tiers.length, {
    message: '阶梯的起订数量不能重复',
    path: ['tiers'],
  })
export type QuoteInput = z.input<typeof quoteInput>

/** 微改良参数；数值项留空表示尚未确定，核算时报告缺少“微改良参数” */
export const improvementInput = z.object({
  unitSurchargeRate: z.number().min(0).max(10).nullish(),
  toolingCost: z.object({ amountMinor: minor, currency }).nullish(),
  sampleDays: z.number().int().min(0).max(365).nullish(),
  note: z.string().trim().max(500).nullish(),
})
export type ImprovementInput = z.input<typeof improvementInput>

/** 矩阵的可调输入：计划数量、售价（默认竞品中位价）、商品属性（与禁运属性比对）、对比的跟卖方式 */
export const matrixOptions = z.object({
  plannedQty: positiveInt.optional(),
  salePriceMinor: z.number().int().positive().max(1_000_000_000).optional(),
  attributes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  modes: z.array(z.enum(FOLLOW_MODES)).min(1).max(2).optional(),
  /** FBA 配送费（费率表，售价币种）；SP-API 预估接通前由人工按费率表填写 */
  fbaFeeMinor: minor.optional(),
})
export type MatrixOptions = z.input<typeof matrixOptions>

export const scenarioPick = z.object({
  quoteId: z.uuid(),
  profileId: z.uuid(),
  mode: z.enum(FOLLOW_MODES),
})
export type ScenarioPick = z.infer<typeof scenarioPick>
