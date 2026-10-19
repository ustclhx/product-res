import { type AvailableModel, defaultLanguageModelFactory } from '@product-res/ai'
import { AppError } from '@product-res/shared'
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

type UpstreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never

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

/** 上游流由测试逐块推送，模拟推理模型长时间只产生隐藏 reasoning。 */
function controlledModel() {
  let upstream!: ReadableStreamDefaultController<UpstreamPart>
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<UpstreamPart>({
        start(controller) {
          upstream = controller
        },
      }),
    }),
  })
  return {
    model,
    push: (...parts: UpstreamPart[]) => {
      for (const part of parts) upstream.enqueue(part)
    },
    end: () => {
      upstream.enqueue(finish)
      upstream.close()
    },
  }
}

const silentThinking: UpstreamPart[] = [
  { type: 'reasoning-start', id: 'r' },
  { type: 'reasoning-delta', id: 'r', delta: 'hidden thought' },
]

describe('idle heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hidden reasoning longer than the interval emits keepalives; real output resets the timer', async () => {
    vi.useFakeTimers()
    const upstream = controlledModel()
    const result = start(upstream.model, { displayReasoning: false, heartbeatMs: 1000 })
    const parts: string[] = []
    const reading = (async () => {
      for await (const part of result.fullStream) parts.push(part.type)
    })()
    await vi.advanceTimersByTimeAsync(0)
    upstream.push(...silentThinking)
    await vi.advanceTimersByTimeAsync(2500)
    expect(parts).toEqual(['keepalive', 'keepalive'])
    upstream.push(
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'answer' },
    )
    // 2500ms 时有正文：未重置会在 3000ms 补发，重置后要到 3500ms。
    await vi.advanceTimersByTimeAsync(900)
    expect(parts).toEqual(['keepalive', 'keepalive', 'text-delta'])
    await vi.advanceTimersByTimeAsync(100)
    expect(parts).toEqual(['keepalive', 'keepalive', 'text-delta', 'keepalive'])
    upstream.push({ type: 'text-end', id: 't' })
    upstream.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(await result.done).toMatchObject({ text: 'answer', reasoning: '', status: 'completed' })
    await reading
    expect(vi.getTimerCount()).toBe(0)
  })

  it('UI stream starts before the first upstream token and keepalives never reach message parts', async () => {
    vi.useFakeTimers()
    const upstream = controlledModel()
    const result = start(upstream.model, { displayReasoning: false, heartbeatMs: 1000 })
    const response = result.toUIMessageStreamResponse({
      metadata: { messageId: 'reply', conversationId: 'conversation' },
      headers: {},
    })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let body = ''
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        body += decoder.decode(value, { stream: true })
      }
    })()
    await vi.advanceTimersByTimeAsync(0)
    // 上游尚未产出任何 token，start 片段已写出，响应头随之发送。
    expect(body).toContain('"type":"start"')
    upstream.push(...silentThinking)
    await vi.advanceTimersByTimeAsync(1000)
    expect(body).toContain('{"type":"data-keepalive","data":null,"transient":true}')
    upstream.push(
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'answer' },
      { type: 'text-end', id: 't' },
    )
    upstream.end()
    await vi.advanceTimersByTimeAsync(0)
    await result.done
    await reading
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    const chunks = body
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
    expect(last?.parts).toEqual([{ type: 'text', text: 'answer', state: 'done' }])
  })

  it('consumer cancel stops the heartbeat while the provider stream drains', async () => {
    vi.useFakeTimers()
    const upstream = controlledModel()
    const result = start(upstream.model, { displayReasoning: false, heartbeatMs: 1000 })
    const reader = result.fullStream.getReader()
    await vi.advanceTimersByTimeAsync(0)
    upstream.push(...silentThinking)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await reader.read()).toMatchObject({ value: { type: 'keepalive' } })
    await reader.cancel()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(0)
    upstream.push(
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'answer' },
      { type: 'text-end', id: 't' },
    )
    upstream.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(await result.done).toMatchObject({ text: 'answer', status: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('failed reply clears the heartbeat after the error part', async () => {
    vi.useFakeTimers()
    const upstream = controlledModel()
    const result = start(upstream.model, { displayReasoning: false, heartbeatMs: 1000 })
    const parts: string[] = []
    const reading = (async () => {
      for await (const part of result.fullStream) parts.push(part.type)
    })()
    await vi.advanceTimersByTimeAsync(0)
    // 确定业务拒绝不重试，回复直接失败。
    upstream.push({ type: 'error', error: new AppError('UPSTREAM_REJECTED', 'boom') })
    upstream.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(await result.done).toMatchObject({ status: 'failed' })
    await reading
    expect(parts.at(-1)).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })
})
