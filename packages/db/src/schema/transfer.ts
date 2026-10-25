import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { organization } from './tenancy.ts'

/**
 * 跨空间数据流转（openspec/changes/add-workspace-data-transfer design D7、D8）。
 *
 * 一次流转同时关联源与目标两个空间，因此刻意不用 `workspace_id` 列名：这些表不经 `scoped()`，
 * 也不在 packages/db/lint 的空间表清单中；只由流转服务访问，服务在入口与每个批次开始时
 * 显式校验两边的成员关系（与 eBay 账号删除这类跨空间操作同样说明理由）。
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** upgrade：个人空间整体移到新团队空间；copy / move：选中条目及其依赖闭包 */
export const WORKSPACE_TRANSFER_KINDS = ['upgrade', 'copy', 'move'] as const
export type WorkspaceTransferKind = (typeof WORKSPACE_TRANSFER_KINDS)[number]
export const WORKSPACE_TRANSFER_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'compensating',
  'compensated',
  'cancelled',
] as const
export type WorkspaceTransferStatus = (typeof WORKSPACE_TRANSFER_STATUSES)[number]
/** 进行中的状态：两个空间对工作台只读（D8 流转锁），每个空间同时最多一条 */
export const WORKSPACE_TRANSFER_ACTIVE_STATUSES = ['pending', 'running', 'compensating'] as const
export const WORKSPACE_TRANSFER_BATCH_STATUSES = ['pending', 'done', 'compensated'] as const
export type WorkspaceTransferBatchStatus = (typeof WORKSPACE_TRANSFER_BATCH_STATUSES)[number]
/**
 * planned：plan 步骤算出的闭包清单（D2），批次只处理清单内的行；
 * 其余为批次执行结果，补偿回滚据此逆序撤销（D8）。
 */
export const WORKSPACE_TRANSFER_ID_MAP_ACTIONS = [
  'planned',
  'moved',
  'copied',
  'merged',
  'skipped',
  'renamed',
] as const
export type WorkspaceTransferIdMapAction = (typeof WORKSPACE_TRANSFER_ID_MAP_ACTIONS)[number]

/** 按表计数：表名 → 动作 → 行数 */
export type WorkspaceTransferCounts = Record<string, Partial<Record<string, number>>>

const activeStatuses = sql.raw(
  WORKSPACE_TRANSFER_ACTIVE_STATUSES.map((status) => `'${status}'`).join(', '),
)

export const workspaceTransfer = pgTable(
  'workspace_transfer',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    kind: text('kind', { enum: WORKSPACE_TRANSFER_KINDS }).notNull(),
    sourceWorkspaceId: uuid('source_workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    targetWorkspaceId: uuid('target_workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    // 用户删号只做匿名化，不删除 user 行，与 audit_log.actor_user_id 相同用 restrict
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** 客户端打开对话框时生成；同一用户重复提交返回同一流转 */
    idempotencyKey: text('idempotency_key').notNull(),
    /** 根条目与冲突选项 */
    selection: jsonb('selection').$type<Record<string, unknown>>().notNull().default({}),
    /** 闭包统计、冲突预览、评分版本快照；plan 步骤写入 */
    plan: jsonb('plan').$type<Record<string, unknown>>(),
    status: text('status', { enum: WORKSPACE_TRANSFER_STATUSES }).notNull().default('pending'),
    counts: jsonb('counts').$type<WorkspaceTransferCounts>().notNull().default({}),
    errorCode: text('error_code'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('workspace_transfer_idempotency_idx').on(t.requestedBy, t.idempotencyKey),
    // 每个空间同时最多一个进行中的流转，作为源或目标分别约束
    uniqueIndex('workspace_transfer_active_source_idx')
      .on(t.sourceWorkspaceId)
      .where(sql`${t.status} in (${activeStatuses})`),
    uniqueIndex('workspace_transfer_active_target_idx')
      .on(t.targetWorkspaceId)
      .where(sql`${t.status} in (${activeStatuses})`),
    index('workspace_transfer_source_idx').on(t.sourceWorkspaceId, t.createdAt.desc()),
    index('workspace_transfer_target_idx').on(t.targetWorkspaceId, t.createdAt.desc()),
    check(
      'workspace_transfer_distinct_workspaces',
      sql`${t.sourceWorkspaceId} <> ${t.targetWorkspaceId}`,
    ),
  ],
)

/** 流转批次：每批一个数据库事务；done 的批次在重试与续跑时跳过 */
export const workspaceTransferBatch = pgTable(
  'workspace_transfer_batch',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => workspaceTransfer.id, { onDelete: 'cascade' }),
    /** 执行顺序；补偿时逆序 */
    seq: integer('seq').notNull(),
    /** 如 config、direction:<id>、store-pool；单批过大切子批时键带分页后缀 */
    batchKey: text('batch_key').notNull(),
    status: text('status', { enum: WORKSPACE_TRANSFER_BATCH_STATUSES })
      .notNull()
      .default('pending'),
    counts: jsonb('counts').$type<WorkspaceTransferCounts>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workspace_transfer_batch_key_idx').on(t.transferId, t.batchKey),
    index('workspace_transfer_batch_seq_idx').on(t.transferId, t.seq),
  ],
)

/**
 * 源行 → 目标行映射。复制时 target_id 为新 id，移动时与 source_id 相同，合并时为目标已有行；
 * 复合主键表（cluster_signal）以拼接键记录，因此 id 列用 text。
 */
export const workspaceTransferIdMap = pgTable(
  'workspace_transfer_id_map',
  {
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => workspaceTransfer.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    sourceId: text('source_id').notNull(),
    /** planned / skipped 时可为空 */
    targetId: text('target_id'),
    action: text('action', { enum: WORKSPACE_TRANSFER_ID_MAP_ACTIONS }).notNull(),
    /** 所属批次键；补偿按批次逆序撤销时据此定位 */
    batchKey: text('batch_key'),
    /** 移动合并时先保存被删除的源行，补偿回滚据此恢复（D8） */
    sourceRow: jsonb('source_row').$type<Record<string, unknown>>(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.transferId, t.tableName, t.sourceId] }),
    index('workspace_transfer_id_map_batch_idx').on(t.transferId, t.batchKey),
  ],
)

export type WorkspaceTransfer = typeof workspaceTransfer.$inferSelect
export type WorkspaceTransferBatch = typeof workspaceTransferBatch.$inferSelect
export type WorkspaceTransferIdMap = typeof workspaceTransferIdMap.$inferSelect
