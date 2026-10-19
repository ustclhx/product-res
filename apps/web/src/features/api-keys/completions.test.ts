import { MockLanguageModelV4 } from 'ai/test'
import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatStream } from '../ai/text-stream.ts'
import { completionEventStream } from './completions.ts'

type UpstreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never

afterEach(() => {
  vi.useRealTimers()
})

describe('streaming chat completions', () => {
  it('silent reasoning writes SSE comment keepalives that the official SDK ignores', async () => {
    vi.useFakeTimers()
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
    const result = createChatStream({
      model,
      provider: 'deepseek',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: true,
      continuation: false,
      displayReasoning: false,
      inputTokens: 10,
      tokensPerChar: 1,
      maxOutputTokens: 200,
      temperature: undefined,
      controller: new AbortController(),
      deadline: Date.now() + 60_000,
      retryDelay: async () => {},
      checkpoint: () => {},
      settle: async () => {},
      heartbeatMs: 1000,
    })
    const base = { id: 'chatcmpl-reply', created: 1, model: 'test-model' }
    const reader = completionEventStream(
      { result, done: result.done.then(() => {}) },
      base,
      true,
    ).getReader()
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
    // 首个 role 分片不等待上游 token。
    expect(body).toContain('"role":"assistant"')
    upstream.enqueue({ type: 'reasoning-start', id: 'r' })
    upstream.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'hidden thought' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(body.match(/^: keepalive\n\n/gm)).toHaveLength(2)
    upstream.enqueue({ type: 'reasoning-end', id: 'r' })
    upstream.enqueue({ type: 'text-start', id: 't' })
    upstream.enqueue({ type: 'text-delta', id: 't', delta: 'answer' })
    upstream.enqueue({ type: 'text-end', id: 't' })
    upstream.enqueue({
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 15, reasoning: 5 },
      },
    })
    upstream.close()
    await vi.advanceTimersByTimeAsync(0)
    await result.done
    await reading
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()

    // 每个事件块要么全是注释行，要么是 data 行；注释不夹在 JSON 中间。
    const events = body.split('\n\n').filter(Boolean)
    for (const event of events)
      expect(event === ': keepalive' || event.startsWith('data: ')).toBe(true)
    expect(events.at(-1)).toBe('data: [DONE]')

    const sdk = new OpenAI({
      apiKey: 'test',
      baseURL: 'https://api.example/v1',
      fetch: async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
    })
    const stream = await sdk.chat.completions.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    })
    let text = ''
    let usage: unknown
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? ''
      if (chunk.usage) usage = chunk.usage
    }
    expect(text).toBe('answer')
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
  })
})
