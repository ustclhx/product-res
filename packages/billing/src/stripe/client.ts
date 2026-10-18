import Stripe from 'stripe'

/** Upgrade deliberately with SDK types, request mocks and recorded webhook fixtures. */
export const STRIPE_API_VERSION = '2026-09-30.endive' satisfies Stripe.LatestApiVersion

export function createStripeClient(secretKey: string, fetchFn?: typeof fetch): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 2,
    telemetry: false,
  })
}
