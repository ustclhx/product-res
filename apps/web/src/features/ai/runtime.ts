import { requireCapability } from '@product-res/platform'
import { getWebRuntime } from '../../server/runtime.ts'

/** 路由只组装业务依赖；原始 bindings 与目标 adapter 由请求入口负责。 */
export function getAiHttpDeps() {
  const runtime = getWebRuntime()
  const ai = requireCapability(runtime.ai ?? { available: false }, 'AI')
  return {
    db: runtime.db,
    auth: runtime.auth,
    env: {
      ...ai.config,
      APP_URL: runtime.config.APP_URL,
      ...(ai.workersAi.available ? { AI: ai.workersAi.value } : {}),
    },
    workflow: ai.workflow,
    workersAi: ai.workersAi.available,
    rateLimiter: runtime.rateLimiter,
    waitUntil: (promise: Promise<unknown>) => ai.background.waitUntil(promise),
    downloadFile: ai.downloadFile,
  }
}
