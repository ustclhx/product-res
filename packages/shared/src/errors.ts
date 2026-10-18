/**
 * 业务错误：带稳定的 `code`，API 统一返回 `{ error: { code, message } }`，前端按 code 做 i18n。
 * 非 AppError 的异常一律视为内部错误，不把原始信息暴露给客户端。
 */
export class AppError extends Error {
  override readonly name = 'AppError'
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: string,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status ?? 400
    this.details = options.details
  }

  toJSON(): ErrorBody {
    return { error: { code: this.code, message: this.message } }
  }
}

export type ErrorBody = { error: { code: string; message: string } }

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR'

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** 把任意异常转换成可返回给客户端的错误体与状态码。 */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (isAppError(error)) {
    return { status: error.status, body: error.toJSON() }
  }
  return {
    status: 500,
    body: { error: { code: INTERNAL_ERROR_CODE, message: 'Internal error' } },
  }
}
