import type { AcquisitionMethod, Marketplace } from '@product-res/datasources'

/** 跟卖选品的 7 个维度（docs/plan/selection-workbench.md 第 5.1 节） */
export const DIMENSIONS = [
  'market-demand',
  'growth-season',
  'peer-spread',
  'profit',
  'competition',
  'supply-timing',
  'compliance',
] as const
export type DimensionId = (typeof DIMENSIONS)[number]

export const DIMENSION_LABELS: Readonly<Record<DimensionId, string>> = {
  'market-demand': '市场需求',
  'growth-season': '增长与季节',
  'peer-spread': '同行扩散',
  profit: '利润空间',
  competition: '竞争强度',
  'supply-timing': '供应与时效',
  compliance: '合规与侵权',
}

export type Platform = 'ebay' | 'amazon'

/** 站点所属平台；global 等非平台站点返回 null */
export function platformOf(marketplace: Marketplace): Platform | null {
  if (marketplace.startsWith('ebay-')) return 'ebay'
  if (marketplace.startsWith('amazon-')) return 'amazon'
  return null
}

/** 一个已读取好的观测点：数值与来源（谁、怎么拿到、何时获取） */
export interface ObservationPoint {
  readonly value: number
  /** YYYY-MM-DD */
  readonly observedOn: string
  readonly sourceId: string
  readonly method: AcquisitionMethod
  /** ISO 8601 */
  readonly fetchedAt: string
}

/** 维度分所用输入的来源引用；保存到 cluster_signal 以便详情页解释 */
export interface SourceRef extends ObservationPoint {
  readonly metric: string
  /** 簇成员（平台商品）或关键词等实体 ID；簇级派生值可省略 */
  readonly entityId?: string | undefined
}

export type DetailValue = number | boolean | string

export interface DimensionResult {
  readonly dimension: DimensionId
  /** 0–100；缺少输入时为 null，绝不按 0 计 */
  readonly score: number | null
  readonly inputs: readonly SourceRef[]
  readonly reason: string
  /** 供门槛与置信度使用的中间量（毛利率、余量天数、季节稳定性等） */
  readonly detail?: Readonly<Record<string, DetailValue>> | undefined
}

/** 按平台 × 方向 × 信号类型计算的算法准备度（第 11.2 节）；M5 前全部为冷启动 */
export type Readiness = 'cold-start' | 'observation' | 'usable' | 'trusted'
