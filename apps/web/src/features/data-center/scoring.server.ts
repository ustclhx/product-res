import type { ScoringSetting, SelectionDimension } from '@product-res/db'
import {
  appendScoringSetting,
  listScoringSettings,
  type ScoringSettingInput,
} from '@product-res/follow'
import { DIMENSION_LABELS, DIMENSIONS } from '@product-res/selection'
import { assertWorkbenchWriter, canWriteWorkbench } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'

/**
 * 数据中心“评分维度管理”（specs/selection-scoring「评分设置版本」）：
 * 展示当前版本，保存时追加新版本（只追加，不改旧版本），已有线索保留生成时的版本号与分数。
 */

const versionRow = (row: ScoringSetting) => ({
  version: row.version,
  weights: row.weights,
  reverseDimensions: row.reverseDimensions as SelectionDimension[],
  vetoThreshold: row.vetoThreshold,
  minDimensions: row.minDimensions,
  hardGates: row.hardGates,
  marginFloorBp: row.marginFloorBp,
  effectiveAt: row.effectiveAt.toISOString(),
})

export async function scoringPage(actor: WorkbenchActor) {
  const versions = await listScoringSettings(actor.db, actor.workspaceId)
  const [current] = versions
  if (!current) throw new Error('scoring setting missing')
  return {
    current: versionRow(current),
    history: versions.map((v) => ({
      version: v.version,
      effectiveAt: v.effectiveAt.toISOString(),
    })),
    dimensions: DIMENSIONS.map((id) => ({ id, label: DIMENSION_LABELS[id] })),
    canWrite: canWriteWorkbench(actor),
  }
}

export async function saveScoring(
  actor: WorkbenchActor,
  input: ScoringSettingInput,
  userId?: string | null,
) {
  assertWorkbenchWriter(actor)
  return versionRow(await appendScoringSetting(actor.db, actor.workspaceId, input, userId))
}
