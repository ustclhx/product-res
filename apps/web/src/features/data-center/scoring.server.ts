import type { ScoringSetting, SelectionDimension } from '@product-res/db'
import {
  appendScoringSetting,
  getValidationOverview,
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
  const [versions, overview] = await Promise.all([
    listScoringSettings(actor.db, actor.workspaceId),
    getValidationOverview(actor.db, actor.workspaceId),
  ])
  const [current] = versions
  // 回测命中率：按信号类型（主导维度）汇总的 T+30 加权命中率与 Wilson 下界（add-shadow-validation 4.1）
  const hitRates = new Map(overview.bySignalType.map((h) => [h.signalType, h]))
  if (!current) throw new Error('scoring setting missing')
  return {
    current: versionRow(current),
    history: versions.map((v) => ({
      version: v.version,
      effectiveAt: v.effectiveAt.toISOString(),
    })),
    dimensions: DIMENSIONS.map((id) => {
      const h = hitRates.get(id)
      return {
        id,
        label: DIMENSION_LABELS[id],
        backtest:
          h && h.effectiveSamples > 0
            ? {
                effectiveSamples: h.effectiveSamples,
                hitRate: h.hitRate,
                wilsonLower: h.wilsonLower,
                replaySamples: h.replaySamples,
              }
            : null,
      }
    }),
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
