// 跨空间数据流转（openspec/changes/add-workspace-data-transfer）：注册表与流转服务。
// 经 @product-res/follow/transfer 单独导出：注册表在加载时引用全部 schema 表，放进主入口会让
// 只 mock 部分 @product-res/db 的测试（如 apps/jobs node-entry）失败。
// 服务函数的参数与返回值都可 JSON 序列化，供 Workflow 逐步调用：
// startUpgrade / startMove → planTransfer → runBatch（逐批）→ finalizeTransfer；
// 失败或取消时 beginCompensation → compensateBatch（逆序）→ completeCompensation（或 compensateTransfer）。
export { assertTransferAccess, lockTransferWorkspaces } from './access.ts'
export { type BatchResult, runBatch, type SourceRowSnapshot, touchesSellerData } from './batch.ts'
export {
  type DirectionConflictStrategy,
  NON_RETRYABLE_TRANSFER_ERRORS,
  parseSelection,
  TRANSFER_COPY_ROW_LIMIT,
  TRANSFER_QUOTA_WARN_CALLS,
  TRANSFER_SUB_BATCH_ROWS,
  type TransferConfig,
  type TransferRoots,
  type TransferSelection,
} from './common.ts'
export {
  beginCompensation,
  type CompensationResult,
  compensateBatch,
  compensateTransfer,
  completeCompensation,
  type FinalizeResult,
  finalizeTransfer,
  listTransferBatches,
  type TransferBatchState,
} from './lifecycle.ts'
export {
  compareBatchKeys,
  type EntitlementViolation,
  type PlanOptions,
  planTransfer,
  type TransferConflictDecision,
  type TransferEntitlementCheck,
  type TransferPlan,
  type TransferPlanBatch,
} from './plan.ts'
export type { QuotaEstimate } from './quota.ts'
export {
  FLOWING_TRANSFER_TABLES,
  flowingTransferTable,
  STATIC_TRANSFER_TABLES,
  TRANSFER_ROOTS,
  TRANSFER_TABLES,
  transferTablesInBatch,
} from './registry.ts'
export {
  type StartHooks,
  type StartMoveInput,
  type StartResult,
  type StartUpgradeInput,
  startMove,
  startUpgrade,
} from './start.ts'
export * from './types.ts'
