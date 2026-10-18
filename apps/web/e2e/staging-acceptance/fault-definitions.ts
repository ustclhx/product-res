import type { AcceptanceFaultMode, Pricing } from '@product-res/ai'
import { deepseekCall, deepseekToken, falImage, workersImage } from './models.ts'

export interface FaultModelDefinition {
  key: string
  kind: 'text' | 'image'
  provider: string
  providerModelId: string
  pricing: Pricing
  sort: number
  params: Record<string, unknown>
  paramsSchema: Record<string, unknown>
  mode: AcceptanceFaultMode
}

const mediaModes = [
  'workers-error',
  'workers-timeout',
  'fal-callback-lost',
  'fal-callback-early',
  'fal-submit-response-lost',
  'fal-provider-error',
  'fal-timeout',
] as const

export const FAULT_MODELS: readonly FaultModelDefinition[] = [
  ...mediaModes.map((mode, index) => {
    const base = mode.startsWith('workers-') ? workersImage : falImage
    return {
      ...base,
      key: `acceptance-fault-${mode}`,
      mode,
      sort: -2000 + index,
      params: { ...base.params },
      paramsSchema: { ...base.paramsSchema, 'x-acceptance-fault': { mode } },
    }
  }),
  ...(['chat-before-stream', 'chat-mid-stream'] as const).flatMap((mode, index) =>
    [deepseekToken, deepseekCall].map((base, pricingIndex) => ({
      ...base,
      key: `acceptance-fault-${mode}-${base.pricing.mode}`,
      mode,
      sort: -1990 + index * 2 + pricingIndex,
      params: {},
      paramsSchema: {
        'x-text': { tokensPerChar: 1, maxOutputTokens: 1024 },
        'x-acceptance-fault': { mode },
      },
    })),
  ),
]

export function faultScenarioId(model: FaultModelDefinition): string {
  return `${model.mode}-${model.pricing.mode}`
}

/**
 * 可选的场景子集（逗号分隔的场景 ID，如 `chat-mid-stream-per_call`），用于修复后只重跑失败场景，
 * 避免为已通过场景重复付费。未知或重复 ID 直接拒绝，不静默退回全量矩阵。
 */
export function selectFaultModels(
  filter = process.env.STAGING_FAULT_SCENARIOS,
): readonly FaultModelDefinition[] {
  if (!filter?.trim()) return FAULT_MODELS
  const ids = filter.split(',').map((id) => id.trim())
  const known = new Set(FAULT_MODELS.map(faultScenarioId))
  if (ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length)
    throw new Error('Invalid STAGING_FAULT_SCENARIOS')
  return FAULT_MODELS.filter((model) => ids.includes(faultScenarioId(model)))
}
