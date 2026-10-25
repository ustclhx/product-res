import { AppError } from '@product-res/shared'
import { createSerializationAdapter } from '@tanstack/react-router'

/** 流转入口的稳定错误码：发起、取消、续跑失败时前端按码选择 zh / en 文案（labels.ts） */
const CODES = new Set(['INVALID_WORKSPACE_SLUG', 'SLUG_TAKEN', 'WORKSPACE_LIMIT'])
export const isTransferErrorCode = (code: string) =>
  code.startsWith('TRANSFER_') || CODES.has(code) || code === 'CAPABILITY_UNAVAILABLE'

/**
 * 默认 RPC 只保留 Error.message（与 workbench/transfer-error.ts 相同的原因）。
 * 只带码、消息与状态，不序列化 details（可能含内部 id）。
 */
export const transferErrorAdapter = createSerializationAdapter({
  key: 'product-res/transfer-error',
  test: (value): value is AppError => value instanceof AppError && isTransferErrorCode(value.code),
  toSerializable: (error) => ({ code: error.code, message: error.message, status: error.status }),
  fromSerializable: ({ code, message, status }) => new AppError(code, message, { status }),
})
