import { log } from '@product-res/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { getImpersonation } from '../admin/impersonation.functions.ts'

export const getSeoOrigin = createServerFn({ method: 'GET' }).handler(
  () => getWebRuntime().config.APP_URL,
)

/** 根布局中的会话装饰读取失败不能阻断公开页（无数据库预渲染）。 */
export const getSafeImpersonation = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await getImpersonation()
  } catch (error) {
    log.warn('site.impersonation_read_failed', { error })
    return null
  }
})
