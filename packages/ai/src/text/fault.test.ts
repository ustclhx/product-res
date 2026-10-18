import { createDeepSeek } from '@ai-sdk/deepseek'
import type { AiFaultInjectionEnv } from '@product-res/config'
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { type TextFaultMode, type TextFaultProof, wrapTextFaultModel } from './fault.ts'

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never
const enabled: AiFaultInjectionEnv = {
  SENTRY_ENVIRONMENT: 'staging',
  AI_FAULT_INJECTION: 'enabled',
}
const finish: StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  },
}
const delta = (text: string): StreamPart => ({ type: 'text-delta', id: 't', delta: text })

function fixture(chunks: StreamPart[], mode: TextFaultMode = 'chat-mid-stream', tokensPerChar = 1) {
  const cancel = vi.fn()
  const upstream = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>(
        {
          pull(controller) {
            const chunk = chunks.shift()
            if (chunk) controller.enqueue(chunk)
            else controller.close()
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    }),
  })
  const proofs: TextFaultProof[] = []
  const env = { ...enabled }
  const writeProof = vi.fn(async (proof: TextFaultProof) => {
    proofs.push(proof)
    return true
  })
  const model = wrapTextFaultModel(upstream, { mode, env, tokensPerChar, writeProof })
  return { model, upstream, proofs, writeProof, cancel, env }
}

