import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createFalMediaProvider, FalProviderError } from './fal.ts'
import fixtures from './fixtures/fal.documented.json'
import recordedJwks from './fixtures/fal.jwks.recorded.json'
import recorded from './fixtures/fal.recorded.json'

const modelId = 'fal-ai/flux/schnell'
const jobId = fixtures.submit.request_id
const recordedJobId = recorded.imageSubmit.body.request_id
const now = 1_800_000_000_000
const input = { modelId, params: { prompt: 'a red square' }, idempotencyKey: 'task-fixture' }
const imageResult = {
  outputs: [
    { url: recorded.imageResult.body.images[0]?.url, mime: 'image/png', width: 512, height: 512 },
  ],
  usage: { images: 1 },
}
function response(body: unknown, status = 200) {
  return Response.json(body, { status })
}
function setup(bodies: unknown[], model = modelId, statuses: number[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const [index, body] of bodies.entries())
    fetch.mockResolvedValueOnce(response(body, statuses[index] ?? 200))
  return {
    fetch,
    provider: createFalMediaProvider({
      apiKey: 'test-placeholder',
      modelId: model,
      fetch,
      now: () => now,
    }),
  }
}

describe('fal queue（真实录制与未录制分支的文档补充）', () => {
  it('提交传递参数和完整 webhook URL，只返回持久 request_id，不声称幂等', async () => {
    const { provider, fetch } = setup([recorded.imageSubmit.body], modelId, [
      recorded.imageSubmit.httpStatus,
    ])
    const webhookUrl = 'https://product.ezarouter.cc/webhook?task=task-fixture&sig=test-placeholder'
    expect(await provider.submit({ ...input, webhookUrl })).toEqual({ jobId: recordedJobId })
    expect(provider.capabilities.idempotentSubmit).toBe(false)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(new URL(String(url)).searchParams.get('fal_webhook')).toBe(webhookUrl)
    expect(new URL(String(url)).pathname).toBe('/fal-ai/flux/schnell')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify(input.params),
      redirect: 'manual',
    })
    expect(new Headers(init?.headers).get('authorization')).toBe('Key test-placeholder')
    expect(new Headers(init?.headers).has('idempotency-key')).toBe(false)
  })

  it('注入的 fetch 不以 options 为 this 调用（Workers 全局 fetch 会抛 Illegal invocation）', async () => {
    const receivers: unknown[] = []
    const fetch = function (this: unknown) {
      receivers.push(this)
      // 模拟 workerd：this 不是全局对象或 undefined 时直接抛错，请求不会发出。
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(response(recorded.imageSubmit.body))
    } as typeof globalThis.fetch
    const provider = createFalMediaProvider({ apiKey: 'test-placeholder', modelId, fetch })
    expect(await provider.submit(input)).toEqual({ jobId: recordedJobId })
    expect(receivers).toHaveLength(1)
  })

  it('新实例用录制的 202 运行状态与 200 图片结果，使用去掉子路径的队列端点', async () => {
    const entries = [recorded.imageInitialStatus, recorded.imageStatus, recorded.imageResult]
    const { provider, fetch } = setup(
      entries.map((entry) => entry.body),
      modelId,
      entries.map((entry) => entry.httpStatus),
    )
    expect(await provider.getStatus(recordedJobId)).toEqual({ status: 'running' })
    expect(await provider.getStatus(recordedJobId)).toEqual({
      status: 'succeeded',
      result: imageResult,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(recorded.imageSubmit.body.status_url)
    expect(fetch.mock.calls[2]?.[0]).toBe(recorded.imageSubmit.body.response_url)
  })

  it('排队查询按文档形状归一化（本次查询未捕获 IN_QUEUE）', async () => {
    const { provider } = setup([fixtures.queued], modelId, [202])
    expect(await provider.getStatus(jobId)).toEqual({ status: 'queued' })
  })

  it('视频结果不把模型运行时间当作生成用量', async () => {
    const { provider } = setup(
      [fixtures.completed, fixtures.video],
      'fal-ai/wan/v2.2-a14b/text-to-video/turbo',
    )
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'succeeded',
      result: { outputs: [{ url: fixtures.video.video.url, mime: 'video/mp4' }] },
    })
  })

  it('COMPLETED 的生成错误是失败而不是成功，也不请求结果', async () => {
    const { provider, fetch } = setup([fixtures.failed])
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'failed',
      error: { code: 'internal_server_error', message: 'Generation failed' },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('视频取消以 PUT 发送，接受录制的 202；图片已完成的录制 400 传播给调用方', async () => {
    const { provider, fetch } = setup([recorded.videoCancel.body], recorded.metadata.videoModel, [
      recorded.videoCancel.httpStatus,
    ])
    await provider.cancel?.(recorded.videoSubmit.body.request_id)
    expect(fetch.mock.calls[0]).toEqual([
      recorded.videoSubmit.body.cancel_url,
      expect.objectContaining({ method: 'PUT' }),
    ])
    const completed = setup([recorded.cancelCompleted.body], modelId, [
      recorded.cancelCompleted.httpStatus,
    ])
    await expect(completed.provider.cancel?.(recordedJobId)).rejects.toMatchObject({
      httpStatus: recorded.cancelCompleted.httpStatus,
    })
  })

  it.each([503, 408, 429])('HTTP %i 提交不自动重试并保留是否可能已受理', async (status) => {
    const { provider, fetch } = setup([])
    fetch.mockResolvedValueOnce(response({ error: 'sensitive body' }, status))
    await expect(provider.submit(input)).rejects.toMatchObject({
      httpStatus: status,
      submissionOutcome: status === 429 ? 'rejected' : 'ambiguous',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('响应丢失只提交一次，错误不包含上游输入或密钥', async () => {
    const { provider, fetch } = setup([])
    fetch.mockRejectedValueOnce(new Error('sensitive upstream input'))
    const error = await provider.submit(input).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(FalProviderError)
    expect(error).toMatchObject({ submissionOutcome: 'ambiguous' })
    expect(JSON.stringify(error)).not.toContain('sensitive')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('无效提交响应仍可能已受理，无效结果和作业 ID 被拒绝', async () => {
    const { provider } = setup([{}, fixtures.completed, { images: [] }])
    await expect(provider.submit(input)).rejects.toMatchObject({ submissionOutcome: 'ambiguous' })
    await expect(provider.getStatus(jobId)).rejects.toMatchObject({ code: 'FAL_INVALID_RESPONSE' })
    await expect(provider.getStatus('../other')).rejects.toMatchObject({ code: 'FAL_INVALID_JOB' })
    await expect(provider.submit({ ...input, modelId: 'fal-ai/other' })).rejects.toMatchObject({
      code: 'FAL_INVALID_MODEL',
    })
  })
})

describe('fal webhook Ed25519 协议（本地临时签名）', () => {
  let pair: CryptoKeyPair
  let jwks: { keys: { x: string }[] }
  beforeAll(async () => {
    pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const key = await crypto.subtle.exportKey('jwk', pair.publicKey)
    // 公开 JWKS 实测返回带填充的编码；本地 JWK 导出不带填充。
    jwks = { keys: [{ x: `${key.x ?? ''}=` }] }
  })

  async function signed(payload: unknown, requestId = jobId, timestamp = String(now / 1000)) {
    const body = JSON.stringify(payload)
    const encoder = new TextEncoder()
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('')
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      encoder.encode([requestId, 'user-fixture', timestamp, hash].join('\n')),
    )
    const req = new Request('https://product.ezarouter.cc/webhook', {
      method: 'POST',
      headers: {
        'x-fal-webhook-request-id': requestId,
        'x-fal-webhook-user-id': 'user-fixture',
        'x-fal-webhook-timestamp': timestamp,
        'x-fal-webhook-signature': Array.from(new Uint8Array(signature), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join(''),
      },
    })
    return { req, body }
  }

  it('脱敏后的真实成功回调重新签名后归一化，接受上游 error=null', async () => {
    const { provider } = setup([jwks])
    const { req, body } = await signed(recorded.imageWebhook.body, recordedJobId)
    expect(await provider.parseWebhook(req, body)).toEqual({
      jobId: recordedJobId,
      result: imageResult,
    })
  })

  it('成功与失败验签后归一化，内部重试保留队列 request_id，并缓存公钥', async () => {
    const { provider, fetch } = setup([jwks])
    const success = await signed({
      request_id: jobId,
      status: 'OK',
      payload: { ...recorded.imageResult.body, prompt: '红色方块' },
    })
    expect(await provider.parseWebhook(success.req, success.body)).toEqual({
      jobId,
      result: imageResult,
    })
    const failure = await signed(fixtures.webhookError, 'attempt-fixture')
    expect(await provider.parseWebhook(failure.req, failure.body)).toEqual({
      jobId,
      error: { code: 'FAL_GENERATION_FAILED', message: fixtures.webhookError.error },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toEqual([
      'https://rest.fal.ai/.well-known/jwks.json',
      expect.objectContaining({ redirect: 'manual' }),
    ])
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('payload_error 返回需轮询的已验签通知', async () => {
    const { provider } = setup([jwks])
    const { req, body } = await signed(fixtures.webhookPayloadError)
    expect(await provider.parseWebhook(req, body)).toEqual({ jobId })
  })

  it.each([
    'tampered-body',
    'missing-header',
    'bad-hex',
    'expired',
    'future',
    'invalid-timestamp',
    'wrong-id',
    'wrong-key',
  ])('拒绝 %s 回调', async (kind) => {
    const { provider } = setup([kind === 'wrong-key' ? recordedJwks : jwks])
    const { req, body } = await signed({
      request_id: kind === 'wrong-id' ? 'other-job' : jobId,
      status: 'OK',
      payload: fixtures.image,
    })
    if (kind === 'missing-header') req.headers.delete('x-fal-webhook-user-id')
    if (kind === 'bad-hex') req.headers.set('x-fal-webhook-signature', 'zz')
    if (kind === 'expired') req.headers.set('x-fal-webhook-timestamp', String(now / 1000 - 301))
    if (kind === 'future') req.headers.set('x-fal-webhook-timestamp', String(now / 1000 + 301))
    if (kind === 'invalid-timestamp') req.headers.set('x-fal-webhook-timestamp', 'NaN')
    await expect(
      provider.parseWebhook(req, kind === 'tampered-body' ? `${body} ` : body),
    ).rejects.toMatchObject({ code: 'MEDIA_WEBHOOK_INVALID', status: 400 })
  })

  it('公钥服务故障保持可重试错误，24 小时后刷新公钥', async () => {
    let time = now
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(jwks))
      .mockResolvedValueOnce(response(jwks))
    const provider = createFalMediaProvider({
      apiKey: 'test-placeholder',
      modelId,
      fetch,
      now: () => time,
    })
    const first = await signed({ request_id: jobId, status: 'OK', payload: fixtures.image })
    await expect(provider.parseWebhook(first.req, first.body)).rejects.toMatchObject({
      code: 'FAL_JWKS_UNAVAILABLE',
      status: 502,
    })
    await provider.parseWebhook(first.req, first.body)
    time += 24 * 60 * 60 * 1000
    const later = await signed(
      { request_id: jobId, status: 'OK', payload: fixtures.image },
      jobId,
      String(time / 1000),
    )
    await provider.parseWebhook(later.req, later.body)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
