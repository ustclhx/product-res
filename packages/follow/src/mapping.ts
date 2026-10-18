import type { LEAD_GRADES } from '@product-res/db'
import type { Grade, MergeMethod } from '@product-res/selection'

/**
 * packages/selection 与库表取值之间的映射。db 不能依赖 selection，两边各自维护列表，
 * test/mapping.test.ts 断言它们一致。
 */

export type LeadGradeValue = (typeof LEAD_GRADES)[number]

export const GRADE_TO_DB: Readonly<Record<Grade, LeadGradeValue>> = {
  recommended: 'recommend',
  caution: 'caution',
  'not-recommended': 'reject',
}

export const GRADE_FROM_DB: Readonly<Record<LeadGradeValue, Grade>> = {
  recommend: 'recommended',
  caution: 'caution',
  reject: 'not-recommended',
}

/** cluster_member.method 的取值 */
export type MemberMethodValue = 'gtin' | 'platform-id' | 'title' | 'manual'

/**
 * 簇的第一个成员（selection 的 'seed'）按自身平台 ID 识别，记为 platform-id、置信度 1；
 * 'similarity' 是预留策略（向量相似，本期不产生），落库前按标题相似处理。
 */
export const METHOD_TO_DB: Readonly<Record<MergeMethod, MemberMethodValue>> = {
  'platform-id': 'platform-id',
  gtin: 'gtin',
  title: 'title',
  similarity: 'title',
  seed: 'platform-id',
  manual: 'manual',
}

export const METHOD_FROM_DB: Readonly<Record<MemberMethodValue, MergeMethod>> = {
  'platform-id': 'platform-id',
  gtin: 'gtin',
  title: 'title',
  manual: 'manual',
}
