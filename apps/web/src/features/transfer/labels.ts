import type { Tone } from '@product-res/ui'
import { m } from '../../paraglide/messages.js'
import { workspaceError } from '../workspace/client.ts'

/**
 * 数据流转页面的状态、表名与错误码文案（add-workspace-data-transfer tasks 6.1、6.3）。
 * 只依赖 Paraglide，不引用 @product-res/follow 的运行时代码（它带数据库依赖，不进浏览器 bundle）。
 */

export type TransferKind = 'upgrade' | 'copy' | 'move'
export type TransferStatus = 'pending' | 'running' | 'compensating' | 'completed' | 'compensated'

/** 与 @product-res/db WORKSPACE_TRANSFER_ACTIVE_STATUSES 一致：这些状态下两个空间只读 */
export const ACTIVE_TRANSFER_STATUSES: readonly TransferStatus[] = [
  'pending',
  'running',
  'compensating',
]
export const isActiveTransfer = (status: string) =>
  (ACTIVE_TRANSFER_STATUSES as readonly string[]).includes(status)

export const CANCELLED_CODE = 'TRANSFER_CANCELLED'

export function kindLabel(kind: string): string {
  if (kind === 'upgrade') return m.transfer_kind_upgrade()
  if (kind === 'copy') return m.transfer_kind_copy()
  return m.transfer_kind_move()
}

/** 用户取消后补偿完成显示为“已取消”，其余补偿完成为“已回滚” */
export function statusLabel(status: string, errorCode?: string | null): string {
  switch (status) {
    case 'pending':
      return m.transfer_status_pending()
    case 'running':
      return m.transfer_status_running()
    case 'compensating':
      return m.transfer_status_compensating()
    case 'completed':
      return m.transfer_status_completed()
    default:
      return errorCode === CANCELLED_CODE
        ? m.transfer_status_cancelled()
        : m.transfer_status_compensated()
  }
}

export function statusTone(status: string, errorCode?: string | null): Tone {
  switch (status) {
    case 'pending':
      return 'neutral'
    case 'running':
      return 'info'
    case 'compensating':
      return 'warning'
    case 'completed':
      return 'success'
    default:
      return errorCode === CANCELLED_CODE ? 'neutral' : 'danger'
  }
}

const ERRORS: Record<string, () => string> = {
  TRANSFER_CANCELLED: () => m.transfer_error_cancelled(),
  TRANSFER_PERMISSION_REVOKED: () => m.transfer_error_permission_revoked(),
  TRANSFER_TIMEOUT: () => m.transfer_error_timeout(),
  TRANSFER_TARGET_NOT_EMPTY: () => m.transfer_error_target_not_empty(),
  TRANSFER_ENTITLEMENT_EXCEEDED: () => m.transfer_error_entitlement_exceeded(),
  TRANSFER_TOO_LARGE: () => m.transfer_error_too_large(),
  TRANSFER_CLOSURE_INCOMPLETE: () => m.transfer_error_closure_incomplete(),
  TRANSFER_KIND_UNSUPPORTED: () => m.transfer_error_kind_unsupported(),
  TRANSFER_STATE: () => m.transfer_error_state(),
  TRANSFER_COMPENSATION_ORDER: () => m.transfer_error_compensation_order(),
  TRANSFER_FORBIDDEN: () => m.transfer_error_forbidden(),
  TRANSFER_IN_PROGRESS: () => m.transfer_error_in_progress(),
  TRANSFER_DISABLED: () => m.transfer_error_disabled(),
  TRANSFER_IDEMPOTENCY_CONFLICT: () => m.transfer_error_idempotency_conflict(),
  TRANSFER_SAME_WORKSPACE: () => m.transfer_error_same_workspace(),
  TRANSFER_EMPTY_SELECTION: () => m.transfer_error_empty_selection(),
  CAPABILITY_UNAVAILABLE: () => m.transfer_error_unavailable(),
}

/** 团队准入沿用空间设置的错误文案 */
const WORKSPACE_CODES = new Set([
  'INVALID_WORKSPACE_SLUG',
  'SLUG_TAKEN',
  'WORKSPACE_LIMIT',
  'WORKSPACE_READ_ONLY',
])

/** error_code（失败与取消原因）与发起时的错误码 → 本地化文案 */
export function transferErrorText(code: string): string {
  if (WORKSPACE_CODES.has(code)) return workspaceError(code)
  return ERRORS[code]?.() ?? m.transfer_error_unknown({ code })
}

/** 写操作捕获的错误：带稳定错误码时（transfer-error.ts 适配器保留）按码选择文案 */
export function transferActionError(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return transferErrorText(error.code)
  return error instanceof Error && error.message ? error.message : fallback
}

export type TransferGroup =
  | 'config'
  | 'direction'
  | 'store-pool'
  | 'tracked-product'
  | 'category-study'
  | 'validation'

/** 流转注册表（packages/follow/src/transfer/registry.ts）的表 → 批次分组与文案；测试校验覆盖完整 */
export const TRANSFER_TABLES: Readonly<
  Record<string, { group: TransferGroup; label: () => string }>
