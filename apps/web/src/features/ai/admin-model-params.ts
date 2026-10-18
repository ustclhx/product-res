import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_CHAR,
  parseMediaSchema,
  textModelConfigSchema,
} from '@product-res/ai/client'
import { AppError } from '@product-res/shared'

/** 后台与保存接口共用校验；保留管理员输入的标题、描述等原始 schema 内容。 */
export function parseAdminParamsSchema(
  kind: 'text' | 'image' | 'video',
  json: string,
): Record<string, unknown> {
  let schema: unknown
  try {
    schema = JSON.parse(json)
  } catch {
    throw new AppError('PARAMS_SCHEMA_INVALID', 'Parameter schema must be valid JSON.')
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new AppError('PARAMS_SCHEMA_INVALID', 'Parameter schema must be a JSON object.')
  }
  const paramsSchema = schema as Record<string, unknown>
  if (kind === 'text') {
    if (Object.hasOwn(paramsSchema, 'x-text')) {
      const parsed = textModelConfigSchema.safeParse(paramsSchema['x-text'])
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const field = ['x-text', ...(issue?.path ?? [])].join('.')
        throw new AppError(
          'PARAMS_SCHEMA_INVALID',
          `${field} is invalid: tokensPerChar must be positive, maxOutputTokens must be a positive integer, thinking must be boolean and continuation must be native or none; unknown x-text fields are not allowed.`,
        )
      }
    }
  } else {
    try {
      parseMediaSchema(paramsSchema)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      throw new AppError(
        'PARAMS_SCHEMA_INVALID',
        'Media parameter schema is invalid. Use the flat fields and supported validation rules in the reference templates.',
        { cause: error },
      )
    }
  }
  return paramsSchema
}

interface ParamsSchemaTemplate {
  id: string
  label: string
  kind: 'text' | 'image' | 'video'
  provider: string
  providerModelId: string
  schema: Record<string, unknown>
}

export const PARAMS_SCHEMA_TEMPLATES: ParamsSchemaTemplate[] = [
  {
    id: 'text-defaults',
    label: 'Text · x-text defaults',
    kind: 'text',
    provider: '*',
    providerModelId: '*',
    schema: {
      'x-text': {
        tokensPerChar: DEFAULT_TOKENS_PER_CHAR,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        continuation: 'none',
      },
    },
  },
  {
    id: 'workers-ai-flux-schnell',
    label: 'Workers AI · FLUX schnell',
    kind: 'image',
    provider: 'workers-ai',
    providerModelId: '@cf/black-forest-labs/flux-1-schnell',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: 'Prompt', minLength: 1, maxLength: 2048 },
        steps: { type: 'integer', title: 'Steps', minimum: 1, maximum: 8, default: 4 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    id: 'fal-flux-schnell',
    label: 'fal · FLUX schnell',
    kind: 'image',
    provider: 'fal',
    providerModelId: 'fal-ai/flux/schnell',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: 'Prompt', minLength: 1 },
        image_size: {
          type: 'string',
          title: 'Image size',
          enum: [
            'square_hd',
            'square',
            'portrait_4_3',
            'portrait_16_9',
            'landscape_4_3',
            'landscape_16_9',
          ],
          default: 'landscape_4_3',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    id: 'fal-wan-turbo',
    label: 'fal · Wan v2.2 turbo',
    kind: 'video',
    provider: 'fal',
    providerModelId: 'fal-ai/wan/v2.2-a14b/text-to-video/turbo',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: 'Prompt', minLength: 1 },
        resolution: {
          type: 'string',
          title: 'Resolution',
          enum: ['480p', '580p', '720p'],
          default: '720p',
        },
        enable_prompt_expansion: { type: 'boolean', title: 'Expand prompt', default: false },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
]
