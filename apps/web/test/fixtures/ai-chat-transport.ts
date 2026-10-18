import { defaultLanguageModelFactory, type TextModelEnv } from '@product-res/ai'
import type { MockLanguageModelV4 } from 'ai/test'
import { expect, vi } from 'vitest'

/** 使用真实 SDK 与出口工厂，只把既有模拟模型的输出转为 OpenAI SSE。 */
export function createChatTransportFixture(env: TextModelEnv) {
  const originalFetch = globalThis.fetch
  let fixture: MockLanguageModelV4 | undefined
  let requestErrors: unknown[] = []
  const direct = env.AI_TEXT_EGRESS === 'direct'
  const endpoint = direct
    ? 'https://fixture.example/v1/chat/completions'
    : 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions'

  return {
    install() {
      fixture = undefined
      requestErrors = []
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        // 本地请求仍用原 fetch；其他外部地址拒绝，夹具绝不访问真实服务商。
        if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          return originalFetch(input, init)
        let body: {
          model: string
          stream: boolean
          max_tokens: number
          messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
        }
        try {
          expect(request.url).toBe(endpoint)
          expect(request.method).toBe('POST')
          expect(request.headers.get('cf-aig-authorization')).toBe(
            direct ? null : 'Bearer fixture-token',
          )
          expect(request.headers.get('authorization')).toBe(direct ? 'Bearer fixture-key' : null)
          body = await request.json()
          expect(body).toMatchObject({ model: 'mock-model', stream: true })
          expect(fixture).toBeDefined()
        } catch (error) {
          // 流错误会被业务按失败结算；另存断言错误，避免失败用例误吞传输断言。
          requestErrors.push(error)
          throw error
        }
        if (!fixture) throw new Error('Missing transport fixture')
        const { stream } = await fixture.doStream({
          prompt: body.messages.map(({ role, content }) =>
            role === 'system'
              ? { role, content }
              : { role, content: [{ type: 'text' as const, text: content }] },
          ),
          maxOutputTokens: body.max_tokens,
          abortSignal: request.signal,
        })
        const encoder = new TextEncoder()
        const response = stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              const emit = (value: unknown) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
              if (chunk.type === 'text-delta')
                emit({ choices: [{ index: 0, delta: { content: chunk.delta } }] })
              if (chunk.type === 'finish') {
                emit({
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: {
                    prompt_tokens: chunk.usage.inputTokens.total,
                    completion_tokens: chunk.usage.outputTokens.total,
                  },
                })
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              }
            },
          }),
        )
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } })
      })
    },
    factory(mock: MockLanguageModelV4) {
      fixture = mock
      return (model: Parameters<typeof defaultLanguageModelFactory>[0]) =>
        defaultLanguageModelFactory(model, env)
    },
    restore() {
      vi.unstubAllGlobals()
      expect(requestErrors).toEqual([])
    },
  }
}
