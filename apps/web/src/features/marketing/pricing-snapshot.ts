import type { PricingCatalog } from './pricing-data.ts'

/** Vite 将构建时读取的公开套餐嵌入客户端和 Worker 产物。 */
declare const __PRICING_SNAPSHOT__: PricingCatalog
export const pricingSnapshot: PricingCatalog = __PRICING_SNAPSHOT__
