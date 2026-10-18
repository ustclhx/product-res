import type { PaymentProvider } from '../provider.ts'
import { createPayPalOperations } from './operations.ts'
import { createPayPalSnapshots, type PayPalSaleLookup } from './snapshots.ts'
import { createPayPalTransport, type PayPalTransportOptions } from './transport.ts'
import { payPalWebhookNormalizer, verifyPayPalWebhook } from './webhooks.ts'

export interface PayPalProviderOptions extends PayPalTransportOptions {
  webhookId?: string
  lookupRecordedSale?: PayPalSaleLookup
}

/** Offline-testable composition; construction performs no platform I/O. */
export function createPayPalProvider(options: PayPalProviderOptions): PaymentProvider {
  const transport = createPayPalTransport(options)
  const normalize = payPalWebhookNormalizer(
    transport,
    options.environment,
    options.lookupRecordedSale,
  )
  return {
    id: 'paypal',
    capabilities: {
      portal: false,
      changePlan: false,
      refundsViaApi: true,
      merchantOfRecord: false,
    },
    ...createPayPalOperations(transport),
    ...createPayPalSnapshots(transport, options.lookupRecordedSale),
    verifyWebhook: (req, rawBody) =>
      verifyPayPalWebhook(transport, req, rawBody, options.webhookId, normalize),
  }
}

export type { PayPalRecordedSale, PayPalSaleLookup } from './snapshots.ts'
export type { PayPalTokenCache } from './transport.ts'
export { createPayPalWebhookNormalizer } from './webhooks.ts'
