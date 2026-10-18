/**
 * 跟卖选品的组合与持久化（openspec/changes/add-follow-selection design D1）：
 * 把 packages/marketdata 读出的市场数据交给 packages/selection 与 packages/risk 计算，
 * 结果写入空间级的簇、信号、线索与风险表。apps/jobs 的每日流水线与 apps/web 共用。
 */
export {
  GRADE_FROM_DB,
  GRADE_TO_DB,
  type LeadGradeValue,
  METHOD_FROM_DB,
  METHOD_TO_DB,
  type MemberMethodValue,
} from './mapping.ts'
export {
  CATALOG_SOURCE,
  type DirectionRunResult,
  localDay,
  type RunOptions,
  runSelectionDaily,
  runSelectionForWorkspace,
  SELECTION_TIME_ZONE,
  type WorkspaceRunResult,
} from './pipeline.ts'
export {
  appendScoringSetting,
  BP_PER_UNIT,
  currentScoringSetting,
  listScoringSettings,
  marginFromBp,
  marginToBp,
  type ScoringSettingInput,
  toScoringSettings,
  validateScoringInput,
} from './settings.ts'
