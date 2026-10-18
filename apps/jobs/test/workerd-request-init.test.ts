import { createFalMediaProvider, FalProviderError } from '@product-res/ai'
import { createCloudflareMediaCopier } from '@product-res/storage/cloudflare'
import { afterEach, expect, it, vi } from 'vitest'
import { sendOperationsChannel } from '../src/notifications/operations.ts'

// 普通 mock fetch 不会执行 workerd 的 RequestInit 校验；这里先用真实 Request 构造一次，
// 让运行时拒绝的选项（如 redirect: 'error'）在测试中同样失败。
function validatingFetch(respond: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    new Request(input, init)
    return respond()
  }) as unknown as typeof fetch
}

afterEach(() => vi.restoreAllMocks())

it('workerd 拒绝 redirect: error，外部请求必须改用 manual', () => {
  expect(() => new Request('https://queue.fal.run/x', { redirect: 'error' })).toThrow(TypeError)
  expect(() => new Request('https://queue.fal.run/x', { redirect: 'manual' })).not.toThrow()
})

it('fal 提交与状态查询的 RequestInit 可在 workerd 中发出，3xx 视为明确拒绝', async () => {
  const modelId = 'fal-ai/flux/schnell'
  const fetch = validatingFetch(() => Response.json({ request_id: 'req-1', status: 'IN_QUEUE' }))
  const provider = createFalMediaProvider({ apiKey: 'test-placeholder', modelId, fetch })
  const input = { modelId, params: { prompt: 'a red square' }, idempotencyKey: 'task-1' }
  await expect(
    provider.submit({ ...input, webhookUrl: 'https://product.ezarouter.cc/hook?task=t&sig=s' }),
  ).resolves.toEqual({ jobId: 'req-1' })
  await expect(provider.getStatus('req-1')).resolves.toEqual({ status: 'queued' })

  const redirected = createFalMediaProvider({
    apiKey: 'test-placeholder',
    modelId,
    fetch: validatingFetch(
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }),
    ),
  })
  const error = await redirected.submit(input).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(FalProviderError)
  expect(error).toMatchObject({
    code: 'FAL_HTTP_ERROR',
    httpStatus: 302,
    submissionOutcome: 'rejected',
  })
})

it('fal 传输失败保留底层异常类名，供 submit_uncertain 日志定位', async () => {
  const provider = createFalMediaProvider({
    apiKey: 'test-placeholder',
    modelId: 'fal-ai/flux/schnell',
    fetch: vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch,
  })
  await expect(
    provider.submit({ modelId: 'fal-ai/flux/schnell', params: {}, idempotencyKey: 'task-1' }),
  ).rejects.toMatchObject({
    code: 'FAL_TRANSPORT_ERROR',
    submissionOutcome: 'ambiguous',
    causeName: 'TypeError',
  })
})

it('Cloudflare 媒体转存与运维通知的 RequestInit 可在 workerd 中发出', async () => {
  const put = vi.fn(async (_key: string, body: ReadableStream) => {
    await new Response(body).arrayBuffer()
    return null
  })
  const copy = createCloudflareMediaCopier(
    { put, createMultipartUpload: vi.fn() } as unknown as Pick<
      R2Bucket,
      'put' | 'createMultipartUpload'
    >,
    {
      fetch: validatingFetch(
        () =>
          new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }),
      ),
    },
  )
  await expect(
    copy(
      'k',
      { url: 'https://v3.fal.media/files/a.png', mime: 'image/png' },
      {
        maxFileBytes: 10,
        storageBytes: 10,
        allowedHosts: ['v3.fal.media'],
        allowedMimeTypes: ['image/png'],
      },
    ),
  ).resolves.toEqual({ mime: 'image/png', size: 3 })

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    validatingFetch(() => new Response(null, { status: 204 })),
  )
  await expect(
    sendOperationsChannel(
      'discord',
      {
        telegramBotToken: '',
        telegramChatId: '',
        discordWebhookUrl: 'https://discord.com/api/webhooks/1/test-placeholder',
      },
      { event: 'webhook.failed', sourceId: 'delivery-1' },
    ),
  ).resolves.toBeUndefined()
})
