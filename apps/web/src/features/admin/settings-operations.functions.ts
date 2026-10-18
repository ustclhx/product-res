import { createServerFn } from '@tanstack/react-start'
import { adminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import {
  operationsSettingsInput,
  readOperationsSettings,
  writeOperationsSettings,
} from './settings-operations.ts'

export const getOperationsSettings = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context }) => readOperationsSettings(context.db))

export const saveOperationsSettings = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(operationsSettingsInput)
  .handler(
    adminAction('setting.operations.update', async ({ data, ...scope }) => {
      await writeOperationsSettings(scope, data)
      // 密钥只从数据库读取，不缓存、不回显；提交后立即生效。
      return { ok: true }
    }),
  )
