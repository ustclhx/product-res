import { definePrompt } from '@product-res/ai'
import { describe, expect, it } from 'vitest'
import {
  JUDGE_MAX_OUTPUT_TOKENS,
  judgeMessages,
  judgeSettings,
  runJudge,
  scoreJudgement,
} from './judge.ts'
import { fixedModel } from './mock.ts'
import type { Rubric } from './suite.ts'

const rubric: Rubric = {
  version: 'r1',
  criteria: [
    { id: 'accuracy', description: '准确', weight: 2 },
    { id: 'readability', description: '可读', weight: 1 },
  ],
  scale: { min: 1, max: 5 },
}
const prompt = definePrompt<unknown>({
  id: 'intro',
  version: 'v1',
  system: 's',
  user: () => 'u',
  maxOutputTokens: 100,
  sections: [{ id: 'overview', heading: '概述' }],
})
const messages = judgeMessages({ rubric, sampleInput: { topic: 'tea' }, prompt, output: '## 概述' })
const reply = (criteria: Record<string, { score: number; reason: string }>) =>
  JSON.stringify({ criteria, summary: 'ok' })

describe('评委', () => {
  it('提示词包含评分标准、样本输入、期望章节与被评输出', () => {
    expect(messages.system).toContain('accuracy (weight 2)')
    expect(messages.system).toContain('from 1 (worst) to 5 (best)')
    expect(messages.user).toContain('"topic": "tea"')
    expect(messages.user).toContain('overview: 概述')
    expect(messages.user).toContain('## Candidate output\n## 概述')
  })

  it('两项权重 2 与 1、分数 5 与 2 时总分为 0.75，temperature 为 0', async () => {
    const model = fixedModel({
      text: reply({ accuracy: { score: 5, reason: 'a' }, readability: { score: 2, reason: 'b' } }),
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    const call = await runJudge(model, rubric, messages)
    expect(call.outcome).toMatchObject({
      ok: true,
      score: 0.75,
      criteria: { accuracy: { score: 5, reason: 'a' }, readability: { score: 2, reason: 'b' } },
    })
    expect(call.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(model.doGenerateCalls[0]?.temperature).toBe(0)
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({ type: 'json' })
  })

  it('无法解析的输出记为评委错误，不当作 0 分', async () => {
    const call = await runJudge(fixedModel({ text: 'I think it is fine.' }), rubric, messages)
    expect(call.outcome.ok).toBe(false)
    expect(call.callFailed).toBe(false)
    expect(call.text).toBe('I think it is fine.')
  })

  it('分数越界记为评委错误', async () => {
    const call = await runJudge(
      fixedModel({
        text: reply({
          accuracy: { score: 6, reason: 'a' },
          readability: { score: 2, reason: 'b' },
        }),
      }),
      rubric,
      messages,
    )
    expect(call.outcome).toEqual({ ok: false, error: 'criterion accuracy score 6 is outside 1–5' })
    expect(
      scoreJudgement(rubric, { criteria: { accuracy: { score: 3, reason: '' } }, summary: '' }).ok,
    ).toBe(false)
  })

  it('调用失败时只保留不含 URL 的错误信息', async () => {
    const model = fixedModel(() => {
      throw new Error('fetch failed for https://gateway.example/v1/abc?key=secret')
    })
    const call = await runJudge(model, rubric, messages)
    expect(call.callFailed).toBe(true)
    expect(call.outcome).toEqual({ ok: false, error: 'fetch failed for <url>' })
  })

  it('system 经 instructions 作为首条 system 消息发送；缺省输出上限 4096、不可控 Provider 不下发 thinking', async () => {
    const model = fixedModel({
      text: reply({ accuracy: { score: 5, reason: 'a' }, readability: { score: 5, reason: 'b' } }),
    })
    const call = await runJudge(model, rubric, messages, judgeSettings('openai'))
    expect(call.outcome.ok).toBe(true)
    const request = model.doGenerateCalls[0]
    expect(request?.prompt[0]).toEqual({ role: 'system', content: messages.system })
    expect(request?.prompt.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(request?.prompt[1]).toMatchObject({ role: 'user' })
    expect(request?.maxOutputTokens).toBe(JUDGE_MAX_OUTPUT_TOKENS)
    expect(JUDGE_MAX_OUTPUT_TOKENS).toBe(4096)
    expect(request?.providerOptions?.deepseek).toBeUndefined()
    expect(request?.reasoning).toBeUndefined()
  })

  it('可控 Provider 的评委缺省显式关闭 thinking，并使用套件配置的输出上限', async () => {
    const settings = judgeSettings('deepseek', { maxOutputTokens: 2000 })
    expect(settings).toEqual({ maxOutputTokens: 2000, thinking: false, provider: 'deepseek' })
    const model = fixedModel({
      text: reply({ accuracy: { score: 4, reason: 'a' }, readability: { score: 4, reason: 'b' } }),
    })
    await runJudge(model, rubric, messages, settings)
    const request = model.doGenerateCalls[0]
    expect(request?.maxOutputTokens).toBe(2000)
    expect(request?.providerOptions).toMatchObject({
      deepseek: { thinking: { type: 'disabled' } },
    })
    expect(request?.reasoning).toBe('none')
    // 套件显式开启时下发开启形式
    expect(judgeSettings('deepseek', { thinking: true }).thinking).toBe(true)
    expect(judgeSettings('openai', { thinking: true }).thinking).toBeUndefined()
  })
})
