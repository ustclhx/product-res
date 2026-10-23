import type { SourceConnector } from '@product-res/datasources'
import { createDataForSeoConnector } from './dataforseo.ts'
import { createEbayBrowseConnector } from './ebay.ts'
import { createHelium10Source } from './file-import.ts'
import { createFxConnector } from './fx.ts'
import { createKeepaConnector } from './keepa.ts'
import { createSerpApiConnector } from './serpapi.ts'

export {
  type BestSellersRank,
  brandFromByline,
  parseAmazonDate,
  parseBestSellersRank,
  parseDetailsText,
  sellerIdFromUrl,
} from './amazon.ts'
export {
  AISA_DATAFORSEO_API,
  classifyAisaStatus,
  createDataForSeoConnector,
  type DataForSeoTransport,
  dataForSeoChannel,
  normalizeDataForSeo,
  resolveDataForSeoTransport,
} from './dataforseo.ts'
export {
  createEbayBrowseConnector,
  dailySalesFromTotals,
  derivedDailySales,
  freshListings,
  normalizeCategoryTree,
  normalizeEbay,
} from './ebay.ts'
export {
  createEbayPublicKeyStore,
  derToP1363,
  EBAY_ACCOUNT_DELETION_PATH,
  EBAY_ACCOUNT_DELETION_TOPIC,
  type EbayPublicKey,
  type EbayPublicKeyStore,
  type EbaySignatureHeader,
  ebayChallengeResponse,
  isValidEbayVerificationToken,
  parseEbaySignatureHeader,
  sha256Hex,
  verifyEbaySignature,
} from './ebay-notification.ts'
export {
  EBAY_STORE_ORIGIN,
  type EbayStoreResolution,
  ebayStorePageUrl,
  extractEbayStoreUsername,
  resolveEbayStoreUsername,
} from './ebay-store.ts'
export { type EbayAppToken, requestEbayAppToken } from './ebay-token.ts'
export { createFileImportSource, createHelium10Source } from './file-import.ts'
export { createFxConnector, normalizeRates } from './fx.ts'
export { createKeepaConnector, keepaTimeToDate, normalizeKeepa } from './keepa.ts'
export { classifySerpApi, createSerpApiConnector, normalizeSerpApi } from './serpapi.ts'

/**
 * 部署中注册的全部连接器（jobs 与 web 共用）。DataForSEO 按凭据自动选择直连或经 AIsa；
 * SerpApi 只做 Amazon 商品页交叉验证。Jungle Scout、卖家精灵、SP-API 在拿到凭据并完成
 * 字段核验后加入；Helium 10 只登记为文件导入类型。
 */
export function createConnectors(): SourceConnector[] {
  return [
    createEbayBrowseConnector(),
    createKeepaConnector(),
    createDataForSeoConnector(),
    createSerpApiConnector(),
    createFxConnector(),
    createHelium10Source(),
  ]
}