describe('文本故障 doStream 包装', () => {
  it('流前实际注入后才记录证明且不调用上游', async () => {
    const f = fixture([], 'chat-before-stream')
    await expect(f.model.doStream({ prompt: [] })).rejects.toMatchObject({
      code: 'ACCEPTANCE_FAULT_INJECTED',
    })
    expect(f.upstream.doStreamCalls).toHaveLength(0)
    expect(f.proofs).toEqual([
      expect.objectContaining({
        phase: 'before-stream',
        injected: true,
        realProviderCalled: false,
        upstreamCalls: 0,
      }),
    ])
  })

  it('真实 delta 到 200 估算 token 后才中断；取消 reader 不标记业务 abort', async () => {
    const f = fixture(
      [delta('😀'.repeat(100)), delta('a'.repeat(300)), finish],
      'chat-mid-stream',
      0.5,
    )
    const controller = new AbortController()
    const { stream } = await f.model.doStream({ prompt: [], abortSignal: controller.signal })
    const reader = stream.getReader()
    expect((await reader.read()).value).toEqual(delta('😀'.repeat(100)))
    expect((await reader.read()).value).toEqual(delta('a'.repeat(300)))
    expect(f.proofs.some((p) => p.injected)).toBe(false)
    await expect(reader.read()).rejects.toMatchObject({ code: 'ACCEPTANCE_FAULT_INJECTED' })
    expect(f.upstream.doStreamCalls).toHaveLength(1)
    expect(f.cancel).toHaveBeenCalledTimes(1)
    expect(controller.signal.aborted).toBe(false)
    expect(f.proofs.at(-1)).toMatchObject({
      injected: true,
      phase: 'mid-stream',
      outputTokens: 200,
      realProviderCalled: true,
      upstreamCalls: 1,
    })
  })

  it.each(['short', 'natural-error'] as const)('上游 %s 不伪称注入成功', async (kind) => {
    const f = fixture([
      delta('short'),
      kind === 'short' ? finish : { type: 'error', error: new Error('upstream') },
    ])
    const { stream } = await f.model.doStream({ prompt: [] })
    const reader = stream.getReader()
    const seen: StreamPart[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      seen.push(next.value)
    }
    expect(seen).toHaveLength(2)
    expect(f.proofs.at(-1)).toMatchObject({
      injected: false,
      realProviderCalled: true,
      upstreamCalls: 1,
    })
    expect(f.proofs.some((p) => p.injected)).toBe(false)
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('证明写入失败仍取消流且不能留下成功注入证明', async () => {
    const f = fixture([delta('a'.repeat(200)), finish])
    f.writeProof.mockImplementation(async (proof) => {
      if (proof.injected) throw new Error('proof unavailable')
      f.proofs.push(proof)
      return true
    })
    const { stream } = await f.model.doStream({ prompt: [] })
    const reader = stream.getReader()
    expect((await reader.read()).value).toEqual(delta('a'.repeat(200)))
    await expect(reader.read()).rejects.toThrow('proof unavailable')
    expect(f.proofs.some((p) => p.injected)).toBe(false)
    expect(f.cancel).toHaveBeenCalledTimes(1)
  })

  it('消息已结束，证明未写入时不执行流前注入或调用上游', async () => {
    const f = fixture([], 'chat-before-stream')
    f.writeProof.mockResolvedValue(false)
    await expect(f.model.doStream({ prompt: [] })).rejects.toMatchObject({
      code: 'ACCEPTANCE_FAULT_PROOF_FAILED',
    })
    expect(f.proofs).toEqual([])
    expect(f.upstream.doStreamCalls).toHaveLength(0)
  })

  it('包装后关闭闸门，不调用上游也不注入', async () => {
    const f = fixture([delta('a'.repeat(200))])
    f.env.AI_FAULT_INJECTION = 'disabled'
    await expect(f.model.doStream({ prompt: [] })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    })
    expect(f.proofs).toEqual([])
    expect(f.upstream.doStreamCalls).toHaveLength(0)
  })

  it('首个证明写入期间关闭闸门，实际调用计数仍为零', async () => {
    const f = fixture([])
    f.writeProof.mockImplementation(async (proof) => {
      f.proofs.push(proof)
      f.env.AI_FAULT_INJECTION = 'disabled'
      return true
    })
    await expect(f.model.doStream({ prompt: [] })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    })
    expect(f.upstream.doStreamCalls).toHaveLength(0)
    expect(f.proofs.at(-1)).toMatchObject({
      injected: false,
      realProviderCalled: false,
      upstreamCalls: 0,
    })
  })

  it('上游 doStream 自然拒绝仍记录实际调用但不认证注入', async () => {
    const f = fixture([])
    f.upstream.doStream = vi.fn(async () => {
      throw new Error('provider rejected')
    })
    await expect(f.model.doStream({ prompt: [] })).rejects.toThrow('provider rejected')
    expect(f.upstream.doStream).toHaveBeenCalledTimes(1)
    expect(f.proofs.at(-1)).toMatchObject({
      injected: false,
      realProviderCalled: true,
      upstreamCalls: 1,
    })
  })

  it('已取得上游流后证明写入失败，立即取消该流', async () => {
    const f = fixture([delta('unread')])
    f.writeProof.mockImplementation(async (proof) => {
      if (proof.realProviderCalled) throw new Error('proof unavailable')
      f.proofs.push(proof)
      return true
    })
    await expect(f.model.doStream({ prompt: [] })).rejects.toThrow('proof unavailable')
    expect(f.cancel).toHaveBeenCalledTimes(1)
    expect(f.proofs.some((p) => p.injected)).toBe(false)
  })

  it('上游已发送 error chunk 后的文本不再触发注入', async () => {
    const f = fixture([
      { type: 'error', error: new Error('upstream') },
      delta('a'.repeat(200)),
      finish,
    ])
    const reader = (await f.model.doStream({ prompt: [] })).stream.getReader()
    while (!(await reader.read()).done) {}
    expect(f.proofs.some((p) => p.injected)).toBe(false)
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('旧 v3 模型经过 SDK 转换仍由同一包装器中断', async () => {
    const f = fixture([delta('a'.repeat(200))])
    const legacy = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta' as const, id: 't', delta: 'a'.repeat(200) })
          },
        }),
      }),
    })
    const model = wrapTextFaultModel(legacy, {
      mode: 'chat-mid-stream',
      env: enabled,
      tokensPerChar: 1,
      writeProof: f.writeProof,
    })
    const reader = (await model.doStream({ prompt: [] })).stream.getReader()
    expect((await reader.read()).value).toEqual(delta('a'.repeat(200)))
    await expect(reader.read()).rejects.toMatchObject({ code: 'ACCEPTANCE_FAULT_INJECTED' })
    expect(legacy.doStreamCalls).toHaveLength(1)
  })

  it('DeepSeek 故障调用关闭思考，其余调用参数保持', async () => {
    const f = fixture([finish])
    Object.defineProperty(f.upstream, 'provider', { value: 'deepseek.chat' })
    await f.model.doStream({
      prompt: [],
      maxOutputTokens: 1024,
      providerOptions: { deepseek: { userId: 'u' }, other: { keep: true } },
    })
    expect(f.upstream.doStreamCalls[0]).toMatchObject({
      maxOutputTokens: 1024,
      reasoning: 'none',
      providerOptions: {
        deepseek: { userId: 'u', thinking: { type: 'disabled' } },
        other: { keep: true },
      },
    })
  })

  it('未注册 Provider 的故障调用不添加 DeepSeek 参数', async () => {
    const f = fixture([finish])
    await f.model.doStream({ prompt: [], maxOutputTokens: 1024 })
    expect(f.upstream.doStreamCalls[0]).toEqual({ prompt: [], maxOutputTokens: 1024 })
  })

  describe('真实 DeepSeek Provider（假 fetch）', () => {
    const sse = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id: 'r', created: 1, model: 'deepseek-flash', choices: [{ index: 0, ...choice }], ...extra })}\n\n`
    function deepseek(events: string[]) {
      const bodies: Record<string, unknown>[] = []
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of [...events, 'data: [DONE]\n\n'])
                controller.enqueue(encoder.encode(event))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const upstream = createDeepSeek({ apiKey: 'test', fetch })('deepseek-flash')
      const proofs: TextFaultProof[] = []
      const model = wrapTextFaultModel(upstream, {
        mode: 'chat-mid-stream',
        env: enabled,
        tokensPerChar: 1,
        writeProof: async (proof) => {
          proofs.push(proof)
          return true
        },
      })
      return { model, bodies, proofs }
    }
    const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]

    it('请求体关闭 V4 默认思考，正文 delta 达阈值后注入', async () => {
      const f = deepseek([
        sse({ delta: { content: 'a'.repeat(150) } }),
        sse({ delta: { content: 'b'.repeat(150) } }),
        sse({ delta: {}, finish_reason: 'stop' }),
      ])
      const reader = (await f.model.doStream({ prompt, maxOutputTokens: 1024 })).stream.getReader()
      let error: unknown
      try {
        while (!(await reader.read()).done) {}
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'ACCEPTANCE_FAULT_INJECTED' })
      expect(f.bodies).toHaveLength(1)
      expect(f.bodies[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 1024 })
      expect(f.bodies[0]).not.toHaveProperty('reasoning_effort')
      expect(f.proofs.at(-1)).toMatchObject({ injected: true, outputTokens: 300 })
    })

    it('服务商仍只回 reasoning 时不计入阈值，也不伪称注入', async () => {
      const f = deepseek([
        sse({ delta: { reasoning_content: 'r'.repeat(1024) } }),
        sse(
          { delta: {}, finish_reason: 'length' },
          { usage: { prompt_tokens: 53, completion_tokens: 1024, total_tokens: 1077 } },
        ),
      ])
      const reader = (await f.model.doStream({ prompt })).stream.getReader()
      const types: string[] = []
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        types.push(next.value.type)
      }
      expect(types).toContain('reasoning-delta')
      expect(types).not.toContain('text-delta')
      expect(f.proofs.some((p) => p.injected)).toBe(false)
      expect(f.proofs.at(-1)).toMatchObject({ realProviderCalled: true, upstreamCalls: 1 })
    })
  })

  it('字符串模型不能回退默认真实 Provider', () => {
    expect(() =>
      wrapTextFaultModel('unknown-provider/model' as never, {
        mode: 'chat-before-stream',
        env: enabled,
        tokensPerChar: 1,
        writeProof: async () => true,
      }),
    ).toThrow('Acceptance text model is invalid')
  })
})
