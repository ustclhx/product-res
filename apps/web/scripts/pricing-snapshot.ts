import { createDb } from '@product-res/db'
import { log } from '@product-res/shared/log'
import type { Plugin } from 'vite'
import { EXAMPLE_CATALOG } from '../../../packages/billing/src/catalog.ts'
import type { PricingCatalog } from '../src/features/marketing/pricing-data.ts'
import { readPricingCatalog } from '../src/features/marketing/pricing-read.ts'

/** CI 无数据库时使用同一份仓库示例，示例价格不作为结账凭据。 */
export function examplePricingCatalog(): PricingCatalog {
  return {
    plans: EXAMPLE_CATALOG.map((plan) => ({
      id: `example:${plan.key}`,
      key: plan.key,
      name: plan.name,
      type: plan.type,
      credits: plan.credits,
      creditExpiryDays: plan.creditExpiryDays,
      features: plan.features,
    })),
    prices: EXAMPLE_CATALOG.flatMap((plan) =>
      (['stripe', 'paypal'] as const).flatMap((provider) =>
        plan.prices.map((price) => ({
          ...price,
          id: `example:${plan.key}:${provider}:${price.interval}`,
          planId: `example:${plan.key}`,
          provider,
          currency: 'USD',
          active: false,
          available: false,
        })),
      ),
    ),
    providers: [],
  }
}

export async function buildPricingSnapshot(connectionString?: string): Promise<PricingCatalog> {
  try {
    if (!connectionString) throw new Error('No build database configured')
    // 构建脚本拥有此连接；业务公开读取只借用运行时 facade。
    const db = createDb(connectionString)
    try {
      return await readPricingCatalog(db)
    } finally {
      await db.$client.end({ timeout: 1 })
    }
  } catch {
    log.warn('pricing.build_fallback', { message: '构建期套餐读取失败，使用仓库示例数据' })
    return examplePricingCatalog()
  }
}

// TanStack Start 构建会重新加载 Vite 配置；同一构建进程只读取数据库一次。
const buildState = globalThis as typeof globalThis & {
  __saasPricingSnapshot?: Promise<PricingCatalog>
}

export function pricingSnapshotPlugin(connectionString?: string): Plugin {
  let snapshot: PricingCatalog
  return {
    name: 'saas:pricing-snapshot',
    async config(_config, { command }) {
      if (command === 'build') {
        buildState.__saasPricingSnapshot ??= buildPricingSnapshot(connectionString)
        snapshot = await buildState.__saasPricingSnapshot
      } else {
        snapshot = examplePricingCatalog()
      }
      return { define: { __PRICING_SNAPSHOT__: JSON.stringify(snapshot) } }
    },
    applyToEnvironment: (environment) => environment.name === 'ssr',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'pricing-snapshot.json',
        source: JSON.stringify(snapshot, null, 2),
      })
    },
  }
}
