import { type AvailableModel, type TextFaultProof, wrapTextFaultModel } from '@product-res/ai'
import { streamText } from 'ai'
import type { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { defaultLanguageModelFactory } from '../../../e2e/staging-acceptance/local-text-model.ts'

const model: AvailableModel = {
  id: 'fixture',
  key: 'acceptance-fault-local',
  kind: 'text',
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 2 },
  tags: [],
  paramsSchema: {},
  sort: 0,
}

describe('本地文本验收上游', () => {
  it.each(['chat-before-stream', 'chat-mid-stream'] as const)(
    '%s 实际经过生产包装器，流错误不能由本地模型工厂替代',
    async (mode) => {
      const upstream = defaultLanguageModelFactory(model, {}) as MockLanguageModelV4
      const proofs: TextFaultProof[] = []
      let output = ''
      const result = streamText({
        model: wrapTextFaultModel(upstream, {
          mode,
          env: { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' },
          tokensPerChar: 1,
          writeProof: async (proof) => {
            proofs.push(proof)
            return true
          },
        }),
        prompt: 'local fixture',
        maxRetries: 0,
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta') output += chunk.text
        },
        onError: () => {},
      })
      await result.consumeStream({ onError: () => {} })
      expect(proofs.at(-1)).toMatchObject({
        mode,
        injected: true,
        realProviderCalled: mode === 'chat-mid-stream',
        upstreamCalls: mode === 'chat-mid-stream' ? 1 : 0,
      })
      expect(upstream.doStreamCalls).toHaveLength(mode === 'chat-mid-stream' ? 1 : 0)
      expect(output.length).toBe(mode === 'chat-before-stream' ? 0 : 226)
    },
  )

  it('故障模型未关闭思考时只回 reasoning，复现 staging 未注入', async () => {
    const upstream = defaultLanguageModelFactory(model, {}) as MockLanguageModelV4
    const result = streamText({ model: upstream, prompt: 'local fixture', maxRetries: 0 })
    expect(await result.text).toBe('')
    expect(await result.reasoningText).toHaveLength(1024)
    expect((await result.totalUsage).outputTokens).toBe(1024)
  })

  it('未知服务商或模型 ID 明确拒绝，不能回退真实 Provider', () => {
    for (const changes of [{ provider: 'openai' }, { providerModelId: 'unknown-model' }])
      expect(() => defaultLanguageModelFactory({ ...model, ...changes }, {})).toThrow(
        expect.objectContaining({ code: 'AI_PROVIDER_NOT_CONFIGURED' }),
      )
  })
})
