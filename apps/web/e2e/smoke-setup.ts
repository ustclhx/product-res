import { createDb, plan, planPrice } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'

export const SMOKE_PRICE_ID = '019a0000-0000-7000-8000-000000000002'
const planId = '019a0000-0000-7000-8000-000000000001'

export default async function setup() {
  const connectionString = readLocalEnv('MIGRATION_DATABASE_URL')
  if (!connectionString) throw new Error('Smoke requires an isolated local database')
  const url = new URL(connectionString)
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !(url.pathname.startsWith('/product_res_wt_') || url.pathname === '/product_res_ci_e2e')
  )
    throw new Error('Smoke requires a worktree database or product_res_ci_e2e on localhost')
  for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED']) {
    const value = readLocalEnv(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`)
    if (!value) throw new Error(`Smoke requires an explicit local ${binding} connection`)
    const appUrl = new URL(value)
    if (appUrl.host !== url.host || appUrl.pathname !== url.pathname)
      throw new Error('Smoke migration and application connections must use the same database')
  }
  const db = createDb({ connectionString })
  try {
    await db
      .insert(plan)
      .values({
        id: planId,
        key: 'ci-smoke-credit-pack',
        name: 'CI smoke credits',
        type: 'credit_pack',
        credits: 100,
        features: DEFAULT_FREE_FEATURES,
        active: true,
      })
      .onConflictDoNothing()
    await db
      .insert(planPrice)
      .values({
        id: SMOKE_PRICE_ID,
        planId,
        provider: 'stripe',
        providerPriceId: 'smoke-credit-pack',
        amount: 1000,
        currency: 'usd',
        active: true,
      })
      .onConflictDoNothing()
  } finally {
    await db.$client.end()
  }
}
