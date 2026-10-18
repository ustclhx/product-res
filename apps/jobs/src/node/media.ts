import {
  createTaskMediaProvider,
  getMediaOutputHosts,
  type MediaProviderEnv,
  readMediaTaskInput,
} from '@product-res/ai'
import {
  MEDIA_MAX_FILE_BYTES,
  MEDIA_OUTPUT_MIME_TYPES,
  type TemplateConfig,
} from '@product-res/config'
import type { NodeStorageConfig } from '@product-res/config/node'
import type { Database } from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import type { WorkflowStep } from '@product-res/platform'
import { newRequestId, withLogContext } from '@product-res/shared/log'
import { getFileDownload, persistMediaOutputs } from '@product-res/storage'
import { createNodeMediaCopier, createNodeStorage } from '@product-res/storage/node'
import templateConfig from '../../../../template.config.ts'
import { type JobObserver, logJobObserver, withJobObserver } from '../observer.ts'
import { type MediaRunnerDeps, runMediaTask } from '../workflows/media-runner.ts'

export type AiMediaParams = {
  taskId: string
  requestId?: string
}

export interface NodeMediaWorkflowOptions {
  readonly storage: NodeStorageConfig
  readonly providerEnv: MediaProviderEnv
  readonly callbackOrigin: string
  readonly callbackSecret: string
  readonly template?: TemplateConfig
  readonly observer?: JobObserver
}

/** 借用引擎业务池；字节与签名链接只在当前持久步骤内生成。 */
export function createNodeMediaRunnerDeps(
  db: Database,
  options: NodeMediaWorkflowOptions,
): MediaRunnerDeps {
  const template = options.template ?? templateConfig
  const storage = createNodeStorage(options.storage)
  const copyOutput = createNodeMediaCopier(options.storage)
  return {
    db,
    callbackOrigin: options.callbackOrigin,
    callbackSecret: options.callbackSecret,
    observer: options.observer ?? logJobObserver,
    provider: (task) =>
      createTaskMediaProvider(options.providerEnv, task, template.ai.mediaProviders),
    params: async (task) => {
      const input = readMediaTaskInput(task)
      const params = { ...input.params }
      for (const name of input.fileParams) {
        params[name] = await getFileDownload(db, storage, {
          workspaceId: task.workspaceId,
          fileId: input.params[name] as string,
        })
      }
      return params
    },
    persist: async (task, result) => {
      const entitlements = await getEntitlements(db, task.workspaceId, {
        pastDueGraceDays: template.billing.pastDueGraceDays,
      })
      return persistMediaOutputs({
        db,
        storage,
        copyOutput,
        task,
        result,
        limits: {
          maxFileBytes: MEDIA_MAX_FILE_BYTES,
          allowedHosts: getMediaOutputHosts(task.provider),
          allowedMimeTypes: MEDIA_OUTPUT_MIME_TYPES[task.kind],
          storageBytes: Math.min(
            readMediaTaskInput(task).storageBytes,
            entitlements.features.storageGb * 1024 ** 3,
          ),
        },
      })
    },
  }
}

/** 引擎注册留在 composition；业务 handler 只接收借用的数据库与正式步骤。 */
export function createNodeMediaHandler(db: Database, options: NodeMediaWorkflowOptions) {
  const deps = createNodeMediaRunnerDeps(db, options)
  const observer = options.observer ?? logJobObserver
  return async (params: AiMediaParams, step: WorkflowStep) =>
    withLogContext({ requestId: params.requestId ?? newRequestId(), taskId: params.taskId }, () =>
      withJobObserver(observer, async () => {
        observer.tagContext()
        return runMediaTask(params.taskId, step, deps)
      }),
    )
}
