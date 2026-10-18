import { createMediaParamsValidator, parseMediaSchema } from '@product-res/ai/client'
import { AppError } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import recorded from '../../../../../packages/ai/src/media/fixtures/fal.recorded.json'
import { PARAMS_SCHEMA_TEMPLATES, parseAdminParamsSchema } from './admin-model-params.ts'

describe('parseAdminParamsSchema', () => {
  it.each(['{', '', 'null', '[]', '1', '"schema"'])('rejects invalid JSON objects: %s', (json) => {
    expect(() => parseAdminParamsSchema('text', json)).toThrow(AppError)
  })

  it.each([
    {},
    { type: 'object', properties: { nested: { type: 'object' } } },
    { type: 'object', properties: { prompt: { type: 'string', pattern: '[' } } },
    { type: 'object', properties: {}, required: ['prompt'] },
  ])('rejects unsupported media schemas: %j', (schema) => {
    expect(() => parseAdminParamsSchema('image', JSON.stringify(schema))).toThrow(
      'Media parameter schema is invalid',
    )
  })

  it.each([
    { tokensPerChar: 0 },
    { tokensPerChar: -1 },
    { tokensPerChar: '1' },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { thinking: 'true' },
    { thinking: null },
    { continuation: 'prompt' },
    { continuation: true },
    { thinking: true, unknown: true },
    null,
  ])('rejects invalid text configuration: %j', (config) => {
    expect(() => parseAdminParamsSchema('text', JSON.stringify({ 'x-text': config }))).toThrow(
      'x-text',
    )
  })

  it('allows text defaults and preserves schema metadata', () => {
    expect(parseAdminParamsSchema('text', '{}')).toEqual({})
    const schema = {
      title: 'Text model',
      'x-text': {
        tokensPerChar: 1.5,
        maxOutputTokens: 2048,
        thinking: true,
        continuation: 'native',
      },
    }
    expect(parseAdminParamsSchema('text', JSON.stringify(schema))).toEqual(schema)
  })

  it('preserves media schema content without inserting omitted fields', () => {
    const schema = { type: 'object', title: 'Test', properties: { prompt: { type: 'string' } } }
    expect(parseAdminParamsSchema('image', JSON.stringify(schema))).toEqual(schema)
  })
})

describe('parameter schema templates', () => {
  it.each(PARAMS_SCHEMA_TEMPLATES)('$id is accepted by the shared parser', ({ kind, schema }) => {
    expect(parseAdminParamsSchema(kind, JSON.stringify(schema))).toEqual(schema)
    if (kind !== 'text') {
      const validator = createMediaParamsValidator(parseMediaSchema(schema), kind)
      expect(validator.safeParse({ prompt: 'A red square' }).success).toBe(true)
    }
  })

  it('text defaults leave thinking capability to the Provider adapter', () => {
    const template = PARAMS_SCHEMA_TEMPLATES.find((item) => item.id === 'text-defaults')
    expect(template?.schema['x-text']).not.toHaveProperty('thinking')
  })

  it('Wan turbo accepts the recorded request and rejects unsupported duration', () => {
    const template = PARAMS_SCHEMA_TEMPLATES.find((item) => item.id === 'fal-wan-turbo')
    if (!template) throw new Error('Wan turbo template missing')
    const validator = createMediaParamsValidator(parseMediaSchema(template.schema), 'video')
    const params = recorded.metadata.videoInput
    expect(template.providerModelId).toBe(recorded.metadata.videoModel)
    expect(validator.parse(params)).toEqual(params)
    expect(validator.safeParse({ ...params, resolution: '1080p' }).success).toBe(false)
    expect(validator.safeParse({ ...params, duration: 5 }).success).toBe(false)
  })
})
