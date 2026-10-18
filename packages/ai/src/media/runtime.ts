import type { AiTask } from '@product-res/db'
import { readMediaTaskInput } from './input.ts'
import type { TaskMediaProvider } from './provider.ts'
import { type MediaProviderEnv, requireMediaProviderDefinition } from './registry.ts'

export interface MediaRuntimeEnv extends MediaProviderEnv {}

/** 每个任务按提交时的模型快照重建 Provider，查询原始 jobId 不依赖 isolate 内存。 */
export function createTaskMediaProvider(
  env: MediaRuntimeEnv,
  task: AiTask,
  enabledProviders?: readonly string[],
): TaskMediaProvider {
  return requireMediaProviderDefinition(task.provider, env, enabledProviders).create(env, {
    modelId: readMediaTaskInput(task).providerModelId,
  })
}
