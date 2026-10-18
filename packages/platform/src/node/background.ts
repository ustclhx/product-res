import { getLogContext, log, withLogContext } from '@product-res/shared/log'
import type { BackgroundTasks } from '../index.ts'

export interface DrainResult {
  readonly completed: boolean
  readonly pendingTasks: number
  readonly activeRequests: number
}

/** 普通运行没有任务时限；只有显式 shutdown/drain 才启动停机 deadline。 */
export function createNodeBackgroundTasks() {
  const tasks = new Set<Promise<void>>()
  let activeRequests = 0
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const background: BackgroundTasks = {
    waitUntil(promise) {
      const context = getLogContext()
      const tracked = promise
        .then(undefined, () => {
          // 任意 rejection 都可能携带密钥或用户正文，不输出 message/stack/reason。
          withLogContext(context, () => log.error('platform.background.failed'))
        })
        .then(() => {
          tasks.delete(tracked)
          notify()
        })
      tasks.add(tracked)
    },
  }
  function beginRequest(): () => void {
    activeRequests++
    let released = false
    return () => {
      if (released) return
      released = true
      activeRequests--
      notify()
    }
  }
  function drain(timeoutMs = 30_000): Promise<DrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid drain timeout')
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer)
        listeners.delete(check)
        const result = { completed, pendingTasks: tasks.size, activeRequests }
        if (!completed) log.warn('platform.background.drain_timeout', result)
        resolve(result)
      }
      const check = () => {
        if (tasks.size === 0 && activeRequests === 0) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      listeners.add(check)
      check()
    })
  }
  let shutdown: Promise<DrainResult & { resourcesClosed: boolean }> | undefined
  return {
    ...background,
    beginRequest,
    drain,
    /** stopReceiving 只发起关闭，不等待 server.close 回调；在途请求由 beginRequest 跟踪。 */
    shutdown(options: {
      stopReceiving: () => void
      closeResources: () => Promise<void>
      timeoutMs?: number
    }): Promise<DrainResult & { resourcesClosed: boolean }> {
      if (shutdown) return shutdown
      shutdown = (async () => {
        const timeoutMs = options.timeoutMs ?? 30_000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
          throw new Error('Invalid drain timeout')
        const deadline = Date.now() + timeoutMs
        options.stopReceiving()
        const result = await drain(Math.max(0, deadline - Date.now()))
        let timer: ReturnType<typeof setTimeout> | undefined
        const closing = Promise.resolve()
          .then(options.closeResources)
          .then(
            () => true,
            () => {
              log.error('platform.background.close_failed')
              return false
            },
          )
        const resourcesClosed = await Promise.race([
          closing,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
          }),
        ])
        clearTimeout(timer)
        if (!resourcesClosed) log.warn('platform.background.resources_not_closed')
        return { ...result, resourcesClosed }
      })()
      return shutdown
    },
  }
}
