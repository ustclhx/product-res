/**
 * 业务错误：带稳定的 `code`，API 返回 `{ error: { code, message, details? } }`，前端按 code 做 i18n。
 * `expose: false` 的 AppError 与未知异常隐藏原始信息；其余 AppError（含有意公开的 503 等）保留 code。
 */
export class AppError extends Error {
  override readonly name: string = 'AppError'
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  readonly publicDetails: Record<string, unknown> | undefined
  /** 是否向客户端公开 code/message；内部错误设为 false，统一返回 INTERNAL_ERROR。 */
  readonly expose: boolean

  constructor(
    code: string,
    message: string,
    options: {
      status?: number
      details?: Record<string, unknown>
      publicDetails?: Record<string, unknown>
      expose?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status ?? 400
    this.details = options.details
    this.publicDetails = options.publicDetails
    this.expose = options.expose ?? true
  }

  toJSON(): ErrorBody {
    const details = this.publicDetails
    return { error: { code: this.code, message: this.message, ...(details ? { details } : {}) } }
  }
}

export const INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS'

export interface InsufficientCreditsDetails {
  estimatedCredits: number
  availableCredits: number
}

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

function creditDetails(value: unknown): InsufficientCreditsDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { estimatedCredits, availableCredits } = value as Record<string, unknown>
  if (
    typeof estimatedCredits !== 'number' ||
    !Number.isSafeInteger(estimatedCredits) ||
    estimatedCredits < 0 ||
    typeof availableCredits !== 'number' ||
    !Number.isSafeInteger(availableCredits) ||
    availableCredits < 0
  )
    return undefined
  // 显式复制白名单，调用方附加的内部字段不会外发。
  return { estimatedCredits, availableCredits }
}

export function insufficientCreditsError(
  estimatedCredits: number,
  availableCredits: number,
): AppError {
  const details = creditDetails({ estimatedCredits, availableCredits })
  return new AppError(INSUFFICIENT_CREDITS, 'Insufficient credits', {
    status: 402,
    details: { estimatedCredits, availableCredits },
    ...(details ? { publicDetails: { ...details } } : {}),
  })
}

/** 纯客户端解析：HTTP 错误体 / AppError，以及聊天 SDK 包在 Error.message 中的 JSON。 */
export function parseInsufficientCredits(value: unknown): InsufficientCreditsDetails | undefined {
  if (value instanceof Error) {
    if (value instanceof AppError) return parseInsufficientCredits(value.toJSON())
    if ('code' in value && value.code === INSUFFICIENT_CREDITS && 'details' in value)
      return creditDetails(value.details)
    value = value.message
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const error = 'error' in value ? value.error : value
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== INSUFFICIENT_CREDITS
  )
    return undefined
  return 'details' in error ? creditDetails(error.details) : undefined
}

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR'

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** 把任意异常转换成可返回给客户端的错误体与状态码。 */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (isAppError(error) && error.expose) {
    return { status: error.status, body: error.toJSON() }
  }
  return {
    status: isAppError(error) ? error.status : 500,
    body: { error: { code: INTERNAL_ERROR_CODE, message: 'Internal error' } },
  }
}
