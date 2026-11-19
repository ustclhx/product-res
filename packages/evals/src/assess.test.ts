import { describe, expect, it } from 'vitest'
import {
  collect,
  type EvaluationGroup,
  type EvaluationResult,
  isJsonRecord,
  mean,
  percentile,
  runAssessment,
} from './assess.ts'

const result = (id: string, accuracy?: number): EvaluationResult => ({
  id,
  tags: [],
  status: accuracy === undefined ? 'judge-error' : 'passed',
  checks: [],
  judge:
    accuracy === undefined
      ? { status: 'judge-error', model: 'judge', error: 'judge output could not be parsed' }
      : {
          status: 'scored',
          model: 'judge',
          score: 1,
          criteria: { accuracy: { score: accuracy, reason: 'r' } },
        },
  usage: {},
})
const group = (results: EvaluationResult[]): EvaluationGroup => ({
  promptVersion: 'demo@v2',
  source: 'run',
  prepareVersion: null,
  generator: null,
  judge: null,
  results,
})
const ctx = {
  samples: [],
  scope: { totalSamples: 0, selectedSamples: 0, filtered: false },
  mode: 'replay' as const,
  rubric: null,
  candidate: group([]),
  baseline: null,
}

describe('统计辅助', () => {
  it('最近秩分位数：20 个值的 P95 取第 19 个，P50 取第 10 个；空集合为 null', () => {
    const values = Array.from({ length: 20 }, (_, index) => 20 - index)
    expect(percentile(values, 95)).toBe(19)
    expect(percentile(values, 50)).toBe(10)
    expect(percentile(values, 100)).toBe(20)
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([], 95)).toBeNull()
    expect(() => percentile([1], 0)).toThrow(RangeError)
  })

  it('均值：空集合为 null', () => {
    expect(mean([4, 5])).toBe(4.5)
    expect(mean([])).toBeNull()
  })

  it('collect 按 ID 对齐，缺样本与缺分数都进入 missing，不缩小分母', () => {
    const collected = collect(
      group([result('s2', 4), result('s1', 5), result('s3')]),
      ['s1', 's2', 's3', 's4'],
      (item) => item.judge?.criteria?.accuracy?.score,
    )
    expect(collected).toEqual({ values: [5, 4], missing: ['s3', 's4'], expected: 4 })
    expect(collect(null, ['s1'], () => 1).missing).toEqual(['s1'])
  })

  it('isJsonRecord 拒绝 Date、undefined 值、NaN、数组与类实例', () => {
    expect(isJsonRecord({ a: 1, b: [1, 'x'], c: { d: null } })).toBe(true)
    expect(isJsonRecord({ at: new Date() })).toBe(false)
    expect(isJsonRecord({ a: undefined })).toBe(false)
    expect(isJsonRecord({ a: Number.NaN })).toBe(false)
    expect(isJsonRecord([1])).toBe(false)
    expect(isJsonRecord(new Map())).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(isJsonRecord(circular)).toBe(false)
    // 嵌套的无原型对象与 -0 都是合法 JSON 数据
    expect(isJsonRecord({ nested: Object.assign(Object.create(null), { a: 1 }), zero: -0 })).toBe(
      true,
    )
  })
})

describe('门槛结果校验', () => {
  it('failed 或必需 incomplete 判为未达成；非必需 incomplete 不影响', async () => {
    const met = await runAssessment(
      () => ({
        gates: [
          { id: 'a', status: 'passed', detail: 'ok' },
          { id: 'coverage', status: 'incomplete', detail: 'filtered', required: false },
        ],
      }),
      ctx,
    )
    expect(met.failed).toBe(false)
    expect(met.gates.map((gate) => gate.required)).toEqual([true, false])
    const missing = await runAssessment(
      () => ({ gates: [{ id: 'a', status: 'incomplete', detail: 'missing s2' }] }),
      ctx,
    )
    expect(missing.failed).toBe(true)
  })

  it.each([
    ['抛出异常', () => Promise.reject(new Error('boom')), /evaluateRun threw: boom/],
    ['没有 gates', () => ({}), /must return/],
    [
      '重复 ID',
      () => ({
        gates: [
          { id: 'a', status: 'passed', detail: '' },
          { id: 'a', status: 'passed', detail: '' },
        ],
      }),
      /duplicate/,
    ],
    ['非法状态', () => ({ gates: [{ id: 'a', status: 'ok', detail: '' }] }), /status/],
    [
      'metrics 不可序列化',
      () => ({ gates: [{ id: 'a', status: 'passed', detail: '', metrics: { at: new Date() } }] }),
      /metrics/,
    ],
  ])('%s时记 evaluate-run 失败门槛', async (_name, evaluate, pattern) => {
    // biome-ignore lint/suspicious/noExplicitAny: 故意传入不合法的返回
    const assessment = await runAssessment(evaluate as any, ctx)
    expect(assessment.failed).toBe(true)
    expect(assessment.gates).toHaveLength(1)
    expect(assessment.gates[0]).toMatchObject({ id: 'evaluate-run', status: 'failed' })
    expect(assessment.gates[0]?.detail).toMatch(pattern)
  })

  it('hook 修改传入的结果不影响调用方', async () => {
    const candidate = group([result('s1', 5)])
    await runAssessment(
      (input) => {
        ;(input.candidate.results as EvaluationResult[]).length = 0
        return { gates: [] }
      },
      { ...ctx, candidate },
    )
    expect(candidate.results).toHaveLength(1)
  })
})
