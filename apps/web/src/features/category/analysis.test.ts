import { AppError } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import { buildInsightPrompt } from './ai.ts'
import {
  ANALYSIS_TTL_MS,
  activeAnalysis,
  analysisOutcome,
  newAnalysisJob,
  type PendingAnalysis,
  runningState,
  withAnalysisExpiry,
} from './analysis.server.ts'
import type { SnapshotModules } from './types.ts'

// add-insight-background-analysis：后台分析的结果映射与过期判断
const NOW = new Date('2026-10-19T08:00:00Z')
const review = (id: string) => ({
  id,
  productId: 'p',
  rating: 2,
  title: 't',
  body: `body ${id}`,
  truncated: false,
  sourceId: 'import',
})
const reviews = [review('rev-a'), review('rev-b')]
const pending: PendingAnalysis = {
  job: newAnalysisJob('fp', 'model-x', NOW),
  input: buildInsightPrompt(reviews, [
    { id: 'prod-1', title: 'Feeder', brand: null, price: null, rating: null, salesMonthly: null },
  ]),
  generate: async () => '',
  reviewPool: reviews.map(({ truncated: _t, ...r }) => r),
}
const modules = (job = pending.job) =>
  ({
    painPoints: { terms: { status: 'no-source', reason: '' }, themes: runningState(job) },
    suggestions: runningState(job),
  }) as unknown as SnapshotModules

describe('analysisOutcome', () => {
  it('成功：主题与建议带本次分析的模型与指纹，只保存被引用的评论', () => {
    const out = analysisOutcome(
      pending,
      {
        text: JSON.stringify({
          themes: [{ label: '打滑', reviewIds: ['R1'] }],
          suggestions: [{ title: '防滑', detail: '', citations: ['R1', 'P1'] }],
        }),
      },
      NOW,
    )
    expect(out.themes).toMatchObject({ status: 'ok', analyzed: 2 })
    expect(out.suggestions).toMatchObject({
      status: 'ok',
      ai: { modelKey: 'model-x', fingerprint: 'fp', reusedFrom: null },
    })
    expect(Object.keys(out.reviews)).toEqual(['rev-a'])
  })

  it('失败带机器可读的 code', () => {
    expect(analysisOutcome(pending, { text: 'oops' }, NOW).themes).toMatchObject({
      status: 'error',
      code: 'INVALID_OUTPUT',
    })
    const credits = new AppError('INSUFFICIENT_CREDITS', 'x', { status: 402 })
    expect(analysisOutcome(pending, { error: credits }, NOW).suggestions).toMatchObject({
      status: 'error',
      code: 'INSUFFICIENT_CREDITS',
      reason: '积分不足，未生成 AI 分析',
    })
    expect(analysisOutcome(pending, { error: new Error('boom') }, NOW).themes).toMatchObject({
      status: 'error',
      code: 'AI_FAILED',
    })
  })
})

describe('过期', () => {
  it('过期前是在途分析，过期后读取为 ANALYSIS_EXPIRED 且不再算在途', () => {
    const m = modules()
    expect(activeAnalysis(m, NOW)?.id).toBe(pending.job.id)
    expect(withAnalysisExpiry(m, NOW)).toBe(m)
    const later = new Date(NOW.getTime() + ANALYSIS_TTL_MS)
    expect(activeAnalysis(m, later)).toBeNull()
    const expired = withAnalysisExpiry(m, later)
    expect(expired.painPoints.themes).toMatchObject({ status: 'error', code: 'ANALYSIS_EXPIRED' })
    expect(expired.suggestions).toMatchObject({ status: 'error', code: 'ANALYSIS_EXPIRED' })
  })
})
