import {
  DEFAULT_SCORING_SETTING,
  LEAD_GRADES,
  type ScoringHardGates,
  SELECTION_DIMENSIONS,
} from '@product-res/db'
import { DEFAULT_SCORING_SETTINGS, DIMENSIONS, GRADE_LABELS } from '@product-res/selection'
import { describe, expect, it } from 'vitest'
import { GRADE_FROM_DB, GRADE_TO_DB } from '../src/mapping.ts'
import { marginFromBp, marginToBp, toScoringSettings } from '../src/settings.ts'

// db 不能依赖 selection，两边手抄的列表在这里核对（docs/plan/blockers.md D1b）
describe('db 与 selection 的取值一致', () => {
  it('维度名与顺序一致', () => {
    expect([...SELECTION_DIMENSIONS]).toEqual([...DIMENSIONS])
  })

  it('硬门槛键一致', () => {
    const dbGates: ScoringHardGates = DEFAULT_SCORING_SETTING.hardGates
    expect(Object.keys(dbGates).sort()).toEqual(Object.keys(DEFAULT_SCORING_SETTINGS.gates).sort())
  })

  it('等级一一对应', () => {
    const grades = Object.keys(GRADE_LABELS).filter((g) => g !== 'unverified')
    expect(Object.keys(GRADE_TO_DB).sort()).toEqual(grades.sort())
    expect(Object.values(GRADE_TO_DB).sort()).toEqual([...LEAD_GRADES].sort())
    for (const [grade, value] of Object.entries(GRADE_TO_DB))
      expect(GRADE_FROM_DB[value]).toBe(grade)
  })

  it('db 默认设置换算后与 selection 默认设置相同（毛利底线 1500bp = 0.15）', () => {
    expect(toScoringSettings({ version: 1, ...DEFAULT_SCORING_SETTING })).toEqual(
      DEFAULT_SCORING_SETTINGS,
    )
  })

  it('基点换算', () => {
    expect(marginFromBp(1500)).toBe(0.15)
    expect(marginToBp(0.15)).toBe(1500)
    expect(marginToBp(0.1234)).toBe(1234)
  })
})
