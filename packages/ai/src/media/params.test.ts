import { describe, expect, it } from 'vitest'
import { ACCEPTANCE_FAULT_INVALID } from '../fault.ts'
import { createMediaParamsValidator, parseMediaSchema } from './params.ts'

const schema = {
  type: 'object',
  properties: { prompt: { type: 'string', minLength: 1 } },
  required: ['prompt'],
  additionalProperties: false,
  'x-acceptance-fault': { mode: 'fal-callback-lost' },
}

describe('acceptance fault media schema', () => {
  it('接受合法顶层元数据但不将其作为表单字段或 Provider 参数', () => {
    const parsed = parseMediaSchema(schema)
    expect(Object.keys(parsed.properties)).toEqual(['prompt'])
    expect(createMediaParamsValidator(parsed, 'image').parse({ prompt: 'test' })).toEqual({
      prompt: 'test',
    })
  })

  it('未知模式和额外故障控制配置在解析 schema 时拒绝', () => {
    for (const fault of [null, { mode: 'unknown' }, { mode: 'fal-timeout', deadline: 1 }])
      expect(() => parseMediaSchema({ ...schema, 'x-acceptance-fault': fault })).toThrow(
        expect.objectContaining({ code: ACCEPTANCE_FAULT_INVALID }),
      )
  })

  it('请求不能伪造模式、快照、延迟或 deadline', () => {
    const validator = createMediaParamsValidator(parseMediaSchema(schema), 'image')
    for (const field of ['x-acceptance-fault', 'acceptanceFault', 'mode', 'delay', 'deadline'])
      expect(validator.safeParse({ prompt: 'test', [field]: 'fal-timeout' }).success).toBe(false)
  })
})