> = {
  seasonal_node: { group: 'config', label: () => m.transfer_table_seasonal_node() },
  brand_entry: { group: 'config', label: () => m.transfer_table_brand_entry() },
  risk_rule: { group: 'config', label: () => m.transfer_table_risk_rule() },
  scoring_setting: { group: 'config', label: () => m.transfer_table_scoring_setting() },
  supplier: { group: 'config', label: () => m.transfer_table_supplier() },
  logistics_profile: { group: 'config', label: () => m.transfer_table_logistics_profile() },
  cost_param: { group: 'config', label: () => m.transfer_table_cost_param() },
  direction: { group: 'direction', label: () => m.transfer_table_direction() },
  direction_seller: { group: 'direction', label: () => m.transfer_table_direction_seller() },
  cluster: { group: 'direction', label: () => m.transfer_table_cluster() },
  cluster_member: { group: 'direction', label: () => m.transfer_table_cluster_member() },
  cluster_signal: { group: 'direction', label: () => m.transfer_table_cluster_signal() },
  lead: { group: 'direction', label: () => m.transfer_table_lead() },
  lead_event: { group: 'direction', label: () => m.transfer_table_lead_event() },
  risk_finding: { group: 'direction', label: () => m.transfer_table_risk_finding() },
  supplier_quote: { group: 'direction', label: () => m.transfer_table_supplier_quote() },
  costing_scenario: { group: 'direction', label: () => m.transfer_table_costing_scenario() },
  decision: { group: 'direction', label: () => m.transfer_table_decision() },
  follow_outcome: { group: 'direction', label: () => m.transfer_table_follow_outcome() },
  recommendation: { group: 'direction', label: () => m.transfer_table_recommendation() },
  recommendation_label: {
    group: 'direction',
    label: () => m.transfer_table_recommendation_label(),
  },
  tracked_store: { group: 'store-pool', label: () => m.transfer_table_tracked_store() },
  tracked_product: {
    group: 'tracked-product',
    label: () => m.transfer_table_tracked_product(),
  },
  category_study: { group: 'category-study', label: () => m.transfer_table_category_study() },
  category_study_snapshot: {
    group: 'category-study',
    label: () => m.transfer_table_category_study_snapshot(),
  },
  readiness_stat: { group: 'validation', label: () => m.transfer_table_readiness_stat() },
  weight_suggestion: { group: 'validation', label: () => m.transfer_table_weight_suggestion() },
  accuracy_audit: { group: 'validation', label: () => m.transfer_table_accuracy_audit() },
  accuracy_audit_item: {
    group: 'validation',
    label: () => m.transfer_table_accuracy_audit_item(),
  },
}

export const TRANSFER_GROUP_ORDER: readonly TransferGroup[] = [
  'config',
  'direction',
  'store-pool',
  'tracked-product',
  'category-study',
  'validation',
]

export function groupLabel(group: string): string {
  switch (group) {
    case 'config':
      return m.transfer_group_config()
    case 'direction':
      return m.transfer_group_direction()
    case 'store-pool':
      return m.transfer_group_store_pool()
    case 'tracked-product':
      return m.transfer_group_tracked_product()
    case 'category-study':
      return m.transfer_group_category_study()
    case 'validation':
      return m.transfer_group_validation()
    default:
      return m.transfer_group_other()
  }
}

/** 未登记的表（注册表新增后文案尚未补齐）原样显示表名 */
export const tableLabel = (table: string) => TRANSFER_TABLES[table]?.label() ?? table

/** 批次键 `<分组>[:<id>][#<子批>]`：显示分组名，同组多批时附带短 id 区分 */
export function batchLabel(key: string): string {
  const [head = key, sub] = key.split('#', 2)
  const [family = head, id] = head.split(':', 2)
  const item = id ? ` · ${id === 'none' ? '—' : id.slice(-6)}` : ''
  return `${groupLabel(family)}${item}${sub ? ` #${sub}` : ''}`
}

export interface TableGroupSummary {
  readonly group: TransferGroup | 'other'
  readonly total: number
  readonly tables: readonly { readonly table: string; readonly count: number }[]
}

/** 升级预览：按批次分组汇总表行数，只列出有数据的分组 */
export function groupTableCounts(tables: Readonly<Record<string, number>>): TableGroupSummary[] {
  const groups = new Map<TransferGroup | 'other', { table: string; count: number }[]>()
  for (const [table, count] of Object.entries(tables)) {
    if (!count) continue
    const group = TRANSFER_TABLES[table]?.group ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), { table, count }])
  }
  return [...TRANSFER_GROUP_ORDER, 'other' as const]
    .filter((group) => groups.has(group))
    .map((group) => {
      const tables = groups.get(group) ?? []
      return { group, total: tables.reduce((sum, t) => sum + t.count, 0), tables }
    })
}

/** 时间统一按 UTC 显示，SSR 与水合结果一致 */
export function formatUtc(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
