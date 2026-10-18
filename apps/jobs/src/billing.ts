// biome-ignore-all lint/plugin: Cross-workspace system audit markers have no workspace owner.
import {
  clearResolvedRefundContacts,
  createPaymentRuntime,
  flushRefundNotifications,
  type PaymentRuntimeEnv,
  runAnnualGrants,
  runCreditExpiration,
  runCreditReconciliation,
  runHoldSweep,
  runPendingCompensations,
  runSubscriptionReconciliation,
} from '@product-res/billing'
import { auditLog, type Database, webhookEvent } from '@product-res/db'
import type { EmailQueueMessage } from '@product-res/email/queue'
import type { DatabaseAccess, KeyValueStore, QueueProducer } from '@product-res/platform'
import { log, withRequestId } from '@product-res/shared/log'
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import templateConfig from '../../../template.config.ts'

export const BILLING_HOURLY_CRON = '0 * * * *'
export const BILLING_RETRY_CRON = '*/10 * * * *'
export const BILLING_DAILY_CRON = '0 4 * * *'
export const BILLING_POSTPROCESS_ACTION = 'billing.webhook_postprocessed'
export const BILLING_RECOVERY_LIMIT = 100
export interface BillingEnv {
  config: Readonly<PaymentRuntimeEnv>
  db: DatabaseAccess
  cache: KeyValueStore
  emailQueue: QueueProducer<EmailQueueMessage>
  eventsQueue?: QueueProducer<unknown>
}

// Bindings and database clients belong to each invocation, never to module state.
export function createBillingContext(env: BillingEnv) {
  const db = env.db.business()
  const { providers } = createPaymentRuntime(env.config, templateConfig.billing.providers, {
    cache: env.cache,
    db,
  })
  return {
    db,
    providers,
    mail: {
      db,
      queue: {
        async send(message: EmailQueueMessage) {
          await env.emailQueue.send(message)
        },
      },
      appName: templateConfig.app.name,
      supportEmail: templateConfig.app.supportEmail,
    },
  }
}
type BillingContext = ReturnType<typeof createBillingContext>
type JobResult = { failures?: readonly unknown[]; failed?: number } | { cleared: number }

/** Attempt independent jobs even if one fails; expose only job names and failure counts. */
export async function runBillingJobs(jobs: readonly [string, () => Promise<JobResult>][]) {
  const failures: string[] = []
  for (const [name, run] of jobs) {
    try {
      const result = await run()
      const count = ('failures' in result ? result.failures?.length : 0) ?? 0
      const failed = ('failed' in result ? result.failed : 0) ?? 0
      if (count + failed > 0) failures.push(`${name} (${count + failed})`)
    } catch {
      failures.push(name)
    }
  }
  if (failures.length) throw new Error(`Billing jobs failed: ${failures.join(', ')}`)
}

async function completed(db: Database, deliveryId: string) {
  const [marker] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, deliveryId), eq(auditLog.action, BILLING_POSTPROCESS_ACTION)))
  return Boolean(marker)
}

/** Read committed deliveries only: no normalization, webhook replay, payment or credit writes. */
export async function postprocessBillingDelivery(context: BillingContext, deliveryId: string) {
  const [delivery] = await context.db
    .select()
    .from(webhookEvent)
    .where(eq(webhookEvent.id, deliveryId))
  if (!delivery || !['processed', 'ignored'].includes(delivery.status))
    throw new Error('Billing delivery is not committed')
  if (await completed(context.db, deliveryId)) return
  // Queue acceptance must precede the marker; failed external sends remain recoverable.
  await runBillingJobs([
    ['refund_notifications', () => flushRefundNotifications(context.mail)],
    ['compensation', () => runPendingCompensations(context)],
  ])
  await context.db.insert(auditLog).values({
    action: BILLING_POSTPROCESS_ACTION,
    targetType: 'webhook_event',
    targetId: deliveryId,
  })
}

export async function recoverBillingDeliveries(context: BillingContext) {
  const rows = await context.db
    .select({ id: webhookEvent.id })
    .from(webhookEvent)
    .where(
      and(
        inArray(webhookEvent.status, ['processed', 'ignored']),
        notExists(
          context.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.targetId, sql`${webhookEvent.id}::text`),
                eq(auditLog.action, BILLING_POSTPROCESS_ACTION),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(webhookEvent.processedAt), asc(webhookEvent.id))
    .limit(BILLING_RECOVERY_LIMIT)
  const failures: string[] = []
  for (const row of rows) {
    try {
      await postprocessBillingDelivery(context, row.id)
    } catch {
      failures.push(row.id)
    }
  }
  return { failures }
}

export interface BillingScheduleFeatures {
  billing: boolean
  credits: boolean
}

export async function runBillingSchedule(
  cron: string,
  env: BillingEnv,
  features: BillingScheduleFeatures = { billing: true, credits: true },
) {
  if (!features.billing && !features.credits) return
  // 只有积分功能时不初始化支付 Provider；关闭的业务也不访问数据库。
  const context = features.billing ? createBillingContext(env) : undefined
  const db = context?.db ?? env.db.business()
  const now = new Date()
  const alert = async (failure: { job: string; workspaceId: string; targetId: string }) => {
    try {
      if (!env.eventsQueue) throw new Error('Events queue unavailable')
      await env.eventsQueue.send(
        withRequestId({
          v: 1,
          operations: [
            {
              event: 'reconciliation.failed',
              sourceId: `${failure.job}:${failure.targetId}:${now.getTime()}`,
              workspaceId: failure.workspaceId,
            },
          ],
        }),
      )
    } catch {
      log.warn('operations.enqueue_failed', {
        event: 'reconciliation.failed',
        workspaceId: failure.workspaceId,
      })
    }
  }
  const jobs: [string, () => Promise<JobResult>][] = []
  switch (cron) {
    case BILLING_HOURLY_CRON:
      if (features.credits) jobs.push(['credit_expiration', () => runCreditExpiration(db, now)])
      if (features.credits && context)
        jobs.push([
          'annual_grants',
          () =>
            runAnnualGrants(context.db, now, {
              subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
            }),
        ])
      break
    case BILLING_RETRY_CRON:
      if (features.credits) jobs.push(['hold_sweep', () => runHoldSweep(db, now)])
      if (context)
        jobs.push(
          ['delivery_recovery', () => recoverBillingDeliveries(context)],
          ['compensation', () => runPendingCompensations(context)],
          ['refund_notifications', () => flushRefundNotifications(context.mail)],
        )
      break
    case BILLING_DAILY_CRON:
      if (context)
        jobs.push([
          'subscription_reconciliation',
          () => runSubscriptionReconciliation(context.db, context.providers, { alert }),
        ])
      if (features.credits)
        jobs.push(['credit_reconciliation', () => runCreditReconciliation(db, { alert })])
      if (context)
        jobs.push(['refund_contact_cleanup', () => clearResolvedRefundContacts(context.db, now)])
      break
    default:
      throw new Error('Unknown billing cron')
  }
  return runBillingJobs(jobs)
}
