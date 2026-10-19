import { CHAT_HOLD_TTL_MS } from '@product-res/ai'
import { categoryStudySnapshot, type Database, scoped } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { eq } from 'drizzle-orm'
import { type AiPrompt, InsightOutputError, type InsightPrompt, parseInsightOutput } from './ai.ts'
import type { AiAnalysisJob, AiMeta, AiRunning, ReviewView, SnapshotModules } from './types.ts'

/**
 * 差评痛点与差异化建议的后台分析（openspec/changes/add-insight-background-analysis）。
 * 生产经 Cloudflare Tunnel 接入，边缘读超时约 100 秒；模型生成可能更久，因此生成 / 刷新只把快照写成“分析中”
 * 并立即返回，模型调用在请求之外完成（仍走 startWorkspaceChat 的同一条计费链路），结果原地写回同一份快照。
 */

/**
 * 分析过期时间：模型流在 CHAT_HOLD_TTL_MS 时被截止并结算，再留 2 分钟给结算与写回。
 * 超过后仍是“分析中”说明进程中断或写回失败，按 ANALYSIS_EXPIRED 显示，允许重新刷新。
 */
export const ANALYSIS_TTL_MS = CHAT_HOLD_TTL_MS + 2 * 60_000
export const ANALYSIS_EXPIRED = 'ANALYSIS_EXPIRED'
export const ANALYSIS_RUNNING_REASON = 'AI 正在后台分析差评与竞品，完成后自动显示'
export const ANALYSIS_EXPIRED_REASON = 'AI 分析超时未完成，请用最新数据刷新重试'

/** 需要后台执行的分析：在快照写入（事务提交）之后交给 runAnalysis */
export interface PendingAnalysis {
  job: AiAnalysisJob
  input: InsightPrompt
  generate(prompt: AiPrompt): Promise<string>
  /** 交给模型的差评原文，用于写回被引用的评论 */
  reviewPool: ReviewView[]
}

/** 请求结束后继续执行的后台任务（Node 进程停机时会等待排空，见 BackgroundTasks） */
export type AnalysisBackground = (run: () => Promise<void>) => void

export function newAnalysisJob(fingerprint: string, modelKey: string, now: Date): AiAnalysisJob {
  return {
    id: newId(),
    fingerprint,
    modelKey,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ANALYSIS_TTL_MS).toISOString(),
  }
}

export function runningState(job: AiAnalysisJob): AiRunning {
  return { status: 'running', reason: ANALYSIS_RUNNING_REASON, job }
}

/** 快照上尚未过期的在途分析；没有或已过期时返回 null */
export function activeAnalysis(modules: SnapshotModules, now: Date): AiAnalysisJob | null {
  const themes = modules.painPoints.themes
  if (themes.status !== 'running') return null
  return Date.parse(themes.job.expiresAt) > now.getTime() ? themes.job : null
}

/** 读取时把过期的“分析中”显示为失败（ANALYSIS_EXPIRED）；存储不变，迟到的结果仍可写回 */
export function withAnalysisExpiry(modules: SnapshotModules, now: Date): SnapshotModules {
  const expired = (m: { status: string }) =>
    m.status === 'running' && Date.parse((m as AiRunning).job.expiresAt) <= now.getTime()
  const failed = {
    status: 'error' as const,
    code: ANALYSIS_EXPIRED,
    reason: ANALYSIS_EXPIRED_REASON,
  }
  if (!expired(modules.painPoints.themes) && !expired(modules.suggestions)) return modules
  return {
    ...modules,
    painPoints: {
      ...modules.painPoints,
      themes: expired(modules.painPoints.themes) ? failed : modules.painPoints.themes,
    },
    suggestions: expired(modules.suggestions) ? failed : modules.suggestions,
  }
}

function aiErrorReason(error: AppError): string {
  switch (error.code) {
    case 'INSUFFICIENT_CREDITS':
      return '积分不足，未生成 AI 分析'
    case 'CREDIT_DEBT':
      return '空间有未结清的积分欠费，未生成 AI 分析'
    case 'UPGRADE_REQUIRED':
      return '当前套餐不能使用该文本模型'
    case 'MODEL_UNAVAILABLE':
    case 'AI_PROVIDER_NOT_CONFIGURED':
      return 'AI 模型未配置或不可用'
    case 'RATE_LIMITED':
      return 'AI 调用过于频繁，请稍后刷新'
    default:
      return 'AI 调用失败，请稍后刷新重试'
  }
}

