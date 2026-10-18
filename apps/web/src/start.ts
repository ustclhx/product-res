import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'

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
}))
