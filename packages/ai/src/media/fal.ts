import { AppError } from '@product-res/shared'
import { z } from 'zod'
import type { MediaProvider, MediaResult, MediaStatus } from './provider.ts'

const QUEUE_ORIGIN = 'https://queue.fal.run'
const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json'
const JWKS_TTL_MS = 24 * 60 * 60 * 1000
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const file = z.object({
  url: z.url({ protocol: /^https$/ }),
  content_type: z.string().min(1).nullish(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional(),
})
const output = z
  .object({
    images: z.array(file).min(1).optional(),
    video: file.optional(),
  })
  .refine((value) => Boolean(value.images) !== Boolean(value.video))
const statusSchema = z.object({
  request_id: id,
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
})
const webhookSchema = z.object({
  request_id: id,
  gateway_request_id: id.optional(),
  status: z.enum(['OK', 'ERROR']),
  payload: z.unknown().optional(),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
  payload_error: z.string().optional(),
})
const jwksSchema = z.object({
  keys: z.array(z.object({ x: z.string().regex(/^[a-zA-Z0-9_+/-]{43}=?$/) })).min(1),
})

export type FalSubmissionOutcome = 'ambiguous' | 'rejected'

/**
 * 不附带上游响应或网络错误，避免把请求参数与密钥泄露给客户端或日志。
 * causeName 只保留底层异常的类名（如 TypeError / TimeoutError），用于定位传输失败原因。
 */
export class FalProviderError extends AppError {
  readonly httpStatus: number | undefined
  readonly submissionOutcome: FalSubmissionOutcome | undefined
  readonly causeName: string | undefined

  constructor(
    code: string,
    message: string,
    httpStatus?: number,
    submissionOutcome?: FalSubmissionOutcome,
    causeName?: string,
  ) {
    super(code, message, { status: 502 })
    this.httpStatus = httpStatus
    this.submissionOutcome = submissionOutcome
    this.causeName = causeName
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

// workerd 不支持 redirect: 'error'（RequestInit 校验直接抛 TypeError，请求不会发出）；
// 改用 manual 并由 !response.ok 拒绝 3xx，效果同样是不跟随重定向。
const NO_REDIRECT = 'manual' as const

export interface FalMediaProviderOptions {
  apiKey: string
  /** 每个任务按其 modelId 重建实例，无需保留进程内 jobId → model 映射。 */
  modelId: string
  fetch: typeof fetch
  now?: () => number
}

function invalidResponse(submission?: FalSubmissionOutcome): never {
  throw new FalProviderError(
    'FAL_INVALID_RESPONSE',
    'Invalid fal.ai response',
    undefined,
    submission,
  )
}

function parse<T>(schema: z.ZodType<T>, value: unknown, submission?: FalSubmissionOutcome): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalidResponse(submission)
  return parsed.data
}

function mediaResult(value: unknown): MediaResult {
  const data = parse(output, value)
  const files = data.images ?? (data.video ? [data.video] : [])
  const outputs = files.map((item) => {
    // 类型缺失时只根据明确的文件扩展名推导，不能把未知格式伪装成 JPEG/MP4。
    const extension = new URL(item.url).pathname.split('.').pop()?.toLowerCase()
    const mime =
      item.content_type ??
      (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          mp4: 'video/mp4',
        } as Record<string, string>
      )[extension ?? '']
    if (!mime || !(data.images ? mime.startsWith('image/') : mime.startsWith('video/')))
      invalidResponse()
    return {
      url: item.url,
      mime,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
      ...(item.duration === undefined ? {} : { durationSec: item.duration }),
    }
  })
  return {
    outputs,
    ...(data.images
      ? { usage: { images: data.images.length } }
      : data.video?.duration === undefined
        ? {}
        : { usage: { seconds: data.video.duration } }),
  }
}

function invalidWebhook(): never {
  throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid fal.ai webhook', { status: 400 })
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 队列路径规则与 fal 官方 JS SDK 的 parseEndpointId / queue.status 保持一致。 */
export function createFalMediaProvider(options: FalMediaProviderOptions): MediaProvider {
  const parts = options.modelId.split('/')
  const baseLength = parts[0] === 'workflows' || parts[0] === 'comfy' ? 3 : 2
  if (
    parts.length < baseLength ||
    parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part))
  ) {
    throw new AppError('FAL_INVALID_MODEL', 'Expected a fal.ai model endpoint ID')
  }
  const baseModelId = parts.slice(0, baseLength).join('/')
  const now = options.now ?? Date.now
  // 不能以 options 为 this 调用：Workers 的全局 fetch 会抛 Illegal invocation，请求根本不会发出。
  const fetcher = options.fetch
  let cachedKeys: { keys: CryptoKey[]; expiresAt: number } | undefined

  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
  ): Promise<Response> {
    if (!options.apiKey)
      throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'fal.ai API key is not configured', {
        status: 503,
      })
    let response: Response
    try {
      response = await fetcher(url, {
        method,
        headers: { Authorization: `Key ${options.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new FalProviderError(
        'FAL_TRANSPORT_ERROR',
        'fal.ai request did not complete',
        undefined,
        method === 'POST' ? 'ambiguous' : undefined,
        errorName(error),
      )
    }
    if (!response.ok) {
      throw new FalProviderError(
        'FAL_HTTP_ERROR',
        `fal.ai HTTP request failed (${response.status})`,
        response.status,
        method === 'POST'
          ? response.status >= 500 || response.status === 408
            ? 'ambiguous'
            : 'rejected'
          : undefined,
      )
    }
    return response
  }

  async function json(response: Response, submission?: FalSubmissionOutcome): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      invalidResponse(submission)
    }
  }

  function jobPath(jobId: string): string {
    if (!id.safeParse(jobId).success) throw new AppError('FAL_INVALID_JOB', 'Invalid fal.ai job ID')
    return `${QUEUE_ORIGIN}/${baseModelId}/requests/${jobId}`
  }

  async function publicKeys(): Promise<CryptoKey[]> {
    if (cachedKeys && cachedKeys.expiresAt > now()) return cachedKeys.keys
    let response: Response
    try {
      // JWKS 请求不携带 API key；也不允许回调提供公钥地址。
      response = await fetcher(JWKS_URL, {
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new FalProviderError(
        'FAL_JWKS_UNAVAILABLE',
        'fal.ai webhook keys are unavailable',
        undefined,
        undefined,
        errorName(error),
      )
    }
    if (!response.ok)
      throw new FalProviderError(
        'FAL_JWKS_UNAVAILABLE',
        'fal.ai webhook keys are unavailable',
        response.status,
      )
    const { keys } = parse(jwksSchema, await json(response))
    const imported = await Promise.all(
      keys.map(async ({ x }) => {
        const bytes = Uint8Array.from(
          atob(`${x.replace(/=$/, '').replaceAll('-', '+').replaceAll('_', '/')}=`),
          (char) => char.charCodeAt(0),
        )
        return crypto.subtle.importKey('raw', bytes, 'Ed25519', false, ['verify'])
      }),
    )
    cachedKeys = { keys: imported, expiresAt: now() + JWKS_TTL_MS }
    return imported
  }

  return {
    id: 'fal',
    // 2026-10-12 实测同一 Idempotency-Key 与请求体仍生成两个作业；证据见夹具 README。
    capabilities: { idempotentSubmit: false },
    async submit(input) {
      if (input.modelId !== options.modelId)
        throw new AppError(
          'FAL_INVALID_MODEL',
          'Model does not match this fal.ai provider instance',
        )
      const url = new URL(`${QUEUE_ORIGIN}/${options.modelId}`)
      if (input.webhookUrl !== undefined) url.searchParams.set('fal_webhook', input.webhookUrl)
      const response = await request(url.toString(), 'POST', input.params)
      const result = parse(
        z.object({ request_id: id }),
        await json(response, 'ambiguous'),
        'ambiguous',
      )
      return { jobId: result.request_id }
    },
    async getStatus(jobId): Promise<MediaStatus> {
      const path = jobPath(jobId)
      const status = parse(statusSchema, await json(await request(`${path}/status`, 'GET')))
      if (status.request_id !== jobId) invalidResponse()
      if (status.status === 'IN_QUEUE') return { status: 'queued' }
      if (status.status === 'IN_PROGRESS') return { status: 'running' }
      if (status.error)
        return {
          status: 'failed',
          error: { code: status.error_type ?? 'FAL_GENERATION_FAILED', message: status.error },
        }
      return { status: 'succeeded', result: mediaResult(await json(await request(path, 'GET'))) }
    },
    async cancel(jobId) {
      await request(`${jobPath(jobId)}/cancel`, 'PUT')
    },
    async parseWebhook(req, rawBody) {
      const requestId = req.headers.get('x-fal-webhook-request-id')
      const userId = req.headers.get('x-fal-webhook-user-id')
      const timestamp = req.headers.get('x-fal-webhook-timestamp')
      const signature = req.headers.get('x-fal-webhook-signature')
      if (
        !requestId ||
        !userId ||
        !timestamp ||
        !signature ||
        !/^\d+$/.test(timestamp) ||
        !/^[a-fA-F0-9]{128}$/.test(signature) ||
        Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300
      )
        invalidWebhook()
      const encoder = new TextEncoder()
      const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(rawBody)))
      const message = encoder.encode([requestId, userId, timestamp, hash].join('\n'))
      const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) =>
        Number.parseInt(pair, 16),
      )
      let valid = false
      for (const key of await publicKeys()) {
        if (await crypto.subtle.verify('Ed25519', key, bytes, message)) {
          valid = true
          break
        }
      }
      if (!valid) invalidWebhook()
      let decoded: unknown
      try {
        decoded = JSON.parse(rawBody)
      } catch {
        invalidWebhook()
      }
      const parsed = webhookSchema.safeParse(decoded)
      if (!parsed.success) invalidWebhook()
      const payload = parsed.data
      // fal 的内部重试可能改变 gateway_request_id；jobId 始终取队列 request_id。
      if (requestId !== payload.request_id && requestId !== payload.gateway_request_id)
        invalidWebhook()
      if (payload.status === 'ERROR') {
        return {
          jobId: payload.request_id,
          error: {
            code: payload.error_type ?? 'FAL_GENERATION_FAILED',
            message: payload.error ?? 'fal.ai generation failed',
          },
        }
      }
      // 序列化失败的回调仍经验签，交给调用方轮询，不把缺失结果当作生成失败。
      if (payload.payload_error && payload.payload == null) return { jobId: payload.request_id }
      return { jobId: payload.request_id, result: mediaResult(payload.payload) }
    },
  }
}
