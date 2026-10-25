import {
  cancelSubscription,
  changePlan,
  confirmCheckout,
  createCheckout,
  createPaymentRuntime,
  getPortalUrl,
  resumeSubscription,
} from '@product-res/billing'
import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withBilling, withCredits } from '../../server/feature-gates.ts'
import { withRealSession, withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import {
  creditPageSchema,
  customerBilling,
  customerCatalog,
  customerUsage,
} from './customer-data.ts'

const workspace = z.object({ slug: z.string().min(1).max(64) })
const provider = z.enum(['stripe', 'paypal', 'creem', 'paddle', 'polar'])
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
function service(db: Database) {
  return {
    db,
    providers: runtime(db).providers,
    enabledProviders: templateConfig.billing.providers,
  }
}
function returnUrl(slug: string, id: string, canceled = false) {
  const url = new URL(
    `/app/${encodeURIComponent(slug)}/billing-return`,
    getWebRuntime().config.APP_URL,
  )
  url.searchParams.set('provider', id)
  if (canceled) url.searchParams.set('canceled', 'true')
  return url.toString()
}
async function safe<T>(readOnly: boolean, action: () => Promise<T>) {
  try {
    if (readOnly)
      throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
    return { ok: true as const, result: await action() }
  } catch (error) {
    if (error instanceof AppError && error.status === 503) setResponseStatus(503)
    // 非业务错误（服务商拒绝、网络等）对用户只显示 BILLING_UNAVAILABLE，原因需留在日志中排查
    if (!(error instanceof AppError)) log.error('billing.action_failed', { error })
    return {
      ok: false as const,
      error: error instanceof AppError ? error.code : 'BILLING_UNAVAILABLE',
    }
  }
}
export const getPublicPricing = createServerFn({ method: 'GET' })
  .middleware([withBilling])
  .handler(() => {
    const db = getWebRuntime().db
    return customerCatalog(db, runtime(db).readiness)
  })
export const getCustomerBilling = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => ({
    ...(await customerBilling(
      context.db,
      context.workspace.id,
      context.member.role,
      templateConfig.billing.pastDueGraceDays,
    )),
    catalog: await customerCatalog(context.db, runtime(context.db).readiness),
    role: context.member.role,
    readOnly: context.workspaceTeamReadOnly,
  }))
export const getCustomerUsage = createServerFn({ method: 'GET' })
  .middleware([withCredits, withWorkspace])
  .inputValidator(
    workspace.extend({
      ...creditPageSchema.shape,
      kind: z.enum(['ledger', 'batches']).default('ledger'),
    }),
  )
  .handler(({ context, data }) =>
    customerUsage(
      context.db,
      context.workspace.id,
      context.user.id,
      context.member.role,
      { limit: data.limit, ...(data.cursor ? { cursor: data.cursor } : {}) },
      data.kind,
    ),
  )
export const checkoutCustomer = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      provider,
      planPriceId: z.uuid(),
      idempotencyKey: z.uuid(),
      confirmSwitch: z.boolean().optional(),
      expectedOldSubscriptionId: z.uuid().optional(),
    }),
  )
  .handler(({ context, data }) =>
    safe(context.workspaceTeamReadOnly, async () => {
      const result = await createCheckout(service(context.db), {
        ip: getWebRuntime().requestMeta.clientIp,
        provider: data.provider,
        planPriceId: data.planPriceId,
        idempotencyKey: data.idempotencyKey,
        ...(data.confirmSwitch === undefined ? {} : { confirmSwitch: data.confirmSwitch }),
        ...(data.expectedOldSubscriptionId
          ? { expectedOldSubscriptionId: data.expectedOldSubscriptionId }
          : {}),
        workspaceId: context.workspace.id,
        userId: context.user.id,
        successUrl: returnUrl(context.workspace.slug, data.provider),
        cancelUrl: returnUrl(context.workspace.slug, data.provider, true),
      })
      return { url: result.url }
    }),
  )
export const manageCustomerSubscription = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      subscriptionId: z.uuid(),
      action: z.enum(['cancel', 'resume', 'portal', 'change']),
      planPriceId: z.uuid().optional(),
    }),
  )
  .handler(({ context, data }) =>
    safe(context.workspaceTeamReadOnly, async () => {
      const ctx = service(context.db)
      const input = {
        ip: getWebRuntime().requestMeta.clientIp,
        subscriptionId: data.subscriptionId,
        workspaceId: context.workspace.id,
        userId: context.user.id,
      }
      if (data.action === 'portal')
        return {
          status: 'portal',
          url: await getPortalUrl(ctx, {
            ...input,
            returnUrl: new URL(
              `/app/${encodeURIComponent(context.workspace.slug)}/billing`,
              getWebRuntime().config.APP_URL,
            ).toString(),
          }),
        }
      if (data.action === 'change') {
        if (!data.planPriceId) throw new AppError('BILLING_PRICE_UNAVAILABLE', 'Choose a plan')
        return changePlan(ctx, { ...input, planPriceId: data.planPriceId })
      }
      if (data.action === 'cancel') await cancelSubscription(ctx, input)
      else await resumeSubscription(ctx, input)
      return { status: 'updated' }
    }),
  )
export const confirmCustomerCheckout = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace, withRealSession])
  .inputValidator(workspace.extend({ provider, providerRef: z.string().min(1).max(255) }))
  .handler(({ context, data }) =>
    safe(context.workspaceTeamReadOnly, async () => {
      await confirmCheckout(service(context.db), {
        provider: data.provider,
        providerRef: data.providerRef,
        workspaceId: context.workspace.id,
        userId: context.user.id,
      })
      return { status: 'awaiting_payment' }
    }),
  )
