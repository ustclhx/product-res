import type { AiFaultInjectionEnv } from '@product-res/config'
import type { EmailSender } from '@product-res/email'
import type {
  Capability,
  DeadLetterSink,
  QueueBatch,
  ScheduledHandler,
  Scheduler,
} from '@product-res/platform'
import { log, newRequestId, withLogContext } from '@product-res/shared/log'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  type BillingEnv,
  type BillingScheduleFeatures,
  runBillingSchedule,
} from './billing.ts'
import { runDeletionCleanup } from './cron/deletion-cleanup.ts'
import { runFilesCleanup } from './cron/files-cleanup.ts'
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { runMetricsDaily } from './cron/metrics-daily.ts'
import { runWorkspaceCleanup, WORKSPACE_CLEANUP_CRON } from './cron/workspace-cleanup.ts'
import { type JobObserver, withJobObserver } from './observer.ts'
import { handleBillingBatch } from './queues/billing.ts'
import { handleEmailBatch, type JobsEmailTransport } from './queues/email.ts'

export interface JobsContext extends BillingEnv {
  config: BillingEnv['config'] & AiFaultInjectionEnv
  emailTransport: JobsEmailTransport
  emailSender?: EmailSender
  files: Capability<{ delete(key: string | string[]): Promise<void> }>
  observer: JobObserver
  emailDeadLetters?: DeadLetterSink<unknown>
  eventsDeadLetters?: DeadLetterSink<unknown>
  billingEnabled?: boolean
}

const EMAIL_QUEUES = new Set([
  'product-res-email',
  'product-res-email-staging',
  'product-res-email-production',
])
const EVENTS_QUEUES = new Set([
  'product-res-events',
  'product-res-events-staging',
  'product-res-events-production',
])

export function consumeJobsBatch(batch: QueueBatch<unknown>, context: JobsContext) {
  return withJobObserver(context.observer, () => consumeBatch(batch, context))
}

async function consumeBatch(batch: QueueBatch<unknown>, context: JobsContext) {
  context.observer.tagContext()
  if (EMAIL_QUEUES.has(batch.queue)) {
    return handleEmailBatch(batch, context.emailTransport, {
      observer: context.observer,
      ...(context.emailSender && { sender: context.emailSender }),
      ...(context.emailDeadLetters && { deadLetters: context.emailDeadLetters }),
    })
  }
  if (EVENTS_QUEUES.has(batch.queue)) {
    return handleBillingBatch(batch, context, context.observer, {
      ...(context.eventsDeadLetters && { deadLetters: context.eventsDeadLetters }),
      ...(context.billingEnabled !== undefined && { billingEnabled: context.billingEnabled }),
    })
  }
  throw new Error(`Unknown queue: ${batch.queue}`)
}

/** B 的真实 scheduler 接入点；保持五条 UTC trigger 和原有分组失败语义。 */
export interface JobsScheduleOptions {
  /** 仅 Cloudflare staging 入口设置 reduced；Node 保持默认五条调度。 */
  cronProfile?: string
  features?: BillingScheduleFeatures
  skipUnavailableFiles?: boolean
  heartbeat?: ScheduledHandler
}

// 触发器映射到原有逻辑任务组；降低 staging 唤醒频率不改变任务组内部语义。
const CRON_TASK_GROUPS = {
  default: new Map<string, readonly [string, ...string[]]>([
    [HEARTBEAT_CRON, [HEARTBEAT_CRON]],
    [WORKSPACE_CLEANUP_CRON, [WORKSPACE_CLEANUP_CRON]],
    [BILLING_HOURLY_CRON, [BILLING_HOURLY_CRON]],
    [BILLING_RETRY_CRON, [BILLING_RETRY_CRON]],
    [BILLING_DAILY_CRON, [BILLING_DAILY_CRON]],
  ]),
  reduced: new Map<string, readonly [string, ...string[]]>([
    ['*/30 * * * *', [HEARTBEAT_CRON, BILLING_RETRY_CRON]],
    [WORKSPACE_CLEANUP_CRON, [WORKSPACE_CLEANUP_CRON]],
    [BILLING_HOURLY_CRON, [BILLING_HOURLY_CRON]],
    [BILLING_DAILY_CRON, [BILLING_DAILY_CRON]],
  ]),
}

