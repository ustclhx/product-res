/**
 * 店铺追踪（openspec/changes/add-accuracy-store-tracking design D4–D6）：店铺池、店铺新品与出单、
 * 分档追踪、店铺指标与“店铺新品出单”线索。apps/web 的店铺追踪页面与 apps/jobs 的调度共用。
 */
export {
  loadStoreCollectionTargets,
  markSnapshotted,
  planStoreTasks,
  STORE_SOURCES,
  type StorePlan,
  type StoreSearchTarget,
  type StoreSnapshotTarget,
  type StoreTask,
  storeKeywords,
  storeSellerTarget,
  storeSellerTargets,
} from './collect.ts'
export {
  createStoreSaleLead,
  STORE_LEAD_SOURCE,
  type StoreLeadOutcome,
  storeLeadProducts,
} from './leads.ts'
export {
  parseStoreLink,
  STORE_LINK_ERRORS,
  type StoreLinkForm,
  type StoreLinkPlatform,
  type StoreLinkResult,
} from './links.ts'
export {
  type ActiveStoreKey,
  activeStoreKeys,
  matchOffers,
  type RecordResult,
  recordStoreListings,
  STORE_SNAPSHOT_KINDS,
} from './listings.ts'
export { checkedOfferAsins, offerCandidates } from './offers.ts'
export {
  type AddStoreInput,
  addStore,
  detachDirection,
  getStore,
  listStores,
  MAX_STORE_KEYWORDS,
  mergedBenchmarks,
  type StoreSettingsInput,
  setStoreStatus,
  type TrackedStoreKind,
  type TrackedStoreStatus,
  updateStore,
} from './pool.ts'
export {
  isStoreRoundMessage,
  STORE_TRACKING_QUEUE,
  type StoreRoundMessage,
  storeRoundKey,
} from './queue.ts'
export {
  computeStoreMetrics,
  type DayValue,
  decideTier,
  lastChangeOn,
  roseWithin,
  type SaleSignal,
  STORE_TRACKING_DEFAULTS,
  type StoreListingFacts,
  type StoreMetrics,
  type StoreTrackingSettings,
  saleSignal,
  TIER_UP_REASONS,
  type TierInput,
  type TierUpReason,
} from './rules.ts'
export {
  evaluateStoreTracking,
  type ListingRow,
  type ListingView,
  loadListings,
  metricObservations,
  metricsOf,
  readSeriesByMarketplace,
  STORE_METRICS_SOURCE,
  type StoreEvaluationResult,
  toListingViews,
  type WorkspaceEvaluation,
} from './tracking.ts'
