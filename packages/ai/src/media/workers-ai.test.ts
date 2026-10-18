import { describe, expect, it, vi } from 'vitest'
import { createWorkersAiMediaProvider, WORKERS_AI_IMAGE_MODEL } from './workers-ai.ts'

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5])
const input = {
  modelId: WORKERS_AI_IMAGE_MODEL,
  params: { prompt: 'fixture' },
  idempotencyKey: 'task',
}

describe('Workers AI 图片 Provider', () => {
  it('将 Flux 官方 base64 结果解码为 JPEG 并报告一张图片用量', async () => {
    const binding = { run: vi.fn(async () => ({ image: btoa(String.fromCharCode(...jpeg)) })) }
    const provider = createWorkersAiMediaProvider({ binding, modelId: input.modelId })
    const result = await provider.run(input)
    expect(binding.run).toHaveBeenCalledWith(input.modelId, input.params)
    expect(result).toEqual({ outputs: [{ body: jpeg, mime: 'image/jpeg' }], usage: { images: 1 } })
  })

  it('辨识跨 chunk 的二进制流文件头并保留全部图片字节', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 3))
        controller.enqueue(png.subarray(3))
        controller.close()
      },
    })
    const provider = createWorkersAiMediaProvider({
      binding: { run: async () => stream },
      modelId: input.modelId,
    })
    const result = await provider.run(input)
    expect(result.outputs[0]?.mime).toBe('image/png')
    const body = result.outputs[0]?.body
    if (!(body instanceof ReadableStream)) throw new Error('Expected binary output stream')
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(png)
    expect(result.usage).toEqual({ images: 1 })
  })

  it('拒绝非图片 / 非法 base64，绑定失败不泄露上游错误', async () => {
    for (const image of ['invalid base64!', btoa('upstream returned HTML')]) {
      const provider = createWorkersAiMediaProvider({
        binding: { run: async () => ({ image }) },
        modelId: input.modelId,
      })
      await expect(provider.run(input)).rejects.toMatchObject({
        code: 'WORKERS_AI_INVALID_RESPONSE',
      })
    }
    const failed = createWorkersAiMediaProvider({
      binding: {
        run: async () => {
          throw new Error('private upstream detail')
        },
      },
      modelId: input.modelId,
    })
    await expect(failed.run(input)).rejects.toMatchObject({
      code: 'WORKERS_AI_GENERATION_FAILED',
      message: 'Workers AI image generation failed (Error)',
      details: { upstreamName: 'Error', upstreamCode: null, retryable: false },
    })
  })

  it('按 workerd 绑定错误格式保留错误名与数字码，只把超时 / 容量不足标为可重试', async () => {
    // workerd 的 AI.run 以 `${internalCode}: ${description}` 抛出 InferenceUpstreamError。
    const upstream = (message: string, name = 'InferenceUpstreamError') =>
      Object.assign(new Error(message), { name })
    const cases = [
      [upstream('3040: Capacity temporarily exceeded, please try again.'), 3040, true],
      [upstream('3007: Request timeout'), 3007, true],
      [
        upstream('8007: Input prompt contains NSFW content. fixture prompt', 'AiError'),
        8007,
        false,
      ],
      [upstream('5006: Error: required properties at fixture prompt'), 5006, false],
    ] as const
    for (const [error, upstreamCode, retryable] of cases) {
      const provider = createWorkersAiMediaProvider({
        binding: {
          run: async () => {
            throw error
          },
        },
        modelId: input.modelId,
      })
      const failure = await provider.run(input).catch((caught: unknown) => caught)
      expect(failure).toMatchObject({
        code: 'WORKERS_AI_GENERATION_FAILED',
        message: `Workers AI image generation failed (${error.name} ${upstreamCode})`,
        details: { upstreamName: error.name, upstreamCode, retryable },
      })
      expect(
        JSON.stringify({ ...(failure as object), message: (failure as Error).message }),
      ).not.toContain('fixture prompt')
    }
  })
})
