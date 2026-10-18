import type { SourceConnector } from '@product-res/datasources'
import { createDataForSeoConnector } from './dataforseo.ts'
import { createEbayBrowseConnector } from './ebay.ts'
import { createFxConnector } from './fx.ts'
import { createKeepaConnector } from './keepa.ts'

export { createDataForSeoConnector, normalizeDataForSeo } from './dataforseo.ts'
export {
  createEbayBrowseConnector,
  dailySalesFromTotals,
  derivedDailySales,
  freshListings,
  normalizeEbay,
} from './ebay.ts'
export { createFxConnector, normalizeRates } from './fx.ts'
export { createKeepaConnector, keepaTimeToDate, normalizeKeepa } from './keepa.ts'

/**
 * 部署中注册的全部连接器（jobs 与 web 共用）。Jungle Scout、卖家精灵、SP-API 在拿到凭据并完成
 * 字段核验后加入；Helium 10 走文件导入。
 */
export function createConnectors(): SourceConnector[] {
  return [
    createEbayBrowseConnector(),
    createKeepaConnector(),
    createDataForSeoConnector(),
    createFxConnector(),
  ]
}
