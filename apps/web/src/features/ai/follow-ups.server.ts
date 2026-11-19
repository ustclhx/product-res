import {
  actualCredits,
  aiMessageOrder,
  dbModelStore,
  defaultLanguageModelFactory,
  estimateCredits,
  estimateInputTokens,
  getTextProviderCapabilities,
  type LanguageModelFactory,
  listAvailableModels,
  messageText,
  resolveTextThinking,
  type TextModelEnv,
  textModelConfig,
} from '@product-res/ai'
import type { TemplateConfig } from '@product-res/config'
import { CreditsError, capture, hold, type OveragePolicy, release } from '@product-res/credits'
import { aiConversation, aiMessage, creditHold, type Database, scoped } from '@product-res/db'
import { type Entitlements, getEntitlements } from '@product-res/entitlements'
import type { KeyValueStore, RateLimiter } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { generateText } from 'ai'
import { and, eq, lte, type SQL } from 'drizzle-orm'
import { templateConfig } from '../../server/template-config.ts'

/**
 * 回复后的后续推荐问题（add-subject-chat design 决策 5，specs/ai-chat「回复后的后续问题」）。
 *
 * - 配置关闭时直接返回空列表，不查模型、不扣积分；
 * - 每条回复只生成一次：结果缓存在 KV（1 天），重复请求复用；
 * - 开启计费时先预扣再按实际用量结算，生成失败释放。预扣的 ref 指向被追问的助手消息
 *   （metrics-daily 据此关联模型，删号清理会等待在途预扣）；该消息的 hold_id 仍是原回复的预扣，
 *   进程中断时 chatHoldSweeper 找不到以本预扣为 hold_id 的消息，走释放分支，不会多扣；
 * - 计费只支持按 token 计价的模型：按次计价的模型每次追问都会收一次完整的单轮费用，开启计费时跳过；
 * - 同一回复已有在途预扣（如两个标签页同时请求）时不再生成，避免重复扣费；
 * - 推荐问题不写入 ai_message，点击后才作为普通用户消息发送。
 */

export type FollowUpsConfig = TemplateConfig['ai']['text']['followUps']

export interface FollowUpsDeps {
  readonly db: Database
  readonly cache: KeyValueStore
  readonly env: TextModelEnv
  readonly workersAi: boolean
  readonly rateLimiter?: RateLimiter | undefined
  readonly languageModelFactory?: LanguageModelFactory
  readonly entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  readonly config?: FollowUpsConfig
  readonly overage?: OveragePolicy
}

const CACHE_PREFIX = 'chat-follow-ups:'
const CACHE_TTL_SECONDS = 86_400
const MAX_OUTPUT_TOKENS = 256
const HOLD_TTL_MS = 2 * 60_000
/** 参与生成的上下文与本轮问答的字符上限，控制附加请求的成本 */
const MAX_CONTEXT_CHARS = 8_000
const MAX_TURN_CHARS = 4_000
const MAX_QUESTION_LENGTH = 200

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

