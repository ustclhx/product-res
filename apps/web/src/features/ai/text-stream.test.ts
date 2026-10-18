import { type AvailableModel, defaultLanguageModelFactory } from '@product-res/ai'
import {
  type LanguageModel,
  readUIMessageStream,
  simulateReadableStream,
  type UIMessageChunk,
} from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChatUIMessage, messageReasoning } from './conversation.ts'
import { createChatStream } from './text-stream.ts'

const finish = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 15, reasoning: 5 },
  },
}

function start(
  model: LanguageModel,
  overrides: Partial<Parameters<typeof createChatStream>[0]> = {},
) {
  return createChatStream({
    model,
    provider: 'deepseek',
    messages: [{ role: 'user', content: 'hello' }],
    thinking: true,
    continuation: true,
    displayReasoning: true,
    inputTokens: 10,
    tokensPerChar: 1,
    maxOutputTokens: 200,
    temperature: undefined,
    controller: new AbortController(),
    deadline: Date.now() + 60_000,
    retryDelay: async () => {},
    checkpoint: () => {},
    settle: async () => {},
    ...overrides,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('single reply stream', () => {
  it.each([
    { provider: 'deepseek', thinking: false, expected: 'disabled' },
    { provider: 'deepseek', thinking: true, expected: 'enabled' },
    { provider: 'deepseek', thinking: undefined, expected: undefined },
    { provider: 'openai', thinking: undefined, expected: undefined },
  ] as const)(
    '$provider thinking=$thinking 实际 SDK 请求只携带已解析的 thinking 控制',
    async ({ provider, thinking, expected }) => {
      let body: Record<string, unknown> | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          body = (await new Request(input, init).json()) as Record<string, unknown>
          return new Response(
            `data: ${JSON.stringify({ id: 'reply', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }),
      )
      const registered: AvailableModel = {
        id: 'model',
        key: 'test-model',
        kind: 'text',
        provider,
        providerModelId: 'test-model',
        pricing: { mode: 'per_call', credits: 1 },
        tags: [],
        paramsSchema: {},
        sort: 0,
      }
      const model = defaultLanguageModelFactory(registered, {
        AI_TEXT_EGRESS: 'direct',
        DEEPSEEK_API_KEY: 'fixture-key',
        OPENAI_BASE_URL: 'https://provider.example/v1',
        OPENAI_API_KEY: 'fixture-key',
      })
      const result = start(model, { provider, thinking })
      expect(await result.done).toMatchObject({ text: 'answer', status: 'completed' })
      if (expected) expect(body).toMatchObject({ thinking: { type: expected } })
      else expect(body).not.toHaveProperty('thinking')
    },
  )

  it('SDK reads retries as one message, with only the final reasoning shown', async () => {
    let n = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: [
              { type: 'reasoning-start', id: 'r' },
              {
                type: 'reasoning-delta',
                id: 'r',
                delta: n === 1 ? 'discarded' : 'final reasoning',
              },
              { type: 'reasoning-end', id: 'r' },
              ...(n === 1
                ? []
                : [
                    { type: 'text-start' as const, id: 't' },
                    { type: 'text-delta' as const, id: 't', delta: 'answer' },
                    { type: 'text-end' as const, id: 't' },
                  ]),
              finish,
            ],
          }),
        }
      },
    })
    const result = start(model)
    const response = result.toUIMessageStreamResponse({
      metadata: { messageId: 'same-reply', conversationId: 'conversation' },
      headers: {},
    })
    const chunks = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk)
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    let last: ChatUIMessage | undefined
    for await (const message of readUIMessageStream<ChatUIMessage>({ stream })) last = message
    expect(last?.id).toBe('same-reply')
    expect(last && messageReasoning(last)).toBe('final reasoning')
    expect(last?.parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'answer', state: 'done' },
    ])
    expect(await result.done).toMatchObject({
      total: { inputTokens: 20, outputTokens: 40, reasoningTokens: 10 },
      absorbed: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
    })
  })

  it('consumer disconnection still drains and settles the provider stream', async () => {
    const settle = vi.fn()
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 5,
          chunks: [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'first' },
            { type: 'text-delta', id: 't', delta: 'second' },
            { type: 'text-end', id: 't' },
            finish,
          ],
        }),
      }),
    })
    const result = start(model, { settle })
    const reader = result.fullStream.getReader()
    expect(await reader.read()).toMatchObject({ value: { type: 'text-delta', text: 'first' } })
    await reader.cancel()
    expect(await result.done).toMatchObject({ text: 'firstsecond', status: 'completed' })
    expect(settle).toHaveBeenCalledOnce()
  })

  it('user stop during backoff prevents another upstream attempt', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [finish],
        }),
      }),
    })
    const result = start(model, {
      controller,
      retryDelay: async () => {
        controller.abort('stop')
      },
    })
    expect(await result.done).toMatchObject({ status: 'aborted', text: '' })
    expect(model.doStreamCalls).toHaveLength(1)
  })
})
