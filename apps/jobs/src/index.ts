// Cloudflare composition entry：绑定、WorkflowEntrypoint 与 Sentry SDK 只在目标入口装配。
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { createTaskMediaProvider, getMediaOutputHosts, readMediaTaskInput } from '@product-res/ai'
import {
  emailTransportConfig,
  MEDIA_MAX_FILE_BYTES,
  MEDIA_OUTPUT_MIME_TYPES,
} from '@product-res/config'
import { createDb } from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import type { WorkspaceTransferWorkflowParams } from '@product-res/follow/transfer'
import {
  createCloudflareDatabase,
  createCloudflareKv,
  createCloudflareQueue,
  createCloudflareQueueBatch,
  createCloudflareWorkflowStep,
} from '@product-res/platform/cloudflare'
import { newRequestId, withLogContext } from '@product-res/shared/log'
import { getFileDownload, persistMediaOutputs } from '@product-res/storage'
import {
  createCloudflareMediaCopier,
  createCloudflareStorage,
} from '@product-res/storage/cloudflare'
import { instrumentWorkflowWithSentry, withSentry } from '@sentry/cloudflare'
import templateConfig from '../../../template.config.ts'
import { registerAiHoldSweepers } from './ai.ts'
import { requireEnv } from './env.ts'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from './handlers.ts'
import {
  captureJobException,
  createWorkflowSentry,
  sentryEnabled,
  sentryOptions,
  tagJobContext,
} from './sentry.ts'
import { runMediaTask } from './workflows/media-runner.ts'
import { runWorkspaceTransfer } from './workflows/transfer-runner.ts'

const cloudflareJobObserver = { tagContext: tagJobContext, captureException: captureJobException }

const features = {
  billing: templateConfig.billing.enabled,
  credits: templateConfig.credits.enabled,
  text: templateConfig.ai.text.enabled,
  media: templateConfig.ai.image || templateConfig.ai.video,
}
registerAiHoldSweepers(features)

/** 每事件装配并显式挑选标量配置；不把 bindings 传入业务 env。 */
function createJobsContext(env: Cloudflare.Env): JobsContext {
  const valid = requireEnv(env)
  return {
    config: {
      ...(valid.PAYMENT_MODE === undefined ? {} : { PAYMENT_MODE: valid.PAYMENT_MODE }),
      ...(env.AI_FAULT_INJECTION === undefined
        ? {}
        : { AI_FAULT_INJECTION: env.AI_FAULT_INJECTION }),
      ...(env.SENTRY_ENVIRONMENT === undefined
        ? {}
        : { SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT }),
      ...(env.STRIPE_SECRET_KEY === undefined ? {} : { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }),
      ...(env.STRIPE_WEBHOOK_SECRET === undefined
        ? {}
        : { STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET }),
      ...(env.PAYPAL_CLIENT_ID === undefined ? {} : { PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID }),
      ...(env.PAYPAL_CLIENT_SECRET === undefined
        ? {}
        : { PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET }),
      ...(env.PAYPAL_WEBHOOK_ID === undefined ? {} : { PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID }),
    },
    db: createCloudflareDatabase(env),
    cache: createCloudflareKv(env.CACHE),
    emailQueue: createCloudflareQueue(env.EMAIL_QUEUE),
    ...(env.EVENTS_QUEUE && { eventsQueue: createCloudflareQueue(env.EVENTS_QUEUE) }),
    emailTransport: emailTransportConfig(valid),
    files: { available: true, value: { delete: (key) => env.FILES.delete(key) } },
    observer: cloudflareJobObserver,
    billingEnabled: features.billing,
  }
}

const handler = {
  async fetch(_request, env, _ctx?: ExecutionContext) {
    tagJobContext()
    requireEnv(env)
    return new Response('Not Found', { status: 404 })
  },
  async queue(batch, env, _ctx?: ExecutionContext) {
    return withLogContext({ queue: batch.queue }, () =>
      consumeJobsBatch(createCloudflareQueueBatch(batch), createJobsContext(env)),
    )
  },
  async scheduled(controller, env, _ctx?: ExecutionContext) {
    return runJobsSchedule(
      controller.cron,
      new Date(controller.scheduledTime),
      createJobsContext(env),
      { cronProfile: env.CRON_PROFILE ?? 'default', features },
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>

// SDK 会原地包装 handler；副本避免禁用路径也进入 SDK 初始化。
const instrumented = withSentry(sentryOptions, { ...handler })

export default {
  fetch(request, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId() }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.fetch(request, env, ctx)
    })
  },
  queue(batch, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId(), queue: batch.queue }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.queue(batch, env, ctx)
    })
  },
  scheduled(controller, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId(), cron: controller.cron }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.scheduled(controller, env, ctx)
    })
  },
} satisfies ExportedHandler<Cloudflare.Env>

