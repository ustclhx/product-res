import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'

/**
 * 流转注册表的类型（openspec/changes/add-workspace-data-transfer design D2–D4、D8）。
 * 注册表只做声明，plan / 批次 / 补偿按这里的分类、闭包、冲突策略与引用列执行。
 */

/** 批次顺序（D8）：配置 → 方向 → 店铺池 → 追踪商品 → 品类研究 → 验证 / 抽检（仅升级） */
export const TRANSFER_BATCH_ORDER = [
  'config',
  'direction',
  'store-pool',
  'tracked-product',
  'category-study',
  'validation',
] as const
export type TransferBatch = (typeof TRANSFER_BATCH_ORDER)[number]

/**
 * 选择性复制 / 移动时，表中的行因何进入流转：
 * - closure：属于被选根条目的依赖闭包（D2），随根一起流转；
 * - referenced：被闭包内的行引用的配置，在目标中按冲突策略落地（复制或合并）；
 * - config-pack：用户选择“空间配置包”时整表流转。
 * 升级（upgrade）不看触发方式，整表移动。
 */
export type TransferTrigger = 'closure' | 'referenced' | 'config-pack'

/** 唯一约束的作用域：含 workspace_id 的才可能与目标空间已有行冲突（D4），其余随父 id 天然唯一 */
export type UniqueScope = 'workspace' | 'parent'

export interface TransferUnique {
  /** 唯一索引名或复合主键名，测试按 schema 核对 */
  readonly name: string
  readonly scope: UniqueScope
}

/** 自然键：冲突检测与无唯一约束表的去重依据 */
export interface TransferNaturalKey {
  readonly columns: readonly AnyPgColumn[]
  /** 按 coalesce(列, '') 比较的可空列 */
  readonly nullAsEmpty?: readonly AnyPgColumn[]
  /** 由该唯一索引保证；省略表示没有唯一约束，只在流转时按自然键去重（D4.8） */
  readonly uniqueIndex?: string
}

/** 与目标空间已有行冲突时的处理（D4）；默认值在预览中展示给用户 */
export type TransferConflict =
  /** 没有可能与目标冲突的唯一键：唯一键随父 id，或只在升级时流转且目标为空 */
  | { readonly kind: 'none' }
  /** 重命名为“名称（来自 <源空间名>）”，再冲突追加序号；alternatives 为用户可改选的策略 */
  | {
      readonly kind: 'rename'
      readonly column: AnyPgColumn
      readonly alternatives: readonly 'merge'[]
    }
  /** 合并到目标已有行（目标为准），引用改指目标 id；unionColumns 取并集 */
  | {
      readonly kind: 'merge'
      readonly unionColumns?: readonly AnyPgColumn[]
      readonly note?: string
    }
  /** compare 列完全一致时合并，否则按 renameColumn 重命名 */
  | {
      readonly kind: 'merge-if-equal'
      readonly compare: readonly AnyPgColumn[]
      readonly renameColumn: AnyPgColumn
    }
  /** 保留目标、跳过源行，并在流转报告中标出 */
  | { readonly kind: 'keep-target' }

/**
 * 引用列的形态：
 * - fk：外键列；
 * - uuid-array：不受外键约束的 uuid[]（direction.node_ids、tracked_store.direction_ids）；
 * - loose-uuid：不受外键约束的单个 uuid（origin_ref、merged_into_id）；
 * - text-ref：文本列中可能存放的行 id（risk_finding.ref 为规则 id 时）。
 */
export type TransferReferenceKind = 'fk' | 'uuid-array' | 'loose-uuid' | 'text-ref'

/**
 * 被引用行不在本次流转的 ID 映射中时（D4）：
 * - fail：闭包保证一定映射得到，映射不到即实现错误，批次失败；
 * - drop-element：从数组中删除；
 * - set-null：置空；
 * - keep：原样保留（如 risk_finding.ref 为品牌名等非 id 内容）。
 */
export type TransferUnmapped = 'fail' | 'drop-element' | 'set-null' | 'keep'

/** 需要按 ID 映射重写的引用列：复制时全部重写；移动时只有冲突合并的行会改指目标 id */
export interface TransferReference {
  readonly column: AnyPgColumn
  readonly kind: TransferReferenceKind
  /** 被引用的流转表（SQL 表名） */
  readonly targets: readonly string[]
  /** 父子关系：子行随父行进入闭包，父先子后插入、子先父后撤销 */
  readonly closure?: true
  readonly unmapped: TransferUnmapped
  readonly note?: string
}

/** 不重写的引用：部署级市场数据、用户、评分版本号、jsonb 历史快照等 */
export interface TransferPreserved {
  readonly column: AnyPgColumn
  readonly reason: string
}

/** 参与流转的表 */
export interface FlowingTransferTable {
  readonly name: string
  readonly table: PgTable
  /** packages/db/src/schema 下的文件名（不含扩展名） */
  readonly file: string
  readonly flow: 'flowing'
  readonly batch: TransferBatch
  /** 选择性移动时的触发方式；为空表示只在升级时移动 */
  readonly move: readonly TransferTrigger[]
  /** 复制时的触发方式；为空表示不复制 */
  readonly copy: readonly TransferTrigger[]
  readonly uniques: readonly TransferUnique[]
  readonly naturalKey?: TransferNaturalKey
  readonly conflict: TransferConflict
  readonly references: readonly TransferReference[]
  readonly preserved: readonly TransferPreserved[]
  readonly note?: string
}

/** 不流转的表：带空间列（workspace）或经其他表 / 字段间接关联空间（indirect） */
export interface StaticTransferTable {
  readonly name: string
  readonly table: PgTable
  readonly file: string
  readonly flow: 'none'
  readonly link: 'workspace' | 'indirect'
  readonly reason: string
}

export type TransferTable = FlowingTransferTable | StaticTransferTable
