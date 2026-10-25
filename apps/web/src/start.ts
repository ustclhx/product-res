import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { transferErrorAdapter } from './features/transfer/error-adapter.ts'
import { workspaceTransferErrorAdapter } from './features/workbench/transfer-error.ts'

const sentryErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    return await next()
  } catch (error) {
    const { captureServerError } = await import('./server/sentry.ts')
    captureServerError(error)
    throw error
  }
})

const sentryRequests = createMiddleware().server(async ({ next }) => {
  try {
    return await next()
  } catch (error) {
    const { captureServerError } = await import('./server/sentry.ts')
    captureServerError(error)
    throw error
  }
})

export const startInstance = createStart(() => ({
  // 提供自定义 Start 配置后框架不再补默认 CSRF，保留原有 server function 同源保护。
  requestMiddleware: [
    createCsrfMiddleware({ filter: (context) => context.handlerType === 'serverFn' }),
    sentryRequests,
  ],
  functionMiddleware: [sentryErrors],
  serializationAdapters: [workspaceTransferErrorAdapter, transferErrorAdapter],
}))
