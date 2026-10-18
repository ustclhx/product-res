import type {
  getDataCenter,
  getImports,
  getQualityIssues,
  getSyncRuns,
} from './data-center.functions.ts'

export type DataCenterData = Awaited<ReturnType<typeof getDataCenter>>
export type SyncRunRow = Awaited<ReturnType<typeof getSyncRuns>>[number]
export type QualityIssueRow = Awaited<ReturnType<typeof getQualityIssues>>[number]
export type ImportsData = Awaited<ReturnType<typeof getImports>>
