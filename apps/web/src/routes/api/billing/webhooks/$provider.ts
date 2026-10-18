import { createPaymentRuntime } from '@product-res/billing'
import { requireCapability } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { createFileRoute } from '@tanstack/react-router'
import { handleBillingWebhook } from '../../../../features/billing/webhook-http.ts'
import { getWebRuntime } from '../../../../server/runtime.ts'
import { templateConfig } from '../../../../server/template-config.ts'

export const Route = createFileRoute('/api/billing/webhooks/$provider')({
  server: {
    handlers: {
      POST: ({ request, params }) => handlePaymentWebhook(request, params.provider),
    },
  },
})

export async function handlePaymentWebhook(request: Request, providerId: string) {
  if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
  if (providerId !== 'stripe' && providerId !== 'paypal')
    return new Response('Not Found', { status: 404 })
  try {
    const web = getWebRuntime()
    const db = web.db
    const runtime = createPaymentRuntime(web.config, templateConfig.billing.providers, {
      cache: web.cache,
      db,
    })
    return await handleBillingWebhook(request, providerId, {
      db,
      providers: runtime.providers,
      queue: requireCapability(web.eventsQueue, 'Events queue'),
      subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
    })
  } catch (error) {
    if (error instanceof AppError && error.status === 503)
      return new Response('Payments unavailable', { status: 503 })
    throw error
  }
}
