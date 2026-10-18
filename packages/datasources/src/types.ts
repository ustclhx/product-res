/**
 * 数据源连接器契约（openspec/changes/add-data-source-hub design D1）。
 * 上层只按“数据类型”取数，不依赖具体工具；每个数值都带来源、获取方式和原始响应引用。
 */

/** 平台站点：`{平台}-{站点}` */
export type Marketplace =
  | 'ebay-us'
  | 'amazon-us'
  | 'amazon-uk'
  | 'amazon-de'
  | 'amazon-jp'
  | 'amazon-ca'
  | 'global'

export const DATA_KINDS = [
  'seller-new-listings',
  'product-snapshot',
  'sales-estimate',
  'rank-history',
  'keyword-volume',
  'search-trend',
  'reviews',
  'fee-estimate',
  'taxonomy',
  'fx-rate',
] as const
export type DataKind = (typeof DATA_KINDS)[number]

/** 获取方式：官方 / 第三方估算 / 推算 / 手工导入 */
export type AcquisitionMethod = 'official' | 'estimate' | 'derived' | 'import'

export type BudgetUnit = 'call' | 'token' | 'usd-micro'
export type BudgetPeriod = 'minute' | 'day' | 'month'

export interface BudgetSpec {
  readonly unit: BudgetUnit
  readonly period: BudgetPeriod
  /** 周期内绝不超过 */
  readonly hardCap: number
  /** 定时任务用到此为止，余量留给人工刷新 */
  readonly safetyLine: number
  /** 周期边界所在时区（IANA）；外部额度按该时区的日/月重置 */
  readonly timeZone: string
  /** 月度预算的分配方式：日均分配并滚动结余，或月内先到先得 */
  readonly monthlyAllocation?: 'daily-rollover' | 'first-come'
  /** 付费数据源的硬上限按合同由团队填写；免费官方接口（如 eBay）的硬上限不可调高 */
  readonly hardCapEditable?: boolean
}

export type EntityType = 'product' | 'seller' | 'keyword' | 'category' | 'currency'

/** 实体的自然键：平台 + 平台内 ID */
export interface EntityKey {
  readonly type: EntityType
  readonly marketplace: Marketplace
  /** ASIN、ItemID、卖家 ID、关键词原文、类目 ID、币种对等 */
  readonly platformId: string
}

export interface ProductFacts {
  readonly title?: string | undefined
  readonly brand?: string | undefined
  readonly gtin?: string | undefined
  readonly categoryId?: string | undefined
  readonly imageUrl?: string | undefined
  readonly url?: string | undefined
  readonly sellerId?: string | undefined
  readonly listedAt?: string | undefined
}

export interface NormalizedEntity {
  readonly key: EntityKey
  readonly facts?: ProductFacts
}

export interface NormalizedObservation {
  readonly entity: EntityKey
  readonly metric: string
  /** YYYY-MM-DD（数据源时区下的观测日期） */
  readonly observedOn: string
  readonly value: number
  readonly currency?: string | undefined
  readonly method: AcquisitionMethod
}

/** 平台类目树中的一个节点（taxonomy 数据类型） */
export interface NormalizedCategory {
  readonly marketplace: Marketplace
  readonly categoryId: string
  readonly name: string
  readonly parentId: string | null
  readonly leaf: boolean
  /** 从根到本节点的名称路径，用 " > " 连接 */
  readonly path: string
  readonly treeVersion: string
}

export interface NormalizedBatch {
  readonly entities: readonly NormalizedEntity[]
  readonly observations: readonly NormalizedObservation[]
  /** 类目树节点（仅 taxonomy 任务返回） */
  readonly categories?: readonly NormalizedCategory[]
  /** 下一页游标；undefined 表示没有更多 */
  readonly nextCursor?: string | undefined
}

export interface FetchTask {
  readonly kind: DataKind
  readonly marketplace: Marketplace
  /** 范围：卖家 ID、商品 ID 列表、关键词等，按连接器约定 */
  readonly scope: Readonly<Record<string, unknown>>
  readonly cursor?: string | undefined
}

/** 一次外部请求的原始响应，存档后可回放 */
export interface RawPayload {
  readonly sourceId: string
  readonly task: FetchTask
  /** 已去掉凭据的请求摘要 */
  readonly request: { readonly method: string; readonly url: string }
  readonly status: number
  readonly body: string
  readonly fetchedAt: string
  /** 外部返回的剩余额度，用于对账 */
  readonly remainingQuota?: number | undefined
}

export interface FetchResult {
  readonly payloads: readonly RawPayload[]
  /** 实际花费（预算单位）；未提供时按 plan 的估算结算 */
  readonly cost?: number | undefined
}

export interface ProbeCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string | undefined
}

export interface ProbeReceipt {
  readonly sourceId: string
  readonly checkedAt: string
  readonly credentials: 'missing' | 'valid' | 'invalid'
  readonly checks: readonly ProbeCheck[]
}

export interface ConnectorContext {
  readonly fetch: typeof fetch
  /** 读取凭据；未配置返回 undefined */
  readonly secret: (name: string) => string | undefined
  readonly now: () => Date
}

export interface SourceConnector {
  readonly id: string
  readonly label: string
  /** api：接口同步；file：只能文件导入 */
  readonly access: 'api' | 'file'
  readonly marketplaces: readonly Marketplace[]
  readonly capabilities: readonly DataKind[]
  readonly budget: BudgetSpec
  /** 需要的 secret 名称（仅用于显示配置状态） */
  readonly secrets: readonly string[]
  /** 默认队列流控 */
  readonly queue: {
    readonly concurrency: number
    readonly rateLimit?: { limit: number; periodMs: number }
  }
  probe(ctx: ConnectorContext): Promise<ProbeReceipt>
  /** 调用前估算花费（预算单位），用于预扣 */
  plan(task: FetchTask): number
  fetch(task: FetchTask, ctx: ConnectorContext): Promise<FetchResult>
  /** 纯函数：原始响应 → 实体与观测值 */
  normalize(payload: RawPayload): NormalizedBatch
}