export async function generateFollowUps(
  deps: FollowUpsDeps,
  scope: { workspaceId: string; userId: string },
  messageId: string,
): Promise<{ questions: string[] }> {
  const config = deps.config ?? templateConfig.ai.text.followUps
  if (!config.enabled) return { questions: [] }
  const s = scoped(deps.db, scope.workspaceId)

  // 只认自己对话中已完成的助手回复
  const [message] = await s
    .select(aiMessage, {
      where: and(eq(aiMessage.id, messageId), eq(aiMessage.role, 'assistant')) as SQL,
    })
    .limit(1)
  if (!message) throw notFound()
  const [conversation] = await s
    .select(aiConversation, {
      fields: { id: aiConversation.id },
      where: and(
        eq(aiConversation.id, message.conversationId),
        eq(aiConversation.userId, scope.userId),
      ) as SQL,
    })
    .limit(1)
  if (!conversation) throw notFound()
  if (message.status !== 'completed') return { questions: [] }

  const cacheKey = `${CACHE_PREFIX}${message.id}`
  const cached = await deps.cache.get(cacheKey)
  if (cached !== null) return { questions: parseQuestions(cached, config.count) }

  if (
    deps.rateLimiter &&
    !(await deps.rateLimiter.limit('ai', `ai:${scope.workspaceId}:${scope.userId}`)).success
  )
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', { status: 429 })

  const entitlements = await (
    deps.entitlements ??
    ((db, workspaceId) =>
      getEntitlements(db, workspaceId, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      }))
  )(deps.db, scope.workspaceId)
  const models = await listAvailableModels(
    { store: dbModelStore(deps.db), cache: deps.cache, workersAi: deps.workersAi },
    entitlements,
    { kind: 'text' },
  )
  const model = models.find((m) => m.key === (config.modelKey ?? message.modelKey))
  if (!model) return { questions: [] }
  // 按次计价会让每次追问收一次完整单轮费用，计费模式下只用按 token 计价的模型
  if (config.charge && model.pricing.mode !== 'token') return { questions: [] }

  const prompt = await followUpPrompt(deps.db, scope.workspaceId, message, config.count)
  const { tokensPerChar, thinking } = textModelConfig(model)
  const followUpThinking = resolveTextThinking(model.provider, thinking, false)
  const inputTokens = estimateInputTokens(
    prompt.map((m) => ({ text: m.content })),
    tokensPerChar,
  )

  let holdId: string | undefined
  if (config.charge) {
    // 同一回复已有在途预扣：另一个请求正在生成，不重复扣费
    const [inFlight] = await s
      .select(creditHold, {
        fields: { id: creditHold.id },
        where: and(
          eq(creditHold.refType, 'ai_message'),
          eq(creditHold.refId, message.id),
          eq(creditHold.status, 'held'),
        ) as SQL,
      })
      .limit(1)
    if (inFlight) return { questions: [] }
    try {
      const reservation = await hold(deps.db, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        amount: estimateCredits(model.pricing, { inputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS }),
        refType: 'ai_message',
        refId: message.id,
        expiresAt: new Date(Date.now() + HOLD_TTL_MS),
      })
      holdId = reservation.id
    } catch (error) {
      // 余额不足或欠费时不生成推荐问题，也不打断主对话
      if (error instanceof CreditsError) return { questions: [] }
      throw error
    }
  }

  let questions: string[]
  try {
    const languageModel = (deps.languageModelFactory ?? defaultLanguageModelFactory)(
      model,
      deps.env,
    )
    const result = await generateText({
      model: languageModel,
      // 与聊天流一致：对象上下文以首条 system 消息传入
      allowSystemInMessages: true,
      messages: prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // 推荐问题是短输出：Provider 可控时显式关闭 thinking，避免 reasoning 耗尽 256 token 的输出预算
      ...(followUpThinking === undefined
        ? {}
        : getTextProviderCapabilities(model.provider).applyThinking({}, followUpThinking)),
    })
    questions = parseQuestions(result.text, config.count)
    if (holdId) {
      const amount = actualCredits(model.pricing, {
        inputTokens: result.usage.inputTokens ?? inputTokens,
        outputTokens: result.usage.outputTokens ?? 0,
      })
      const settled = holdId
      await capture(deps.db, {
        workspaceId: scope.workspaceId,
        holdId: settled,
        actualAmount: amount,
        overage: deps.overage ?? templateConfig.billing.overage,
      }).catch((error) => {
        // 结算失败时预扣保持 held，到期由 chatHoldSweeper 释放；已生成的问题照常返回
        log.error('ai.follow_ups.capture_failed', { holdId: settled, error })
      })
      holdId = undefined
    }
  } catch (error) {
    if (holdId)
      await release(deps.db, { workspaceId: scope.workspaceId, holdId }).catch((releaseError) =>
        log.error('ai.follow_ups.release_failed', { holdId, error: releaseError }),
      )
    // 附加请求失败不影响对话，只记录错误（不含提示词与回复正文）
    log.error('ai.follow_ups.failed', { messageId: message.id, error })
    return { questions: [] }
  }
  // 缓存写入失败只影响复用，不进入释放分支
  await deps.cache
    .put(cacheKey, JSON.stringify(questions), { expirationTtl: CACHE_TTL_SECONDS })
    .catch((error) => log.error('ai.follow_ups.cache_failed', { messageId: message.id, error }))
  return { questions }
}

/** 生成提示：对象上下文（若有）+ 本轮问答 + 指令；只取本轮，控制附加请求的输入长度 */
async function followUpPrompt(
  db: Database,
  workspaceId: string,
  message: { id: string; conversationId: string; parts: unknown[] },
  count: number,
) {
  const s = scoped(db, workspaceId)
  const [system] = await s
    .select(aiMessage, {
      fields: { parts: aiMessage.parts },
      where: and(
        eq(aiMessage.conversationId, message.conversationId),
        eq(aiMessage.role, 'system'),
      ) as SQL,
    })
    .orderBy(...aiMessageOrder())
    .limit(1)
  // 同时间的 user 排在 assistant 前；保留数据库时间精度，避免 Date 截掉微秒后漏掉本轮问题。
  const replyCreatedAt = s
    .select(aiMessage, {
      fields: { createdAt: aiMessage.createdAt },
      where: eq(aiMessage.id, message.id),
    })
    .limit(1)
  const [question] = await s
    .select(aiMessage, {
      fields: { parts: aiMessage.parts },
      where: and(
        eq(aiMessage.conversationId, message.conversationId),
        eq(aiMessage.role, 'user'),
        lte(aiMessage.createdAt, replyCreatedAt),
      ) as SQL,
    })
    .orderBy(...aiMessageOrder('desc'))
    .limit(1)
  const context = system ? messageText(system.parts) : ''
  const instruction = [
    `Suggest ${count} short follow-up questions the user is likely to ask next about this conversation.`,
    'Write them in the language the user writes in, from the user’s point of view, each under 80 characters.',
    'Reply with a JSON array of strings only, no other text.',
  ].join(' ')
  return [
    ...(context ? [{ role: 'system' as const, content: context.slice(0, MAX_CONTEXT_CHARS) }] : []),
    {
      role: 'user' as const,
      content: messageText(question?.parts ?? []).slice(0, MAX_TURN_CHARS),
    },
    { role: 'assistant' as const, content: messageText(message.parts).slice(0, MAX_TURN_CHARS) },
    { role: 'user' as const, content: instruction },
  ]
}

/** 解析模型输出：优先 JSON 数组，否则按行拆分；去重、去编号、限长 */
export function parseQuestions(text: string, count: number): string[] {
  let items: unknown[] = []
  const match = text.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown
      if (Array.isArray(parsed)) items = parsed
    } catch {
      items = []
    }
  }
  if (items.length === 0) items = text.split('\n')
  const seen = new Set<string>()
  const questions: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const question = item
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/^["'“]|["'”]$/g, '')
      .trim()
    if (!question || question.length > MAX_QUESTION_LENGTH || seen.has(question)) continue
    seen.add(question)
    questions.push(question)
    if (questions.length >= count) break
  }
  return questions
}