export interface AnalysisOutcome {
  themes: SnapshotModules['painPoints']['themes']
  suggestions: SnapshotModules['suggestions']
  /** 被主题或建议引用的评论原文 */
  reviews: Record<string, ReviewView>
}

/** 模型输出（或调用异常）→ 主题、建议与引用评论；失败带机器可读的 code */
export function analysisOutcome(
  pending: PendingAnalysis,
  result: { text: string } | { error: unknown },
  now: Date,
): AnalysisOutcome {
  try {
    if ('error' in result) throw result.error
    const parsed = parseInsightOutput(result.text, pending.input)
    const ai: AiMeta = {
      modelKey: pending.job.modelKey,
      generatedAt: now.toISOString(),
      fingerprint: pending.job.fingerprint,
      reusedFrom: null,
    }
    const pool = new Map(pending.reviewPool.map((r) => [r.id, r]))
    const reviews: Record<string, ReviewView> = {}
    const cite = (id: string) => {
      const r = pool.get(id)
      if (r) reviews[id] = r
    }
    for (const t of parsed.themes) for (const id of t.reviewIds) cite(id)
    for (const s of parsed.suggestions)
      for (const c of s.citations) if (c.kind === 'review') cite(c.id)
    return {
      themes: { status: 'ok', themes: parsed.themes, analyzed: pending.input.reviewCount, ai },
      suggestions: { status: 'ok', items: parsed.suggestions, dropped: parsed.dropped, ai },
      reviews,
    }
  } catch (error) {
    const failed =
      error instanceof InsightOutputError
        ? { code: 'INVALID_OUTPUT', reason: `${error.message}，本次未生成` }
        : error instanceof AppError
          ? { code: error.code, reason: aiErrorReason(error) }
          : { code: 'AI_FAILED', reason: 'AI 调用失败，请稍后刷新重试' }
    if (!(error instanceof InsightOutputError || error instanceof AppError))
      log.error('category.ai_failed', { jobId: pending.job.id, error })
    const state = { status: 'error' as const, ...failed }
    return { themes: state, suggestions: state, reviews: {} }
  }
}

/**
 * 后台执行一次分析并写回快照。只更新仍处于本次分析（job.id 相同）的快照，
 * 已被其他路径写入结果的快照不覆盖。本函数不抛出：失败写成 error 状态，写回失败只记日志（读取时按过期处理）。
 */
export async function runAnalysis(input: {
  db: Database
  workspaceId: string
  snapshotId: string
  pending: PendingAnalysis
  now?: () => Date
}): Promise<void> {
  const { pending } = input
  const now = input.now ?? (() => new Date())
  let result: { text: string } | { error: unknown }
  try {
    result = { text: await pending.generate(pending.input.prompt) }
  } catch (error) {
    result = { error }
  }
  const outcome = analysisOutcome(pending, result, now())
  try {
    await scoped(input.db, input.workspaceId).transaction(async (tx) => {
      const [row] = await tx
        .select(categoryStudySnapshot, { where: eq(categoryStudySnapshot.id, input.snapshotId) })
        .for('update')
      if (!row) return
      const modules = row.modules as unknown as SnapshotModules
      const themes = modules.painPoints.themes
      if (themes.status !== 'running' || themes.job.id !== pending.job.id) return
      const next: SnapshotModules = {
        ...modules,
        painPoints: { ...modules.painPoints, themes: outcome.themes },
        suggestions: outcome.suggestions,
        reviews: { ...modules.reviews, ...outcome.reviews },
      }
      await tx.updateById(categoryStudySnapshot, input.snapshotId, {
        modules: next as unknown as Record<string, unknown>,
      })
    })
    log.info('category.analysis_done', {
      jobId: pending.job.id,
      snapshotId: input.snapshotId,
      status: outcome.themes.status,
    })
  } catch (error) {
    log.error('category.analysis_persist_failed', {
      jobId: pending.job.id,
      snapshotId: input.snapshotId,
      error,
    })
  }
}
