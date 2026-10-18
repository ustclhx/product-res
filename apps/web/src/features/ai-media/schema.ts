import {
  createMediaParamsValidator,
  estimateCredits,
  type MediaParams,
  type MediaSchema,
  type Pricing,
} from '@product-res/ai/client'
import type { MediaFile } from './client.ts'

export {
  type MediaParams,
  type MediaProperty,
  type MediaSchema,
  parseMediaSchema,
} from '@product-res/ai/client'

export interface MediaModel {
  key: string
  kind: 'text' | 'image' | 'video'
  pricing: Pricing
  paramsSchema: string | null
}

export function initialMediaParams(schema: MediaSchema): MediaParams {
  const params: MediaParams = {}
  for (const [name, field] of Object.entries(schema.properties)) {
    // 文件默认值不能绕过 ready 选择；其余默认值必须满足字段约束。
    if (field.format !== 'file' && field.default !== undefined) {
      const validated = createMediaParamsValidator({
        type: 'object',
        properties: { [name]: field },
        required: [name],
      }).safeParse({ [name]: field.default })
      if (!validated.success) throw new Error('MEDIA_SCHEMA_UNSUPPORTED')
      params[name] = validated.data[name] as string | number | boolean
    } else if (field.type === 'boolean' && schema.required.includes(name)) {
      params[name] = false
    }
  }
  return params
}

export function validateMediaParams(
  schema: MediaSchema,
  params: MediaParams,
  files: readonly MediaFile[],
  kind: 'image' | 'video' = 'video',
) {
  return createMediaParamsValidator(schema, kind)
    .superRefine((params, context) => {
      for (const [name, field] of Object.entries(schema.properties)) {
        if (
          field.format === 'file' &&
          params[name] !== undefined &&
          !files.some((file) => file.id === params[name] && file.status === 'ready')
        )
          context.addIssue({ code: 'custom', path: [name], message: 'File must be ready' })
      }
    })
    .safeParse(params)
}

/** 只映射用量参数；所有倍率、取整与金额校验都复用 packages/ai 的定价函数。 */
export function mediaCreditEstimate(model: MediaModel, schema: MediaSchema, params: MediaParams) {
  const pricing = model.pricing
  if (pricing.mode === 'token') throw new Error('MEDIA_PRICING_UNSUPPORTED')
  const explicit = schema['x-media']?.unitsParam
  const name = explicit ?? (model.kind === 'image' ? 'num_images' : 'duration')
  const units = params[name] ?? 1
  if (
    typeof units !== 'number' ||
    units <= 0 ||
    (model.kind === 'image' && !Number.isSafeInteger(units))
  )
    throw new Error('MEDIA_ESTIMATE_UNAVAILABLE')
  if (pricing.mode === 'per_call') return estimateCredits(pricing, { params })
  return estimateCredits(pricing, { params, units })
}
