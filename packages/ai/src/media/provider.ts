export interface MediaResult {
  outputs: {
    url: string
    mime: string
    width?: number
    height?: number
    durationSec?: number
  }[]
  /** 只报告服务商实际给出的用量；运行时间不能当作视频时长。 */
  usage?: { images?: number; seconds?: number }
}

export interface MediaError {
  code: string
  message: string
}

export type MediaStatus =
  | { status: 'queued' | 'running'; progress?: number }
  | { status: 'succeeded'; result: MediaResult }
  | { status: 'failed'; error: MediaError }

export type MediaWebhook = { jobId: string } & (
  | { result: MediaResult; error?: never }
  | { error: MediaError; result?: never }
  /** 部分服务商回调不含结果，调用方须查询原作业，不能重提。 */
  | { result?: never; error?: never }
)

export interface MediaSubmitInput {
  modelId: string
  params: Record<string, unknown>
  webhookUrl?: string
  /** ai_task.provider_request_key；不支持幂等提交的实现忽略此键。 */
  idempotencyKey: string
}

export interface MediaProvider {
  readonly id: string
  readonly capabilities: { readonly idempotentSubmit: boolean }
  submit(input: MediaSubmitInput): Promise<{ jobId: string; sync?: MediaResult }>
  getStatus(jobId: string): Promise<MediaStatus>
  /** 必须先校验服务商签名，再解析原始请求体；网络故障仍作为可重试错误抛出。 */
  parseWebhook(req: Request, rawBody: string): Promise<MediaWebhook>
  /** 仅表示取消请求已被接受；已运行的作业可能仍完成。 */
  cancel?(jobId: string): Promise<void>
}

export interface MediaBinaryOutput {
  body: ReadableStream<Uint8Array> | Uint8Array
  mime: string
  width?: number
  height?: number
  durationSec?: number
}

export interface MediaBinaryResult {
  outputs: MediaBinaryOutput[]
  usage?: MediaResult['usage']
}

/** 同步字节只能在同一 Workflow step 内转存，不能作为 step 返回值。 */
export interface SyncMediaProvider {
  readonly id: string
  readonly capabilities: { readonly synchronous: true; readonly idempotentSubmit: boolean }
  run(input: MediaSubmitInput): Promise<MediaBinaryResult>
}

export type TaskMediaProvider = MediaProvider | SyncMediaProvider

export function isSyncMediaProvider(provider: TaskMediaProvider): provider is SyncMediaProvider {
  return 'synchronous' in provider.capabilities && provider.capabilities.synchronous === true
}
