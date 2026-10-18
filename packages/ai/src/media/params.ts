import { AppError } from '@product-res/shared'
import { z } from 'zod'
import { parseAcceptanceFaultMetadata } from '../fault.ts'

const configurationError = () =>
  new AppError('MEDIA_SCHEMA_INVALID', 'Media model parameter schema is not supported', {
    status: 503,
  })
const rootKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  '$schema',
  'x-media',
  'x-acceptance-fault',
])
const fieldKeys = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'default',
  'title',
  'description',
])
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const fieldSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  enum: z
    .array(z.union([z.string(), z.number().finite(), z.boolean()]))
    .min(1)
    .optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  exclusiveMinimum: z.number().finite().optional(),
  exclusiveMaximum: z.number().finite().optional(),
  multipleOf: z.number().finite().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(['file', 'uuid']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
})

export type MediaProperty = z.infer<typeof fieldSchema>
export type MediaParams = Record<string, string | number | boolean>
export interface MediaSchema {
  type: 'object'
  properties: Record<string, MediaProperty>
  required: string[]
  'x-media'?: { unitsParam?: string | undefined } | undefined
}

/** 首版表单只支持平面标量字段；未知校验关键字必须拒绝，不能静默忽略而放行。 */
export function parseMediaSchema(schema: Record<string, unknown> | null): MediaSchema {
  if (
    schema?.type !== 'object' ||
    !plainObject(schema.properties) ||
    Object.keys(schema).some((key) => !rootKeys.has(key)) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key) =>
            typeof key !== 'string' ||
            !Object.hasOwn(schema.properties as Record<string, unknown>, key),
        )))
  )
    throw configurationError()
  const properties: Record<string, Record<string, unknown>> = {}
  for (const [name, field] of Object.entries(schema.properties)) {
    if (
      !plainObject(field) ||
      !fieldSchema.safeParse(field).success ||
      !['string', 'number', 'integer', 'boolean'].includes(String(field.type)) ||
      Object.keys(field).some((key) => !fieldKeys.has(key)) ||
      (field.format !== undefined && field.format !== 'file' && field.format !== 'uuid')
    )
      throw configurationError()
    if (field.format === 'file' && field.type !== 'string') throw configurationError()
    properties[name] = field
  }
  const media = schema['x-media']
  if (Object.hasOwn(schema, 'x-acceptance-fault'))
    parseAcceptanceFaultMetadata(schema['x-acceptance-fault'])
  if (
    media !== undefined &&
    (!plainObject(media) ||
      Object.keys(media).some((key) => key !== 'unitsParam') ||
      (media.unitsParam !== undefined && typeof media.unitsParam !== 'string'))
  )
    throw configurationError()
  const unitsParam = plainObject(media) ? media.unitsParam : undefined
  if (
    plainObject(media) &&
    media.unitsParam !== undefined &&
    !['number', 'integer'].includes(String(properties[String(unitsParam)]?.type))
  )
    throw configurationError()
  const parsed = { ...schema, required: schema.required ?? [] } as unknown as MediaSchema
  // 提前构建校验器，让正则等配置错误在表单打开时即可暴露。
  createMediaParamsValidator(parsed)
  return parsed
}

/** 浏览器与服务端共用 JSON Schema 转换，默认值和约束均以服务端语义为准。 */
export function createMediaParamsValidator(schema: MediaSchema, kind?: 'image' | 'video') {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, field]) => [
      name,
      { ...field, ...(field.format === 'file' ? { format: 'uuid' } : {}) },
    ]),
  )
  let validator: z.ZodType<MediaParams>
  try {
    validator = z.fromJSONSchema({
      ...schema,
      properties,
      additionalProperties: false,
      'x-media': undefined,
      'x-acceptance-fault': undefined,
    } as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<MediaParams>
  } catch {
    throw configurationError()
  }
  if (!kind) return validator
  const unitsParam = schema['x-media']?.unitsParam ?? (kind === 'image' ? 'num_images' : 'duration')
  return validator.superRefine((params, context) => {
    const units = params[unitsParam] ?? 1
    if (
      typeof units !== 'number' ||
      !Number.isFinite(units) ||
      units <= 0 ||
      (kind === 'image' && !Number.isSafeInteger(units))
    )
      context.addIssue({
        code: 'custom',
        path: [unitsParam],
        message: 'Media units must be positive',
      })
  })
}
