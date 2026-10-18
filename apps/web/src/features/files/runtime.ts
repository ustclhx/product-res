import { requireCapability } from '@product-res/platform'
import { getWebRuntime, type WebRuntime } from '../../server/runtime.ts'
import { getAiHttpDeps } from '../ai/runtime.ts'

export function requireFileStorage(runtime: Pick<WebRuntime, 'files'>) {
  return requireCapability(runtime.files ?? { available: false }, 'files')
}

/** 工作流可用不代表已装配 C 的对象存储，提交必须在任务与预扣前检查。 */
export function getFileMediaHttpDeps() {
  requireFileStorage(getWebRuntime())
  return getAiHttpDeps()
}
