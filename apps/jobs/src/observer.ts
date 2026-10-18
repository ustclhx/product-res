import { log } from '@product-res/shared/log'

/** 目标入口注入观测实现；业务不加载任何 Sentry 平台 SDK。 */
export interface JobObserver {
  tagContext(): void
  captureException(error: unknown): void
  run?<T>(handle: () => T): T
  close?(timeoutMs: number): Promise<unknown>
}

/** Node 暂以共享日志记录固定错误类型，不输出外部异常中的凭据或内容。 */
export const logJobObserver: JobObserver = {
  tagContext() {},
  captureException(error) {
    log.error('jobs.exception', { errorType: error instanceof Error ? error.name : typeof error })
  },
}

/** 在已有 ALS 身份内创建观测 scope；外围持久化错误采集后仍由引擎处理。 */
export async function withJobObserver<T>(observer: JobObserver, handle: () => Promise<T>) {
  const run = async () => {
    try {
      return await handle()
    } catch (error) {
      observer.captureException(error)
      throw error
    }
  }
  return observer.run ? observer.run(run) : run()
}
