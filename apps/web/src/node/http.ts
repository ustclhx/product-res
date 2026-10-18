import type { NodeEnv } from '@product-res/config/node'
import { createNodeRequestMetadata, withNodeRequestContext } from '@product-res/platform/node'
import { log } from '@product-res/shared/log'
import { useNitroApp as getNitroApp, useNitroHooks as getNitroHooks } from 'nitro/app'
import type { ServerRequest } from 'srvx'
import { serve } from 'srvx/node'
import { captureNodeError, type NodeWebObserver } from './observer-context.ts'
import { attachWebRuntime } from './request-runtime.ts'
import { createNodeWebProcess, prerenderRuntime } from './runtime.ts'

const nitroApp = getNitroApp()
const previewMetadata = createNodeRequestMetadata([])
let resources: Awaited<ReturnType<typeof createNodeWebProcess>> | undefined
let stopping = false
let observer: NodeWebObserver | undefined

/** Nitro preview 导入同一 fetch，但不会执行下面的生产 listen 分支。 */
export async function fetch(request: ServerRequest): Promise<Response> {
  if (stopping) return new Response('Service Unavailable', { status: 503 })
  // server map 始终保存在 server 输出，静态路由也明确拒绝所有 map 请求。
  if (new URL(request.url).pathname.endsWith('.map'))
    return new Response('Not Found', { status: 404 })
  const meta = (resources?.metadata ?? previewMetadata)(
    request,
    request.runtime?.node?.req.socket.remoteAddress,
  )
  const release = resources?.background.beginRequest()
  let handlerDone = false
  let outputDone = !request.runtime?.node?.res
  const finished = () => {
    outputDone = true
    if (handlerDone) release?.()
  }
  request.runtime?.node?.res?.once('finish', finished)
  request.runtime?.node?.res?.once('close', finished)
  try {
    return await withNodeRequestContext(meta, () =>
      (observer?.run ?? ((handle) => handle()))(async () => {
        if (new URL(request.url).pathname === '/internal/live')
          return Response.json(
            { status: 'ok', version: __APP_VERSION__ },
            { headers: { 'cache-control': 'no-store' } },
          )
        // srvx 的惰性 Request 继承原生 prototype，却没有 Undici 的内部槽。
        // SSR bundle 中的 new Request(input) 会把它误认作原生实例；在跨 bundle
        // 边界按标准字段创建一次原生请求，保留流式 body 与取消信号而不克隆包装对象。
        const init: RequestInit & { duplex?: 'half' } = {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          body: request.body,
          duplex: 'half',
        }
        const nativeRequest = new Request(request.url, init)
        attachWebRuntime(nativeRequest, resources?.requestRuntime(meta) ?? prerenderRuntime(meta))
        try {
          return await nitroApp.fetch(nativeRequest)
        } catch (error) {
          if (observer) captureNodeError(observer, error, { requestId: meta.requestId })
          throw error
        }
      }),
    )
  } finally {
    handlerDone = true
    if (outputDone) release?.()
  }
}

// 仅由早期 bootstrap 在初始化观测后调用；preview 导入只有 fetch，无资源副作用。
export async function startNodeWeb(config: NodeEnv, processObserver: NodeWebObserver) {
  observer = processObserver
  try {
    const port = Number(process.env.NITRO_PORT ?? process.env.PORT ?? 3000)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
    resources = await createNodeWebProcess(config, processObserver)
    const processResources = resources
    const server = serve({
      port,
      hostname: process.env.NITRO_HOST ?? process.env.HOST ?? '0.0.0.0',
      fetch,
      gracefulShutdown: false,
      manual: true,
      silent: true,
    })
    await server.serve()
    log.info('node.web.started')
    const http = server.node?.server
    let shutdown: Promise<void> | undefined
    const stop = () => {
      if (shutdown) return
      shutdown = (async () => {
        const deadline = Date.now() + processResources.env.SHUTDOWN_TIMEOUT_MS
        const result = await processResources.background.shutdown({
          timeoutMs: processResources.env.SHUTDOWN_TIMEOUT_MS,
          stopReceiving: () => {
            stopping = true
            http?.close()
            if (http && 'closeIdleConnections' in http) http.closeIdleConnections()
          },
          closeResources: async () => {
            await processResources.close()
            await getNitroHooks().callHook('close')
          },
        })
        // 监控不属于业务资源成功与否；只能花 A 已关闭业务资源后的剩余预算。
        const remaining = Math.max(0, deadline - Date.now())
        if (remaining > 0 && processObserver.client) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              processObserver.client.close(remaining),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, remaining)
              }),
            ])
          } catch {
            log.warn('node.observability.close_failed')
          } finally {
            clearTimeout(timer)
          }
        }
        if (http && 'closeAllConnections' in http) http.closeAllConnections()
        log.info('node.web.stopped', { ...result })
        process.exit(result.completed && result.resourcesClosed ? 0 : 1)
      })()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (error) {
    // 启动错误仅允许配置校验的字段名；驱动、路径或连接串不能出现在日志。
    const { EnvValidationError } = await import('@product-res/config')
    log.error(
      'node.web.start_failed',
      error instanceof EnvValidationError ? { fields: [...error.missing, ...error.invalid] } : {},
    )
    await resources?.close()
    process.exit(1)
  }
}
