// 跨空间数据流转（openspec/changes/add-workspace-data-transfer）；当前只有注册表声明。
// 经 @product-res/follow/transfer 单独导出：注册表在加载时引用全部 schema 表，放进主入口会让
// 只 mock 部分 @product-res/db 的测试（如 apps/jobs node-entry）失败。
export {
  FLOWING_TRANSFER_TABLES,
  flowingTransferTable,
  STATIC_TRANSFER_TABLES,
  TRANSFER_ROOTS,
  TRANSFER_TABLES,
  transferTablesInBatch,
} from './registry.ts'
export * from './types.ts'
