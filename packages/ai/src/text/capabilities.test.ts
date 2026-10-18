import type { ModelMessage } from 'ai'
import { generateText, streamText } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvailableModel } from '../models.ts'
import { getTextProviderCapabilities, supportsTextThinking } from './capabilities.ts'
import { defaultLanguageModelFactory } from './model.ts'

const model: AvailableModel = {
  id: 'm',
  key: 'deepseek',
  kind: 'text',
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1 },
  tags: [],
  paramsSchema: null,
  sort: 0,
}

afterEach(() => vi.unstubAllGlobals())

describe('文本 Provider 能力', () => {
  it('其他 Provider 不更改 thinking 调用参数且默认没有续写能力', () => {
    const params = { reasoning: 'high' as const, providerOptions: { custom: { keep: true } } }
    for (const provider of ['openai', 'anthropic', 'google', 'unknown']) {
      const capability = getTextProviderCapabilities(provider)
      expect(capability.supportsThinking).toBe(false)
      expect(capability.applyThinking(params, false)).toBe(params)
      expect(capability.continuation).toBeUndefined()
    }
  })

  it('thinking 能力缺省跟随适配器，模型覆盖不能为未注册 Provider 添加能力', () => {
    for (const provider of ['deepseek', 'deepseek.chat']) {
      expect(supportsTextThinking(provider)).toBe(true)
      expect(supportsTextThinking(provider, true)).toBe(true)
      expect(supportsTextThinking(provider, false)).toBe(false)
    }
    for (const provider of ['openai', 'unknown']) {
      expect(supportsTextThinking(provider)).toBe(false)
      expect(supportsTextThinking(provider, true)).toBe(false)
      expect(supportsTextThinking(provider, false)).toBe(false)
    }
  })

  it('DeepSeek 映射保留其他参数，并以新末条 assistant 保存纯正文前缀', () => {
    const capability = getTextProviderCapabilities('deepseek.chat')
    expect(capability.supportsThinking).toBe(true)
    const params = {
      reasoning: 'high' as const,
      maxOutputTokens: 100,
      providerOptions: { deepseek: { userId: 'u' }, other: { keep: true } },
    }
    expect(capability.applyThinking(params, false)).toEqual({
      ...params,
      reasoning: 'none',
      providerOptions: {
        deepseek: { userId: 'u', thinking: { type: 'disabled' } },
        other: { keep: true },
      },
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    expect(capability.continuation?.buildPrefix(messages, '已生成正文')).toEqual([
      ...messages,
      {
        role: 'assistant',
        content: '已生成正文',
        providerOptions: { deepseek: { prefix: true } },
      },
    ])
    expect(messages).toHaveLength(1)
    expect(params.reasoning).toBe('high')
  })

  it.each([
    { egress: 'direct', stream: false, thinking: false },
    { egress: 'direct', stream: true, thinking: true },
    { egress: 'gateway', stream: false, thinking: true },
    { egress: 'gateway', stream: true, thinking: false },
  ] as const)(
    '$egress stream=$stream thinking=$thinking 通过 beta 发送原生前缀与明确 thinking',
    async ({ egress, stream, thinking }) => {
      let request: Request | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          if (stream)
            return new Response(
              `data: ${JSON.stringify({ id: 'r', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: { content: '后续正文' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            )
          return Response.json({
            id: 'r',
            created: 1,
            model: 'deepseek-flash',
            choices: [{ index: 0, message: { content: '后续正文' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          })
        }),
      )
      const capability = getTextProviderCapabilities('deepseek')
      const messages = capability.continuation?.buildPrefix(
        [{ role: 'user', content: 'hello' }],
        '已生成正文',
      )
      if (!messages) throw new Error('Missing DeepSeek continuation')
      const options = {
        model: defaultLanguageModelFactory(model, {
          AI_TEXT_EGRESS: egress,
          ...(egress === 'direct' ? { DEEPSEEK_API_KEY: 'fixture-key' } : {}),
          AI_GATEWAY_ACCOUNT_ID: 'account',
          AI_GATEWAY_ID: 'gateway',
          AI_GATEWAY_TOKEN: 'gateway-token',
        }),
        messages,
        maxOutputTokens: 32,
        maxRetries: 0,
        ...capability.applyThinking({}, thinking),
      }
      const result = stream ? streamText(options) : await generateText(options)
      expect(await result.text).toBe('后续正文')
      expect(request?.url).toBe(
        egress === 'direct'
          ? 'https://api.deepseek.com/beta/chat/completions'
          : 'https://gateway.ai.cloudflare.com/v1/account/gateway/deepseek/beta/chat/completions',
      )
      expect(request?.headers.get('authorization')).toBe(
        egress === 'direct' ? 'Bearer fixture-key' : null,
      )
      expect(request?.headers.get('cf-aig-authorization')).toBe(
        egress === 'gateway' ? 'Bearer gateway-token' : null,
      )
      const body = await request?.json()
      expect(body).toMatchObject({
        model: 'deepseek-flash',
        max_tokens: 32,
        thinking: { type: thinking ? 'enabled' : 'disabled' },
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: '已生成正文', prefix: true },
        ],
      })
      if (!thinking) expect(body).not.toHaveProperty('reasoning_effort')
    },
  )
})
