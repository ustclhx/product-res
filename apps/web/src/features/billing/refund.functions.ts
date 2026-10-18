import {
  createPaymentRuntime,
  listRefundablePayments,
  notifyRefundRequest,
  submitRefundRequest,
} from '@product-res/billing'
import { requireCapability } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withBilling } from '../../server/feature-gates.ts'
import { withRealSession, withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { enqueueRefundOperations } from '../notifications/operations.ts'

const workspace = z.object({ slug: z.string().min(1).max(64) })
function options(db: Parameters<typeof listRefundablePayments>[0]['db']) {
  let runtime: ReturnType<typeof createPaymentRuntime>
  try {
    runtime = createPaymentRuntime(getWebRuntime().config, templateConfig.billing.providers, {
      cache: getWebRuntime().cache,
      db,
    })
  } catch (error) {
    if (error instanceof AppError && error.status === 503) setResponseStatus(503)
    throw error
  }
  return {
    db,
    providers: runtime.providers,
    config: templateConfig.billing,
    notify: (notification: Parameters<typeof notifyRefundRequest>[1]) =>
      notifyRefundRequest(
        {
          db,
          queue: requireCapability(getWebRuntime().emailQueue, 'Email queue'),
          appName: templateConfig.app.name,
          supportEmail: templateConfig.app.supportEmail,
        },
        notification,
      ),
  }
}
export const getCustomerRefunds = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => {
    if (context.member.role !== 'owner') return null
    const payments = await listRefundablePayments(options(context.db), {
      userId: context.user.id,
      workspaceId: context.workspace.id,
    })
    return {
      contactEmail: context.user.email,
      windowDays: templateConfig.billing.refundWindowDays,
      payments: payments.slice(0, 100).map((p) => ({
        id: p.id,
        provider: p.provider,
        amount: p.amount,
        currency: p.currency,
        paidAt: p.paidAt,
        remainingRefundable: p.remainingRefundable,
      })),
    }
  })
export const requestCustomerRefund = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      paymentId: z.uuid(),
      reason: z.string().trim().min(1).max(2000),
      contactEmail: z.email().max(254),
    }),
  )
  .handler(async ({ context, data }) => {
    try {
      if (context.workspaceReadOnly)
        throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
      const events = requireCapability(getWebRuntime().eventsQueue, 'Events queue')
      requireCapability(getWebRuntime().emailQueue, 'Email queue')
      const request = await submitRefundRequest(options(context.db), {
        userId: context.user.id,
        workspaceId: context.workspace.id,
        paymentId: data.paymentId,
        reason: data.reason,
        contactEmail: data.contactEmail,
      })
      await enqueueRefundOperations(
        context.db,
        { send: (message) => events.send(message) },
        request,
      )
      return { ok: true as const, id: request.id }
    } catch (error) {
      if (error instanceof AppError && error.status === 503) setResponseStatus(503)
      return {
        ok: false as const,
        error: error instanceof AppError ? error.code : 'REFUND_UNAVAILABLE',
      }
    }
  })
