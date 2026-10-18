import { generateText, streamText } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvailableModel } from '../models.ts'
import {
  AI_PROVIDER_NOT_CONFIGURED,
  defaultLanguageModelFactory,
  type TextModelEnv,
} from './model.ts'

const env: TextModelEnv = {
  AI_GATEWAY_ACCOUNT_ID: 'account',
  AI_GATEWAY_ID: 'gateway',
  AI_GATEWAY_TOKEN: 'gateway-token',
}

const providers = [
  {
    provider: 'openai',
    path: 'openai/chat/completions',
    key: 'OPENAI_API_KEY',
    header: 'authorization',
  },
  {
    provider: 'anthropic',
    path: 'anthropic/v1/messages',
    key: 'ANTHROPIC_API_KEY',
    header: 'x-api-key',
  },
  {
    provider: 'google',
    path: 'google-ai-studio/v1beta/models/model-id:generateContent',
    key: 'GOOGLE_API_KEY',
    header: 'x-goog-api-key',
  },
  {
    provider: 'deepseek',
    path: 'deepseek/chat/completions',
    key: 'DEEPSEEK_API_KEY',
    header: 'authorization',
  },
] as const

function model(provider: string): AvailableModel {
  return {
    id: 'm',
    key: 'display-key',
    kind: 'text',
    provider,
    providerModelId: 'model-id',
    pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1 },
    tags: [],
    paramsSchema: null,
    sort: 0,
  }
}

function response(provider: string) {
  if (provider === 'anthropic')
    return {
      id: 'response',
      type: 'message',
      role: 'assistant',
      model: 'model-id',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }
  if (provider === 'google')
    return {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    }
  return {
    id: 'response',
    created: 1,
    model: 'model-id',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('OpenAI 兼容直连', () => {
  it('无 Gateway 凭据即可使用管理员 base/key 与注册表模型 ID，不发送 cf-aig 头', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unintended-process-key')
    let request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init)
        return Response.json(response('openai'))
      }),
    )
    const result = await generateText({
      model: defaultLanguageModelFactory(model('openai'), {
        AI_TEXT_EGRESS: 'direct',
        OPENAI_BASE_URL: 'https://compatible.example/api/v1/',
        OPENAI_API_KEY: ' direct-fixture-key ',
        AI_GATEWAY_TOKEN: 'ignored-gateway-token',
      }),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(result.text).toBe('hello')
    if (!request) throw new Error('Missing fixture request')
    expect(request?.url).toBe('https://compatible.example/api/v1/chat/completions')
    expect(request?.headers.get('authorization')).toBe('Bearer direct-fixture-key')
    expect([...request.headers.keys()].some((key) => key.startsWith('cf-aig-'))).toBe(false)
    expect((await request.json()).model).toBe('model-id')
  })

  it.each([
    { OPENAI_BASE_URL: 'https://compatible.example/v1' },
    { OPENAI_API_KEY: 'fixture-key' },
    { OPENAI_BASE_URL: 'file:///private', OPENAI_API_KEY: 'fixture-key' },
    { OPENAI_BASE_URL: 'https://user:secret@example.test/v1', OPENAI_API_KEY: 'fixture-key' },
    { OPENAI_BASE_URL: 'https://example.test/v1?key=secret', OPENAI_API_KEY: 'fixture-key' },
  ])('非法直连配置在调用前拒绝且不回退 SDK 环境密钥', (config) => {
    vi.stubEnv('OPENAI_API_KEY', 'unintended-process-key')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(() =>
      defaultLanguageModelFactory(model('openai'), {
        ...config,
        AI_TEXT_EGRESS: 'direct',
      }),
    ).toThrowError(expect.objectContaining({ code: AI_PROVIDER_NOT_CONFIGURED, status: 503 }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('显式 gateway 不受已配置 direct base 的影响', async () => {
    let request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init)
        return Response.json(response('openai'))
      }),
    )
    await generateText({
      model: defaultLanguageModelFactory(model('openai'), {
        ...env,
        AI_TEXT_EGRESS: 'gateway',
        OPENAI_BASE_URL: 'https://ignored.example/v1',
      }),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(request?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions',
    )
    expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
    expect(request?.headers.has('authorization')).toBe(false)
  })
})

describe('Gateway 默认模型工厂', () => {
  it.each(providers)(
    '$provider 默认 BYOK，经兼容端点发送 Gateway 鉴权，不读取 SDK 环境密钥',
    async ({ provider, path, key }) => {
      vi.stubEnv(key, 'unintended-process-key')
      // Google SDK 默认读取的环境变量与本项目显式绑定名不同。
      vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'unintended-google-key')
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'unintended-anthropic-token')
      let request: Request | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json(response(provider))
        }),
      )
      const result = await generateText({
        model: defaultLanguageModelFactory(model(provider), env),
        prompt: 'hello',
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(result.text).toBe('hello')
      expect(request?.url).toBe(`https://gateway.ai.cloudflare.com/v1/account/gateway/${path}`)
      expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
      for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) {
        expect(request?.headers.has(header)).toBe(false)
      }
      const body = await request?.json()
      if (provider !== 'google') expect(body.model).toBe('model-id')
      if (provider === 'anthropic')
        expect(request?.headers.get('anthropic-version')).toBe('2023-06-01')
    },
  )

  it.each(providers)(
    '$provider 可显式提供服务商密钥，仍经 Gateway',
    async ({ provider, path, key, header }) => {
      let request: Request | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json(response(provider))
        }),
      )
      await generateText({
        model: defaultLanguageModelFactory(model(provider), { ...env, [key]: 'provider-key' }),
        prompt: 'hello',
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(request?.url).toBe(`https://gateway.ai.cloudflare.com/v1/account/gateway/${path}`)
      expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
      expect(request?.headers.get(header)).toBe(
        header === 'authorization' ? 'Bearer provider-key' : 'provider-key',
      )
    },
  )

  it.each([
    { provider: 'openai', config: {} },
    { provider: 'openai', config: { ...env, AI_GATEWAY_ACCOUNT_ID: ' ' } },
    { provider: 'openai', config: { ...env, AI_GATEWAY_ID: '' } },
    { provider: 'unsupported', config: env },
  ])('配置缺失或 provider=$provider 不支持时，调用前返回 503', ({ provider, config }) => {
    expect(() => defaultLanguageModelFactory(model(provider), config)).toThrowError(
      expect.objectContaining({ code: AI_PROVIDER_NOT_CONFIGURED, status: 503 }),
    )
  })
})

