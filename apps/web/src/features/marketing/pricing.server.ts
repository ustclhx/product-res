import { createPaymentRuntime } from '@product-res/billing'
import { AppError } from '@product-res/shared'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { createPricingCache } from './pricing-data.ts'
import { readPricingCatalog } from './pricing-read.ts'
import { pricingSnapshot } from './pricing-snapshot.ts'

const readCached = createPricingCache(pricingSnapshot)

/** 数据库不可达和支付未配置时，公开页仍展示快照并禁用购买。 */
export async function readMarketingPricing(
  runtime: Pick<WebRuntime, 'publicDb' | 'config' | 'cache'>,
) {
  const catalog = await readCached(() => readPricingCatalog(runtime.publicDb))
  let providers: ReturnType<typeof createPaymentRuntime>['readiness']
  try {
    providers = createPaymentRuntime(runtime.config, templateConfig.billing.providers, {
      cache: runtime.cache,
    }).readiness
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 503) throw error
    // 公开页面保留定价内容，支付配置错误时关闭全部购买入口。
    providers = templateConfig.billing.providers.map((id) => ({ id, available: false }))
  }
  return {
    ...catalog,
    providers,
    prices: catalog.prices.map((price) => ({
      ...price,
      available: price.available && providers.some((p) => p.id === price.provider && p.available),
    })),
  }
}