export function registerJobsSchedules(
  scheduler: Scheduler,
  context: JobsContext,
  options: JobsScheduleOptions = {},
) {
  for (const [id, cron] of [
    ['jobs-heartbeat-v1', HEARTBEAT_CRON],
    ['jobs-daily-maintenance-v1', WORKSPACE_CLEANUP_CRON],
    ['jobs-billing-hourly-v1', BILLING_HOURLY_CRON],
    ['jobs-ten-minute-maintenance-v1', BILLING_RETRY_CRON],
    ['jobs-billing-daily-v1', BILLING_DAILY_CRON],
  ] as const) {
    if (
      options.features &&
      !options.features.billing &&
      !options.features.credits &&
      (cron === BILLING_HOURLY_CRON || cron === BILLING_DAILY_CRON)
    )
      continue
    scheduler.register({ id, cron, timeZone: 'UTC', missedRun: 'skip' }, ({ scheduledAt }) =>
      withLogContext({ requestId: newRequestId(), cron }, () =>
        runJobsSchedule(cron, scheduledAt, context, options),
      ),
    )
  }
}

export function runJobsSchedule(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions = {},
) {
  return withJobObserver(context.observer, () => runSchedule(cron, scheduledAt, context, options))
}

async function runSchedule(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions,
) {
  context.observer.tagContext()
  const profile = options.cronProfile ?? 'default'
  if (profile !== 'default' && profile !== 'reduced') {
    log.error('cron.unknown_profile', { profile, cron })
    throw new Error(`Unknown cron profile: ${profile}`)
  }
  const groups = CRON_TASK_GROUPS[profile].get(cron)
  if (!groups) {
    log.error('cron.unknown_trigger', { profile, cron })
    throw new Error(`Unknown cron: ${cron}`)
  }
  if (groups.length === 1) return runJobsTaskGroup(groups[0], scheduledAt, context, options)
  // 心跳与维护独立执行，任一组失败仍等待其他组完成，并将本次触发记为失败。
  const results = await Promise.allSettled(
    groups.map((group) => runJobsTaskGroup(group, scheduledAt, context, options)),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      'Reduced maintenance cron failed',
    )
}

async function runJobsTaskGroup(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions,
) {
  const billingEnabled = !options.features || options.features.billing || options.features.credits
  switch (cron) {
    case BILLING_HOURLY_CRON:
    case BILLING_DAILY_CRON:
      if (billingEnabled) return runBillingSchedule(cron, context, options.features)
      return
    case BILLING_RETRY_CRON: {
      // 文件清理与计费补偿独立执行；任何一项失败仍将本次 Cron 标记为失败。
      const results = await Promise.allSettled([
        ...(billingEnabled ? [runBillingSchedule(cron, context, options.features)] : []),
        ...(options.skipUnavailableFiles && !context.files.available
          ? []
          : [runFilesCleanup(context)]),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Ten-minute maintenance cron failed',
        )
      return
    }
    // METRICS_DAILY_CRON 与 WORKSPACE_CLEANUP_CRON 是同一个触发器：两项任务独立执行，
    // 任一失败不影响另一项，但仍让本次 Cron 标记为失败。
    case WORKSPACE_CLEANUP_CRON: {
      const results = await Promise.allSettled([
        runWorkspaceCleanup(context),
        runMetricsDaily(context, scheduledAt.getTime()),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Daily maintenance cron failed',
        )
      return
    }
    case HEARTBEAT_CRON:
      if (options.heartbeat) return options.heartbeat({ scheduledAt })
      await runDeletionCleanup(context)
      return runHeartbeat(context)
    default:
      throw new Error(`Unknown cron: ${cron}`)
  }
}
