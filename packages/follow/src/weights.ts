import {
  type Database,
  recommendation,
  recommendationLabel,
  SELECTION_DIMENSIONS,
  type SelectionDimension,
  scoped,
  type WeightSuggestion,
  weightSuggestion,
} from '@product-res/db'
import {
  DIMENSIONS,
  type DimensionId,
  type FitSample,
  fitWeights,
  type SampleKind,
} from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { and, eq, type SQL } from 'drizzle-orm'
import { appendScoringSetting, currentScoringSetting, toScoringSettings } from './settings.ts'
import { PRIMARY_WINDOW } from './validation.ts'

/**
 * 权重拟合建议（design D5，tasks 3.2）：用 T+30 标签与冻结时的 7 维分数做 L2 逻辑回归，
 * 写入 weight_suggestion；只有团队“采用”后才追加新的评分设置版本，“忽略”不改设置。
 */

export type ProposeResult =
  | { readonly ok: true; readonly suggestion: WeightSuggestion }
  | { readonly ok: false; readonly effectiveSamples: number; readonly reason: string }

/** 冻结快照中的维度分数 */
function frozenScores(
  inputs: Record<string, unknown>,
): Partial<Record<DimensionId, number | null>> {
  const dims = (inputs.dimensions ?? {}) as Record<string, { score?: unknown } | undefined>
  const out: Partial<Record<DimensionId, number | null>> = {}
  for (const id of DIMENSIONS) {
    const score = dims[id]?.score
    out[id] = typeof score === 'number' && Number.isFinite(score) ? score : null
  }
  return out
}

/** 拟合样本：有 T+30 标签的推荐（数据不足的由 fitWeights 排除） */
export async function fitSamples(db: Database, workspaceId: string): Promise<FitSample[]> {
  const s = scoped(db, workspaceId)
  const rows = await s
    .select(recommendationLabel, {
      where: eq(recommendationLabel.windowDays, PRIMARY_WINDOW),
      fields: {
        outcome: recommendationLabel.outcome,
        inputs: recommendation.inputs,
        kind: recommendation.sampleKind,
      },
    })
    .innerJoin(
      recommendation,
      and(eq(recommendation.id, recommendationLabel.recommendationId), s.filter(recommendation)),
    )
  return rows.map((r) => ({
    scores: frozenScores(r.inputs),
    outcome: r.outcome,
    kind: r.kind as SampleKind,
  }))
}

/** 拟合并保存一条建议；有效样本不足等情况返回原因，不写库 */
export async function proposeWeights(db: Database, workspaceId: string): Promise<ProposeResult> {
  const setting = await currentScoringSetting(db, workspaceId)
  const settings = toScoringSettings(setting)
  const fit = fitWeights(await fitSamples(db, workspaceId), { settings })
  if (!fit.ok) return { ok: false, effectiveSamples: fit.effectiveSamples, reason: fit.reason }
  const [row] = await scoped(db, workspaceId)
    .insert(weightSuggestion, {
      sampleCount: Math.round(fit.effectiveSamples),
      suggestedWeights: { ...fit.suggestion.weights } as Record<SelectionDimension, number>,
      currentWeights: { ...settings.weights } as Record<SelectionDimension, number>,
      metrics: {
        baseVersion: setting.version,
        effectiveSamples: fit.effectiveSamples,
        crossValidation: fit.crossValidation,
        current: fit.current,
        perPointEffects: fit.suggestion.perPointEffects,
        missingEffects: fit.suggestion.missingEffects,
        iterations: fit.iterations,
        converged: fit.converged,
      },
    })
    .returning()
  return { ok: true, suggestion: row as WeightSuggestion }
}

const notProposed = () =>
  new AppError('SUGGESTION_RESOLVED', '这条建议已被采用或忽略', { status: 409 })

/** 只把仍为 proposed 的建议改为指定状态；并发处理时后到者得到 409 */
async function resolve(
  db: Database,
  workspaceId: string,
  id: string,
  status: 'accepted' | 'dismissed',
  userId: string | null,
  now: Date,
): Promise<WeightSuggestion> {
  const s = scoped(db, workspaceId)
  await s.findById(weightSuggestion, id)
  const [row] = await s
    .update(
      weightSuggestion,
      { status, resolvedBy: userId, resolvedAt: now },
      and(eq(weightSuggestion.id, id), eq(weightSuggestion.status, 'proposed')) as SQL,
    )
    .returning()
  if (!row) throw notProposed()
  return row
}

/**
 * 采用建议：以建议权重追加新的评分设置版本（反向维度、门槛等沿用当前版本），
 * 并在建议的 metrics.acceptedVersion 记下新版本号（准备度据此判断“权重已校准”）。
 */
export async function acceptSuggestion(
  db: Database,
  workspaceId: string,
  id: string,
  userId: string | null = null,
  now: Date = new Date(),
): Promise<{ suggestion: WeightSuggestion; version: number }> {
  const claimed = await resolve(db, workspaceId, id, 'accepted', userId, now)
  try {
    const current = await currentScoringSetting(db, workspaceId)
    const weights = Object.fromEntries(
      SELECTION_DIMENSIONS.map((d) => [d, Number(claimed.suggestedWeights[d] ?? 0)]),
    ) as Record<SelectionDimension, number>
    const setting = await appendScoringSetting(
      db,
      workspaceId,
      {
        weights,
        reverseDimensions: SELECTION_DIMENSIONS.filter((d) =>
          current.reverseDimensions.includes(d),
        ),
        vetoThreshold: current.vetoThreshold,
        minDimensions: current.minDimensions,
        hardGates: current.hardGates,
        marginFloorBp: current.marginFloorBp,
      },
      userId,
    )
    const [suggestion] = await scoped(db, workspaceId)
      .update(
        weightSuggestion,
        { metrics: { ...claimed.metrics, acceptedVersion: setting.version } },
        eq(weightSuggestion.id, id),
      )
      .returning()
    return { suggestion: suggestion as WeightSuggestion, version: setting.version }
  } catch (error) {
    // 生成版本失败时把建议退回待处理，避免出现“已采用但没有新版本”
    await scoped(db, workspaceId).update(
      weightSuggestion,
      { status: 'proposed', resolvedBy: null, resolvedAt: null },
      eq(weightSuggestion.id, id),
    )
    throw error
  }
}

/** 忽略建议：只改建议状态，评分设置不变 */
export function dismissSuggestion(
  db: Database,
  workspaceId: string,
  id: string,
  userId: string | null = null,
  now: Date = new Date(),
): Promise<WeightSuggestion> {
  return resolve(db, workspaceId, id, 'dismissed', userId, now)
}