export type AiMediaParams = {
  taskId: string
  requestId?: string
}

class AiMediaWorkflowBase extends WorkflowEntrypoint<Cloudflare.Env, AiMediaParams> {
  override run(event: WorkflowEvent<AiMediaParams>, step: WorkflowStep) {
    return withLogContext(
      { requestId: event.payload.requestId ?? newRequestId(), taskId: event.payload.taskId },
      async () => {
        tagJobContext()
        const workflowSentry = createWorkflowSentry(step, sentryEnabled(this.env))
        try {
          requireEnv(this.env)
          const db = createDb(this.env.HYPERDRIVE)
          const workflowStep = createCloudflareWorkflowStep(workflowSentry.step)
          return await runMediaTask(event.payload.taskId, workflowStep, {
            db,
            faultEnv: this.env,
            callbackOrigin: templateConfig.app.url,
            callbackSecret: this.env.MEDIA_WEBHOOK_SECRET ?? '',
            provider: (task) =>
              createTaskMediaProvider(this.env, task, templateConfig.ai.mediaProviders),
            params: async (task) => {
              const input = readMediaTaskInput(task)
              const params = { ...input.params }
              for (const name of input.fileParams) {
                params[name] = await getFileDownload(db, createCloudflareStorage(this.env), {
                  workspaceId: task.workspaceId,
                  fileId: input.params[name] as string,
                })
              }
              return params
            },
            observer: workflowSentry.observer,
            persist: async (task, result) => {
              const entitlements = await getEntitlements(db, task.workspaceId, {
                pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
              })
              return persistMediaOutputs({
                db,
                storage: createCloudflareStorage(this.env),
                copyOutput: createCloudflareMediaCopier(this.env.FILES),
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
          })
        } catch (error) {
          workflowSentry.observer.captureException(error)
          throw error
        }
      },
    )
  }
}

const InstrumentedAiMediaWorkflow = instrumentWorkflowWithSentry(sentryOptions, AiMediaWorkflowBase)

// Workflow 包装器在构造时绑定环境；禁用时直接构造原始类，避免 run 初始化 SDK。
export const AiMediaWorkflow = new Proxy(AiMediaWorkflowBase, {
  construct(target, args, newTarget) {
    const env = args[1] as Cloudflare.Env
    return Reflect.construct(
      sentryEnabled(env) ? InstrumentedAiMediaWorkflow : target,
      args,
      newTarget,
    )
  },
})

class WorkspaceTransferWorkflowBase extends WorkflowEntrypoint<
  Cloudflare.Env,
  WorkspaceTransferWorkflowParams
> {
  override run(event: WorkflowEvent<WorkspaceTransferWorkflowParams>, step: WorkflowStep) {
    return withLogContext(
      {
        requestId: event.payload.requestId ?? newRequestId(),
        transferId: event.payload.transferId,
      },
      async () => {
        tagJobContext()
        const workflowSentry = createWorkflowSentry(step, sentryEnabled(this.env))
        try {
          requireEnv(this.env)
          return await runWorkspaceTransfer(
            event.payload.transferId,
            createCloudflareWorkflowStep(workflowSentry.step),
            {
              db: createDb(this.env.HYPERDRIVE),
              config: templateConfig,
              cache: createCloudflareKv(this.env.CACHE),
              observer: workflowSentry.observer,
            },
          )
        } catch (error) {
          workflowSentry.observer.captureException(error)
          throw error
        }
      },
    )
  }
}

const InstrumentedWorkspaceTransferWorkflow = instrumentWorkflowWithSentry(
  sentryOptions,
  WorkspaceTransferWorkflowBase,
)

/** 跨空间数据流转（add-workspace-data-transfer 4.1）；web 以 WORKSPACE_TRANSFER_WORKFLOW 绑定 */
export const WorkspaceTransferWorkflow = new Proxy(WorkspaceTransferWorkflowBase, {
  construct(target, args, newTarget) {
    const env = args[1] as Cloudflare.Env
    return Reflect.construct(
      sentryEnabled(env) ? InstrumentedWorkspaceTransferWorkflow : target,
      args,
      newTarget,
    )
  },
})
