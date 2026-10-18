import {
  createBillingEventHandler,
  createCompensationFailureHandler,
  createPaymentRuntime,
  markManualRefund,
  notifyRefundRequest,
  type RefundServiceOptions,
  replayWebhook,
  retryRefundNotification,
  reviewRefundRequest,
} from '@product-res/billing'
import { type Database, refundRequest, webhookEvent } from '@product-res/db'
import { requireCapability } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { withRequestId } from '@product-res/shared/log'
import { isNotFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { withBilling } from '../../server/feature-gates.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withAdminAction, withDelegatedAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'

import {
  listAdminPayments,
  listAdminPurchases,
  listAdminRefunds,
  listAdminSubscriptions,
  listAdminWebhooks,
} from './admin-data.ts'

const page = z.object({
  offset: z.number().int().min(0).max(100_000).default(0),
  workspaceId: z.uuid().optional(),
})
const request = z.object({ requestId: z.uuid() })
function runtime(db: Database) {
  try {
    return createPaymentRuntime(getWebRuntime().config, templateConfig.billing.providers, {
      cache: getWebRuntime().cache,
      db,
    })
  } catch (error) {
    if (error instanceof AppError && error.status === 503) setResponseStatus(503)
    throw error
  }
}
function refundOptions(db: Database): RefundServiceOptions {
  const queue = requireCapability(getWebRuntime().emailQueue, 'Email queue')
  return {
    db,
    providers: runtime(db).providers,
    config: templateConfig.billing,
    notify: (notification) =>
      notifyRefundRequest(
        {
          db,
          queue: {
            send: async (message) => {
              await queue.send(withRequestId(message))
            },
          },
          appName: templateConfig.app.name,
          supportEmail: templateConfig.app.supportEmail,
        },
        notification,
      ),
  }
}
async function safe(action: () => Promise<string>) {
  try {
    return { ok: true as const, status: await action() }
  } catch (error) {
    // 写事务内发现管理员已失效：与守卫一样返回 404，不当作业务失败
    if (isNotFound(error)) throw error
    if (error instanceof AppError && error.status === 503) setResponseStatus(503)
    return {
      ok: false as const,
      error: error instanceof AppError ? error.code : 'BILLING_UNAVAILABLE',
    }
  }
}

export const getAdminBilling = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(page)
  .handler(async ({ context, data }) => {
    const current = runtime(context.db)
    return {
      ...(await listAdminPayments(context.db, data)),
      mode: current.mode,
      readiness: current.readiness,
    }
  })

export const getAdminSubscriptions = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(page)
  .handler(({ context, data }) => listAdminSubscriptions(context.db, data))

export const getAdminPurchases = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(page)
  .handler(({ context, data }) => listAdminPurchases(context.db, data))

export const getAdminWebhooks = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(page)
  .handler(async ({ context, data }) => {
    const result = await listAdminWebhooks(context.db, data)
    const current = runtime(context.db)
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        replayAvailable: Boolean(current.normalizers[row.provider]),
      })),
    }
  })

export const getAdminRefunds = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(page)
  .handler(async ({ context, data }) => {
    const result = await listAdminRefunds(context.db, data)
    const providers = runtime(context.db).providers
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        providerAvailable: Boolean(providers[row.provider]),
        manualAvailable: Boolean(
          providers[row.provider] && !providers[row.provider]?.capabilities.refundsViaApi,
        ),
      })),
    }
  })

export const replayAdminWebhook = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(z.object({ webhookEventId: z.uuid() }))
  .handler(({ context, data }) =>
    safe(async () => {
      const current = runtime(context.db)
      const queue = requireCapability(getWebRuntime().eventsQueue, 'Events queue')
      // 校验与「已请求重放」审计同事务提交；重放本身在提交后执行（自行管理事务与队列通知），
      // 重放失败记录在回调事件上，可再次重试
      const delivery = await withAdminAction(
        context,
        'billing.webhook_replay',
        async ({ tx, audit }) => {
          const [found] = await tx
            .select({ provider: webhookEvent.provider, status: webhookEvent.status })
            .from(webhookEvent)
            .where(eq(webhookEvent.id, data.webhookEventId))
          if (found?.status !== 'failed')
            throw new AppError('WEBHOOK_NOT_REPLAYABLE', 'Only failed records can be replayed')
          if (!current.normalizers[found.provider])
            throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'Provider unavailable')
          await audit({
            action: 'billing.webhook_replay_requested',
            targetType: 'webhook_event',
            targetId: data.webhookEventId,
          })
          return found
        },
      )
      const normalize = current.normalizers[delivery.provider]
      if (!normalize) throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'Provider unavailable')
      const result = await replayWebhook({
        db: context.db,
        webhookEventId: data.webhookEventId,
        providerId: delivery.provider,
        normalize,
        ...createBillingEventHandler({
          db: context.db,
          providers: current.providers,
          subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
        }),
        onFailure: createCompensationFailureHandler(context.db),
        notify: async ({ delivery }) => {
          await queue.send(withRequestId({ v: 1, deliveryId: delivery.id }))
        },
      })
      return result.status === 'failed'
        ? 'Replay failed; record remains available for retry.'
        : 'notification' in result && result.notification.status === 'failed'
          ? `${result.status}; notification queue failed`
          : result.status
    }),
  )

// 退款审核 / 手动退款 / 重发通知：@product-res/billing 在自己的决策事务内写审计，并在提交后才调用支付平台与邮件队列，
// 因此只经 adminAction 的实时角色校验（withDelegatedAdminAction），不包进外层事务
export const reviewAdminRefund = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(
    request.extend({
      decision: z.enum(['approve', 'reject']),
      approvedAmount: z.number().int().positive().max(2_147_483_647).optional(),
      reviewNote: z.string().trim().max(2000),
    }),
  )
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(
        context,
        async (db) =>
          (
            await reviewRefundRequest(refundOptions(db), {
              requestId: data.requestId,
              ip: context.ip,
              decision: data.decision,
              reviewNote: data.reviewNote,
              ...(data.approvedAmount === undefined ? {} : { approvedAmount: data.approvedAmount }),
              userId: context.admin.id,
            })
          ).status,
      ),
    ),
  )

export const completeAdminRefund = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(
    request.extend({
      providerRefundId: z.string().trim().min(1).max(2000),
      proof: z.string().trim().min(1).max(2000),
    }),
  )
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(
        context,
        async (db) =>
          (
            await markManualRefund(refundOptions(db), {
              ...data,
              userId: context.admin.id,
              ip: context.ip,
            })
          ).status,
      ),
    ),
  )

export const retryAdminRefundEmail = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(request)
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(context, async (db) => {
        const options = refundOptions(db)
        await withAdminAction(
          context,
          'billing.refund_notification_retry_requested',
          async ({ tx, audit }) => {
            const [request] = await tx
              .select()
              // biome-ignore lint/plugin: 实时管理员守卫已通过，按退款申请 ID 获取明确空间再记录重试审计。
              .from(refundRequest)
              .where(eq(refundRequest.id, data.requestId))
            if (!request)
              throw new AppError('NOT_FOUND', 'Refund request unavailable', { status: 404 })
            await audit({
              workspaceId: request.workspaceId,
              action: 'billing.refund_notification_retry_requested',
              targetType: 'refund_request',
              targetId: request.id,
              meta: { status: request.status },
            })
          },
        )
        await retryRefundNotification(options, { ...data, userId: context.admin.id })
        return 'Email queued or already delivered'
      }),
    ),
  )