describe('DeepSeek 直连（#152）', () => {
  const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const delta = (delta: Record<string, string>) =>
    sse({ id: 'r', created: 1, model: 'model-id', choices: [{ index: 0, delta }] })

  it('direct 且有密钥时以流式请求直连官方端点，并在上游结束前逐块转出 reasoning 与正文', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'unintended-process-key')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init)
        const encoder = new TextEncoder()
        // 模拟服务商逐 token 输出：第二段在测试放行前不会到达。
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(delta({ reasoning_content: 'think' })))
            controller.enqueue(encoder.encode(delta({ content: 'first' })))
            await gate
            controller.enqueue(encoder.encode(delta({ content: ' second' })))
            controller.enqueue(
              encoder.encode(
                sse({
                  id: 'r',
                  created: 1,
                  model: 'model-id',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
                }),
              ),
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }),
    )
    const result = streamText({
      model: defaultLanguageModelFactory(model('deepseek'), {
        ...env,
        AI_TEXT_EGRESS: 'direct',
        DEEPSEEK_API_KEY: ' direct-deepseek-key ',
      }),
      prompt: 'hello',
      maxRetries: 0,
    })
    const seen: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta' || part.type === 'text-delta') seen.push(part.text)
      // 首段正文到达时上游仍未结束：证明不是读完整个响应后再转出。
      if (part.type === 'text-delta' && part.text === 'first') release()
    }
    expect(seen).toEqual(['think', 'first', ' second'])
    expect(request?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(request?.headers.get('authorization')).toBe('Bearer direct-deepseek-key')
    expect([...(request?.headers.keys() ?? [])].some((key) => key.startsWith('cf-aig-'))).toBe(
      false,
    )
    expect(await request?.json()).toMatchObject({ model: 'model-id', stream: true })
  })

  it('direct 但未配置 DeepSeek 密钥时保持 Gateway BYOK 路径', async () => {
    let request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init)
        return Response.json(response('deepseek'))
      }),
    )
    await generateText({
      model: defaultLanguageModelFactory(model('deepseek'), {
        ...env,
        AI_TEXT_EGRESS: 'direct',
        DEEPSEEK_API_KEY: ' ',
      }),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(request?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account/gateway/deepseek/chat/completions',
    )
    expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
    expect(request?.headers.has('authorization')).toBe(false)
  })
})
