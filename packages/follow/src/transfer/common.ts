import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { type SQL, sql } from 'drizzle-orm'

/** Drizzle 事务（与 packages/platform 的 DatabaseTransaction 相同，引擎不依赖 platform） */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

/** 流转服务需要的模板配置（TemplateConfig['tenancy'] 的子集） */
export interface TransferConfig {
  readonly tenancy: {
    readonly multiTenant: boolean
    readonly dataTransfer: boolean
    readonly maxWorkspacesPerUser: number
  }
}

/** 复制的行数上限（D8）：超过只允许升级与移动，复制要求缩小范围 */
export const TRANSFER_COPY_ROW_LIMIT = 50_000
/** 升级时单批行数上限：超过按注册表顺序与主键切子批，子批键为 `<批次键>#<n>` */
export const TRANSFER_SUB_BATCH_ROWS = 20_000
/** 外部额度增量提示阈值：每日新增 Browse 调用数超过即在预览中提示 */
export const TRANSFER_QUOTA_WARN_CALLS = 20

/** 选择性操作的方向同名冲突策略（D4.1）：默认重命名，可改为合并到目标同名方向 */
export type DirectionConflictStrategy = 'rename' | 'merge'

/** 用户可选的根条目（D2，注册表 TRANSFER_ROOTS）；值为源空间中的行 id */
export interface TransferRoots {
  readonly direction?: readonly string[]
  readonly store?: readonly string[]
  readonly trackedProduct?: readonly string[]
  readonly categoryStudy?: readonly string[]
  readonly costingScenario?: readonly string[]
  readonly decision?: readonly string[]
  readonly configPack?: boolean
}

/** workspace_transfer.selection */
export interface TransferSelection {
  readonly roots?: TransferRoots
  readonly conflicts?: {
    readonly direction?: DirectionConflictStrategy
    /** 按源方向 id 覆盖默认策略 */
    readonly directions?: Readonly<Record<string, DirectionConflictStrategy>>
  }
  /** 升级完成后切换到新空间的发起人会话 */
  readonly sessionId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT_LISTS = [
  'direction',
  'store',
  'trackedProduct',
  'categoryStudy',
  'costingScenario',
  'decision',
] as const
const MAX_ROOTS = 1000

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

export function invalid(message: string): never {
  throw new AppError('INVALID_INPUT', message, { status: 400 })
}

/** 校验选择性移动 / 复制的输入，只保留已知字段（入库前规范化） */
export function parseSelection(input: unknown): TransferSelection {
  if (!input || typeof input !== 'object') invalid('selection 必须是对象')
  const raw = input as Record<string, unknown>
  const rawRoots = (raw.roots ?? {}) as Record<string, unknown>
  if (typeof rawRoots !== 'object') invalid('roots 必须是对象')
  const roots: Record<string, unknown> = {}
  let total = 0
  for (const key of ROOT_LISTS) {
    const value = rawRoots[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every(isUuid)) invalid(`roots.${key} 必须是 uuid 数组`)
    const ids = [...new Set(value.map((v) => v.toLowerCase()))]
    total += ids.length
    if (ids.length) roots[key] = ids
  }
  if (rawRoots.configPack !== undefined && typeof rawRoots.configPack !== 'boolean')
    invalid('roots.configPack 必须是布尔值')
  if (rawRoots.configPack) roots.configPack = true
  if (total > MAX_ROOTS) invalid(`一次最多选择 ${MAX_ROOTS} 个条目`)
  if (total === 0 && !roots.configPack) invalid('至少选择一个条目')
  const strategy = (value: unknown): DirectionConflictStrategy => {
    if (value !== 'rename' && value !== 'merge') invalid('方向冲突策略只能是 rename 或 merge')
    return value
  }
  const conflicts: { direction?: DirectionConflictStrategy; directions?: Record<string, never> } =
    {}
  const rawConflicts = raw.conflicts as Record<string, unknown> | undefined
  if (rawConflicts?.direction !== undefined) conflicts.direction = strategy(rawConflicts.direction)
  if (rawConflicts?.directions !== undefined) {
    const map: Record<string, DirectionConflictStrategy> = {}
    for (const [id, value] of Object.entries(rawConflicts.directions as object)) {
      if (!isUuid(id)) invalid('conflicts.directions 的键必须是方向 id')
      map[id.toLowerCase()] = strategy(value)
    }
    conflicts.directions = map as Record<string, never>
  }
  return {
    roots: roots as TransferRoots,
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  }
}

export function directionStrategy(
  selection: TransferSelection,
  directionId: string,
): DirectionConflictStrategy {
  return (
    selection.conflicts?.directions?.[directionId] ?? selection.conflicts?.direction ?? 'rename'
  )
}

/** 执行原始 SQL 并取行（postgres-js 驱动返回行数组） */
export async function rows<T = Record<string, unknown>>(tx: Tx, query: SQL): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[]
}

export const transferError = (
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) => new AppError(code, message, { status, ...(details ? { details } : {}) })

/** 不可重试的错误码：Workflow 遇到后应转入补偿（D8） */
export const NON_RETRYABLE_TRANSFER_ERRORS = new Set([
  'TRANSFER_PERMISSION_REVOKED',
  'TRANSFER_TARGET_NOT_EMPTY',
  'TRANSFER_ENTITLEMENT_EXCEEDED',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_CLOSURE_INCOMPLETE',
  'TRANSFER_KIND_UNSUPPORTED',
  'TRANSFER_STATE',
])

/** 事务级 advisory lock（与 packages/auth 相同的 hashtextextended 键空间） */
export const xactLock = (tx: Tx, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)

/** uuid[] 参数：整列表作为一个数组字面量参数传入，不受参数个数上限影响（id 已校验） */
export const uuidList = (ids: readonly string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`

/** text[] 参数（ID 映射键、名称等），逐项加引号转义 */
export const textList = (values: readonly string[]): SQL =>
  sql`${`{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`}::text[]`
