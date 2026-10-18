import type { PaymentMode, PaymentModeEnv, TemplateConfig } from '@product-res/config'
import { EnvValidationError, resolvePaymentMode } from '@product-res/config'
import type { Database, JsonValue, PaymentProviderId } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import type { BillingProviders } from './events.ts'
import {
  createPayPalProvider,
  createPayPalWebhookNormalizer,
  type PayPalTokenCache,
} from './paypal/index.ts'
import { createPayPalSaleLookup } from './paypal/recorded-sale.ts'
import type { VerifiedWebhook } from './provider.ts'
import { createStripeProvider, createStripeWebhookNormalizer } from './stripe/adapter.ts'

export interface PaymentRuntimeEnv extends PaymentModeEnv {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
}

// 同一 isolate 的多个入口共用告警状态，避免每次请求或 Cron 都重复记录。
const warnedProviders = new Set<PaymentProviderId>()

/** Missing credentials leave checkout unavailable; invalid modes fail before provider construction. */
export function createPaymentRuntime(
  env: PaymentRuntimeEnv,
  enabled: TemplateConfig['billing']['providers'],
  options: {
    db?: Database
    fetch?: typeof fetch
    cache?: PayPalTokenCache
    warn?: (provider: PaymentProviderId, missing: (keyof PaymentRuntimeEnv)[]) => void
  } = {},
) {
  let mode: PaymentMode
  try {
    mode = resolvePaymentMode(env)
    if (enabled.includes('stripe') && env.STRIPE_SECRET_KEY) {
      const valid =
        mode === 'test'
          ? env.STRIPE_SECRET_KEY.startsWith('sk_test_')
          : env.STRIPE_SECRET_KEY.startsWith('sk_live_') ||
            env.STRIPE_SECRET_KEY.startsWith('rk_live_')
      if (!valid) throw new EnvValidationError([], ['STRIPE_SECRET_KEY'])
    }
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error
    // 未知模式和环境可能含敏感输入，只记录固定安全标签与变量名。
    log.error('billing.runtime_invalid', {
      missing: error.missing,
      invalid: error.invalid,
      mode:
        env.PAYMENT_MODE === 'test' || env.PAYMENT_MODE === 'live'
          ? env.PAYMENT_MODE
          : env.PAYMENT_MODE === undefined
            ? env.SENTRY_ENVIRONMENT === 'development'
              ? 'test'
              : 'missing'
            : 'invalid',
      environment:
        env.SENTRY_ENVIRONMENT === 'development' ||
        env.SENTRY_ENVIRONMENT === 'staging' ||
        env.SENTRY_ENVIRONMENT === 'production'
          ? env.SENTRY_ENVIRONMENT
          : 'unknown',
    })
    throw new AppError('BILLING_UNAVAILABLE', 'Payment configuration is unavailable', {
      status: 503,
    })
  }

  function warnUnconfigured(provider: PaymentProviderId, required: (keyof PaymentRuntimeEnv)[]) {
    if (warnedProviders.has(provider)) return
    const missing = required.filter((key) => !env[key])
    warnedProviders.add(provider)
    if (options.warn) options.warn(provider, missing)
    else log.warn('billing.provider_unconfigured', { provider, missing, mode })
  }

  const providers: BillingProviders = {}
  const normalizers: Partial<
    Record<PaymentProviderId, (payload: JsonValue) => Promise<VerifiedWebhook>>
  > = {}
  if (enabled.includes('stripe')) {
    if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
      providers.stripe = createStripeProvider({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        expectedMode: mode,
        ...(options.fetch && { fetch: options.fetch }),
      })
      normalizers.stripe = createStripeWebhookNormalizer({
        secretKey: env.STRIPE_SECRET_KEY,
        expectedMode: mode,
        ...(options.fetch && { fetch: options.fetch }),
      })
    } else {
      warnUnconfigured('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    }
  }
  if (
    enabled.includes('paypal') &&
    env.PAYPAL_CLIENT_ID &&
    env.PAYPAL_CLIENT_SECRET &&
    env.PAYPAL_WEBHOOK_ID
  ) {
    if (!options.cache) throw new EnvValidationError([], ['CACHE'])
    const paypal = {
      environment: mode === 'test' ? ('sandbox' as const) : ('live' as const),
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      fetch: options.fetch ?? fetch,
      cache: options.cache,
      ...(options.db && { lookupRecordedSale: createPayPalSaleLookup(options.db) }),
    }
    providers.paypal = createPayPalProvider(paypal)
    normalizers.paypal = createPayPalWebhookNormalizer(paypal)
  } else if (enabled.includes('paypal')) {
    warnUnconfigured('paypal', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'])
  }
  return {
    mode,
    providers,
    normalizers,
    readiness: enabled.map((id) => ({ id, available: Boolean(providers[id]) })),
  }
}
