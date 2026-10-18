import type {
  BillingProviders,
  CheckoutInput,
  OrderSnapshot,
  PaymentProvider,
} from '@product-res/billing'
import type { TemplateConfig } from '@product-res/config'
import { WebhookVerificationError } from '../../../packages/billing/src/provider.ts'
import { DUMMY_TURNSTILE_TOKEN } from './turnstile.ts'

// 仅由 smoke.vite.ts 替换支付工厂时加载；阻止 Worker 意外访问外部服务。
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const body = init?.body as FormData
    return Response.json({ success: body.get('response') === DUMMY_TURNSTILE_TOKEN })
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return originalFetch(input, init)
  throw new Error(`Smoke Worker blocked external fetch: ${url.origin}`)
}

const checkouts = new Map<string, CheckoutInput>()
function checkout(ref: string) {
  const input = checkouts.get(ref)
  if (!input) throw new Error('Unknown smoke checkout')
  return input
}
function metadata(input: CheckoutInput) {
  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    planPriceId: input.price.id,
  }
}
async function unsupported(): Promise<never> {
  throw new Error('Operation outside the smoke credit-pack fixture')
}
const provider: PaymentProvider = {
  id: 'stripe',
  capabilities: { portal: false, changePlan: false, refundsViaApi: false, merchantOfRecord: false },
  async createCheckout(input) {
    if (input.mode !== 'one_time') return unsupported()
    const ref = `smoke:${input.idempotencyKey}`
    checkouts.set(ref, input)
    const url = new URL(input.successUrl)
    url.searchParams.set('providerRef', ref)
    return { url: url.toString(), providerRef: ref }
  },
  async getOrder(ref): Promise<OrderSnapshot> {
    const input = checkout(ref)
    return {
      providerOrderId: ref,
      providerCustomerId: null,
      providerPriceId: input.price.providerPriceId,
      status: 'paid',
      amount: input.price.amount,
      currency: input.price.currency,
      metadata: metadata(input),
      raw: {},
    }
  },
  async verifyWebhook(request, rawBody) {
    if (request.headers.get('x-smoke-payment') !== 'local-fixture')
      throw new WebhookVerificationError('Missing local fixture marker')
    const raw = JSON.parse(rawBody) as { providerRef: string }
    const { providerRef } = raw
    const input = checkout(providerRef)
    const occurredAt = new Date()
    return {
      providerEventId: `paid:${providerRef}`,
      type: 'smoke.payment.succeeded',
      events: [
        {
          provider: 'stripe',
          type: 'payment.succeeded',
          occurredAt,
          raw,
          payment: {
            kind: 'one_time',
            providerOrderId: providerRef,
            providerPaymentId: `payment:${providerRef}`,
            providerPriceId: input.price.providerPriceId,
            providerCustomerId: null,
            amount: input.price.amount,
            currency: input.price.currency,
            paidAt: occurredAt,
            period: null,
            refundedAmount: 0,
            status: 'succeeded',
            metadata: metadata(input),
            raw,
          },
        },
      ],
    }
  },
  cancelSubscription: unsupported,
  getSubscription: unsupported,
  getPayment: unsupported,
  syncPlan: unsupported,
}

export function createPaymentRuntime(
  _env: unknown,
  enabled: TemplateConfig['billing']['providers'],
  _options?: unknown,
) {
  const providers: BillingProviders = enabled.includes('stripe') ? { stripe: provider } : {}
  return {
    mode: 'test' as const,
    providers,
    normalizers: {},
    readiness: enabled.map((id) => ({ id, available: Boolean(providers[id]) })),
  }
}
