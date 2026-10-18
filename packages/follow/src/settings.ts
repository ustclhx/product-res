import {
  type Database,
  ensureSelectionDefaults,
  type ScoringHardGates,
  type ScoringSetting,
  SELECTION_DIMENSIONS,
  type SelectionDimension,
  scoped,
  scoringSetting,
} from '@product-res/db'
import { DIMENSIONS, type DimensionId, type ScoringSettings } from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { desc } from 'drizzle-orm'

/**
 * 评分设置版本（specs/selection-scoring「评分设置版本」）：只追加，每次修改生成新版本；
 * 线索记录生成时所用的版本号，所以修改不影响已有线索。
 */

/** 毛利底线在库中以基点保存（1500 = 15%），packages/selection 使用 0–1 小数 */
export const BP_PER_UNIT = 10_000
export const marginFromBp = (bp: number) => bp / BP_PER_UNIT
export const marginToBp = (margin: number) => Math.round(margin * BP_PER_UNIT)

/** 库中的维度名是 db 包手抄的列表（db 不能依赖 selection），这里收窄为 selection 的类型 */
const isDimension = (value: string): value is DimensionId =>
  (DIMENSIONS as readonly string[]).includes(value)

export function toScoringSettings(
  row: Pick<
    ScoringSetting,
    | 'version'
    | 'weights'
    | 'reverseDimensions'
    | 'vetoThreshold'
    | 'minDimensions'
    | 'marginFloorBp'
    | 'hardGates'
  >,
): ScoringSettings {
  const weights = Object.fromEntries(
    DIMENSIONS.map((d) => [d, Number(row.weights[d as SelectionDimension] ?? 0)]),
  ) as Record<DimensionId, number>
  return {
    version: row.version,
    weights,
    reversed: row.reverseDimensions.filter(isDimension),
    vetoThreshold: row.vetoThreshold,
    minDimensions: row.minDimensions,
    marginFloor: marginFromBp(row.marginFloorBp),
    gates: {
      compliance: row.hardGates.compliance,
      timing: row.hardGates.timing,
      margin: row.hardGates.margin,
    },
  }
}

export interface ScoringSettingInput {
  readonly weights: Readonly<Record<SelectionDimension, number>>
  readonly reverseDimensions: readonly SelectionDimension[]
  readonly vetoThreshold: number
  readonly minDimensions: number
  readonly hardGates: ScoringHardGates
  readonly marginFloorBp: number
}

const invalid = (message: string) =>
  new AppError('INVALID_SCORING_SETTING', message, { status: 400 })

export function validateScoringInput(input: ScoringSettingInput): void {
  let total = 0
  for (const dimension of SELECTION_DIMENSIONS) {
    const weight = input.weights[dimension]
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 100)
      throw invalid('权重需要是 0–100 之间的数字')
    total += weight
  }
  if (total <= 0) throw invalid('至少一个维度的权重大于 0')
  if (input.reverseDimensions.some((d) => !SELECTION_DIMENSIONS.includes(d)))
    throw invalid('反向维度不存在')
  if (
    !Number.isInteger(input.vetoThreshold) ||
    input.vetoThreshold < 0 ||
    input.vetoThreshold > 100
  )
    throw invalid('否决阈值需要是 0–100 的整数')
  if (
    !Number.isInteger(input.minDimensions) ||
    input.minDimensions < 1 ||
    input.minDimensions > SELECTION_DIMENSIONS.length
  )
    throw invalid(`最少维度数需要是 1–${SELECTION_DIMENSIONS.length} 的整数`)
  if (
    !Number.isInteger(input.marginFloorBp) ||
    input.marginFloorBp < 0 ||
    input.marginFloorBp > BP_PER_UNIT
  )
    throw invalid('毛利底线需要在 0%–100% 之间')
}

/** 本空间全部版本，新版本在前；首次使用时写入默认设置版本 1 */
export async function listScoringSettings(
  db: Database,
  workspaceId: string,
): Promise<ScoringSetting[]> {
  await ensureSelectionDefaults(db, workspaceId)
  return scoped(db, workspaceId).select(scoringSetting).orderBy(desc(scoringSetting.version))
}

/** 当前生效版本（版本号最大的一条） */
export async function currentScoringSetting(
  db: Database,
  workspaceId: string,
): Promise<ScoringSetting> {
  await ensureSelectionDefaults(db, workspaceId)
  const [row] = await scoped(db, workspaceId)
    .select(scoringSetting)
    .orderBy(desc(scoringSetting.version))
    .limit(1)
  if (!row) throw new Error('scoring setting missing after ensureSelectionDefaults')
  return row
}

const isUniqueViolation = (error: unknown): boolean => {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true
  }
  return false
}

/**
 * 追加新版本：版本号 = 当前最大 + 1，不修改任何旧版本。
 * 两人同时保存时唯一索引让后到者冲突，重读最大版本后重试。
 */
export async function appendScoringSetting(
  db: Database,
  workspaceId: string,
  input: ScoringSettingInput,
  createdBy?: string | null,
): Promise<ScoringSetting> {
  validateScoringInput(input)
  for (let attempt = 0; ; attempt += 1) {
    const current = await currentScoringSetting(db, workspaceId)
    try {
      const [row] = await scoped(db, workspaceId)
        .insert(scoringSetting, {
          version: current.version + 1,
          weights: { ...input.weights },
          reverseDimensions: SELECTION_DIMENSIONS.filter((d) =>
            input.reverseDimensions.includes(d),
          ),
          vetoThreshold: input.vetoThreshold,
          minDimensions: input.minDimensions,
          hardGates: { ...input.hardGates },
          marginFloorBp: input.marginFloorBp,
          createdBy: createdBy ?? null,
        })
        .returning()
      return row as ScoringSetting
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 2) throw error
    }
  }
}
