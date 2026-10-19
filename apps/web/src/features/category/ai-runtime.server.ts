import {
  AI_PROVIDER_NOT_CONFIGURED,
  dbModelStore,
  type LanguageModelFactory,
  listAvailableModels,
} from '@product-res/ai'
import type { OveragePolicy } from '@product-res/credits'
import type { Database } from '@product-res/db'
import { type Entitlements, getEntitlements } from '@product-res/entitlements'
import type { BackgroundTasks } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { startWorkspaceChat, type WorkspaceChatDeps } from '../ai/chat.ts'
import type { AiPrompt, InsightAi } from './ai.ts'
import type { AnalysisBackground } from './analysis.server.ts'

/**
 * 品类洞察的文本模型调用（tasks 3.3）：复用 AI 对话的同一条计费链路（权益 → 余额 → 定价快照 + 预扣 →
 * 调用 → 按实际用量结算），用量写入 ai_message 并扣积分，与公开 API 的 chat completions 一致。
 * 模型取空间权益允许的第一个已启用文本模型（后台模型管理的排序）。
 */

/** 单次分析的输出上限：主题与 3–5 条建议的 JSON 远小于此 */
const MAX_OUTPUT_TOKENS = 2000
export const AI_NOT_CONFIGURED_REASON = 'AI 未配置：没有可用的文本模型，请在后台 · 模型管理中启用'

export interface InsightAiDeps {
  db: Database
  workspaceId: string
  userId: string
  slug: string
  /** 写入对话列表的标题与用户消息；完整提示词只发给模型 */
  title: string
  env: WorkspaceChatDeps['env']
  workersAi: boolean
  waitUntil: BackgroundTasks['waitUntil']
  languageModelFactory?: LanguageModelFactory
  entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  overage?: OveragePolicy
}

/** 按请求运行时装配；目标未装配 AI 能力时不调用，返回原因 */
export function runtimeInsightAi(context: {
  db: Database
  workspaceId: string
  userId: string
  slug: string
  title: string
}): InsightAi {
  const runtime = getWebRuntime()
  const ai = runtime.ai
  if (!ai?.available)
    return { resolve: async () => ({ ok: false, reason: AI_NOT_CONFIGURED_REASON }) }
  return createInsightAi({
    ...context,
    env: {
      ...ai.value.config,
      ...(ai.value.workersAi.available ? { AI: ai.value.workersAi.value } : {}),
    },
    workersAi: ai.value.workersAi.available,
    waitUntil: (promise) => ai.value.background.waitUntil(promise),
  })
}

/**
 * 后台分析的执行方式（add-insight-background-analysis）：交给请求运行时的 BackgroundTasks，
 * 请求立即返回；Node 进程停机时等待在途分析排空。未装配 AI 能力时不会产生待执行的分析。
 */
export function runtimeAnalysisBackground(): AnalysisBackground {
  const ai = getWebRuntime().ai
  return (run) => {
    const task = run()
    if (ai?.available) ai.value.background.waitUntil(task)
  }
}

export function createInsightAi(deps: InsightAiDeps): InsightAi {
  return {
    async resolve() {
      if (!templateConfig.ai.text.enabled) return { ok: false, reason: '模板未启用文本 AI' }
      const entitlementsOf =
        deps.entitlements ??
        ((db: Database, workspaceId: string) =>
          getEntitlements(db, workspaceId, {
            pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
          }))
      const entitlements = await entitlementsOf(deps.db, deps.workspaceId)
      const [model] = await listAvailableModels(
        { store: dbModelStore(deps.db), workersAi: deps.workersAi },
        entitlements,
        { kind: 'text' },
      )
      if (!model) return { ok: false, reason: AI_NOT_CONFIGURED_REASON }
      return {
        ok: true,
        modelKey: model.key,
        async generate(prompt: AiPrompt) {
          try {
            const started = await startWorkspaceChat(
              {
                slug: deps.slug,
                modelId: model.id,
                message: { role: 'user', parts: [{ type: 'text', text: deps.title }] },
              },
              {
                workspaceId: deps.workspaceId,
                userId: deps.userId,
                prompt: [
                  { role: 'system', text: prompt.system },
                  { role: 'user', text: prompt.user },
                ],
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                temperature: 0.2,
              },
              {
                db: deps.db,
                env: deps.env,
                workersAi: deps.workersAi,
                waitUntil: deps.waitUntil,
                rateLimiter: undefined,
                entitlements: async () => entitlements,
                faultAccess: { enabled: false, platformAdmin: false },
                ...(deps.languageModelFactory
                  ? { languageModelFactory: deps.languageModelFactory }
                  : {}),
                ...(deps.overage ? { overage: deps.overage } : {}),
              },
            )
            const text = await started.result.text
            // 等结算完成再返回，保证快照写入时用量已记账
            await started.done
            return text
          } catch (error) {
            if (error instanceof AppError && error.code === AI_PROVIDER_NOT_CONFIGURED)
              throw new AppError(AI_PROVIDER_NOT_CONFIGURED, AI_NOT_CONFIGURED_REASON, {
                status: 503,
              })
            throw error
          }
        },
      }
    },
  }
}
