/**
 * 连接器错误分类：决定队列是否重试、是否停止该数据源当日任务。
 * - retryable：网络、超时、5xx、限流，按队列策略重试
 * - permanent：请求本身无效（4xx），不重试
 * - quota：外部额度耗尽，停止该数据源当日任务
 * - auth：凭据失效或权限不足，停止当日任务并标记核验失败
 * - invalid-response：响应无法解析，不重试并记录
 */
export type ConnectorErrorKind = 'retryable' | 'permanent' | 'quota' | 'auth' | 'invalid-response'

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind
  readonly status: number | undefined
  /** 机器可读代码，不含凭据或响应正文 */
  readonly code: string

  constructor(
    kind: ConnectorErrorKind,
    code: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ConnectorError'
    this.kind = kind
    this.code = code
    this.status = options.status
  }

  /** 凭据失效与额度耗尽都应停止该数据源当日剩余任务 */
  get stopsSource() {
    return this.kind === 'auth' || this.kind === 'quota'
  }

  get retryable() {
    return this.kind === 'retryable'
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError
}

/** 按 HTTP 状态分类；429 默认按限流重试，连接器可按响应体改判为 quota */
export function classifyStatus(status: number): ConnectorErrorKind | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable'
  return 'permanent'
}
