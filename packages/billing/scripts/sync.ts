#!/usr/bin/env -S node --experimental-strip-types
import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { syncCatalog } from '../src/catalog.ts'
import { createPayPalProvider } from '../src/paypal/index.ts'
import { createStripeProvider } from '../src/stripe/adapter.ts'

// This CLI has no production/live path. Credentials are supplied only at the later gate.
if (readLocalEnv('BILLING_SYNC_MODE') !== 'test')
  throw new Error('BILLING_SYNC_MODE=test is required; live/production sync is forbidden')
const secretKey = readLocalEnv('STRIPE_SECRET_KEY')
const clientId = readLocalEnv('PAYPAL_CLIENT_ID')
const clientSecret = readLocalEnv('PAYPAL_CLIENT_SECRET')
if (!secretKey?.startsWith('sk_test_') || !clientId || !clientSecret)
  throw new Error('Explicit Stripe test and PayPal sandbox credentials are required')
const url = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
if (!url) throw new Error('Missing local billing database URL')
const tokens = new Map<string, { value: string; expiresAt: number }>()
const providers = [
  createStripeProvider({ secretKey, webhookSecret: '' }),
  createPayPalProvider({
    environment: 'sandbox',
    clientId,
    clientSecret,
    fetch,
    cache: {
      async get(key) {
        const token = tokens.get(key)
        return token && token.expiresAt > Date.now() ? token.value : null
      },
      async put(key, value, options) {
        tokens.set(key, { value, expiresAt: Date.now() + options.expirationTtl * 1000 })
      },
    },
  }),
]
const db = createDb({ connectionString: url })
try {
  console.log(
    `Synced ${await syncCatalog(db, providers)} template example price mappings in test/sandbox mode.`,
  )
} finally {
  await db.$client.end()
}
