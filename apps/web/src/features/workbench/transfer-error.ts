import { AppError } from '@product-res/shared'
import { createSerializationAdapter } from '@tanstack/react-router'

/** 默认 RPC 只保留 Error.message；流转写锁需要把稳定错误码带到前端选择文案。 */
export const workspaceTransferErrorAdapter = createSerializationAdapter({
  key: 'product-res/workspace-transfer-error',
  test: (value): value is AppError =>
    value instanceof AppError && value.code === 'WORKSPACE_TRANSFERRING',
  toSerializable: (error) => ({ message: error.message }),
  fromSerializable: ({ message }) =>
    new AppError('WORKSPACE_TRANSFERRING', message, { status: 403 }),
})
