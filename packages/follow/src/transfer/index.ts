// 跨空间数据流转（openspec/changes/add-workspace-data-transfer）；当前只有注册表声明，执行逻辑在后续任务中加入
export {
  FLOWING_TRANSFER_TABLES,
  flowingTransferTable,
  STATIC_TRANSFER_TABLES,
  TRANSFER_ROOTS,
  TRANSFER_TABLES,
  transferTablesInBatch,
} from './registry.ts'
export * from './types.ts'
