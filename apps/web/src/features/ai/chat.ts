import {
  aiMessageOrder,
  CHAT_HOLD_TTL_MS,
  type CheckpointScheduleOptions,
  checkpointSchedule,
  dbModelStore,
  defaultLanguageModelFactory,
  estimateInputTokens,
  type FaultAccessContext,
  type LanguageModelFactory,
  MODEL_UNAVAILABLE,
  messageText,
  type Pricing,
  parseAcceptanceFault,
  planTextBudget,
  requireAvailableModel,
  resolveTextThinking,
  settleChatMessage,
  settleFromCheckpoint,
  settleInterruptedChatMessage,
  TEXT_FAULT_MAX_OUTPUT_TOKENS,
  type TextModelEnv,
  textModelConfig,
  truncateHistory,
  wrapTextFaultModel,
  writeTextFaultProof,
  writeUsageCheckpoint,
} from '@product-res/ai'
import { requireFreshSession } from '@product-res/auth'
import type { AiFaultInjectionEnv, TemplateConfig } from '@product-res/config'
import type { OveragePolicy } from '@product-res/credits'
import { getCreditBalance, hold } from '@product-res/credits'
import {
  type AiMessage,
  type AiPricingJson,
  aiConversation,
  aiMessage,
  type Database,
  scoped,
} from '@product-res/db'
import { type Entitlements, getEntitlements } from '@product-res/entitlements'
import type { BackgroundTasks, RateLimiter } from '@product-res/platform'
import { AppError, newId, toErrorResponse } from '@product-res/shared'
import { log, setLogContext } from '@product-res/shared/log'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { assertAccountActivated } from '../../server/account-activation.ts'
import { templateConfig } from '../../server/template-config.ts'
import { resolveWorkspaceBySlug } from '../../server/workspace-context.ts'
import { sessionFaultAccess } from './fault-access.ts'
import { chatRetryDelay, createChatStream } from './text-stream.ts'

/**
 * `POST /api/ai/chat`（docs/06-ai.md §3「流程」，specs/ai-chat）：
 * 会话 → 空间 → 权益（模型可用）→ `RL_AI` 限流 → 欠费 / 余额检查 → 定价快照 + 预扣 + 插入 streaming 消息
 * （同一事务）→ `streamText` → `waitUntil(consumeStream())` → `onEnd` 中按实际用量结算。
 * 响应使用 AI SDK 的 UI message 流协议，前端用 `useChat`（请求体见 `chatRequestSchema`）。
 *
 * 服务端以数据库中的历史为准，客户端只提交本轮的用户消息；对话只对创建者可见（scoped(ws) + user_id）。
 * 读流过程中写用量检查点；停止见 `handleChatStopRequest`，进程中断时由 apps/jobs 的兜底处理器结算。
 */

export interface ChatDeps {
  readonly db: Database
  readonly auth: Parameters<typeof requireFreshSession>[0]['auth']
  /** 构造模型所需的环境变量，原样交给工厂 */
  readonly env: TextModelEnv & AiFaultInjectionEnv
  readonly workersAi?: boolean
  /** `RL_AI` 绑定 */
  readonly rateLimiter: RateLimiter
  /** 请求上下文的 `waitUntil`：客户端断开后继续读完模型流并结算 */
  readonly waitUntil: BackgroundTasks['waitUntil']
  /** 默认 `defaultLanguageModelFactory`；测试注入模拟模型 */
  readonly languageModelFactory?: LanguageModelFactory
  /** 默认按订阅读取（`getEntitlements`） */
  readonly entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  /** 默认取模板配置 `billing.overage` */
  readonly overage?: OveragePolicy
  /** 用量检查点节奏，默认每 5 秒或每 200 个输出 token；测试可调 */
  readonly textConfig?: TemplateConfig['ai']['text']
  readonly retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly checkpoint?: CheckpointScheduleOptions
}

const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) })

export const chatRequestSchema = z.strictObject({
  /** 当前空间（URL 中的 `$slug`） */
  slug: z.string().min(1).max(64),
  modelId: z.uuid(),
  thinking: z.boolean().optional(),
  /** 省略时新建对话 */
  conversationId: z.uuid().optional(),
  /**
   * 客户端为本轮生成的请求 ID（issue #362）：收到 start 事件（带回复 ID）之前点停止时，
   * 客户端改用 `POST /api/ai/chat/stop` 按它停止。旧客户端与 API 入口省略。
   */
  requestId: z.uuid().optional(),
  /** 本轮的用户消息；首版只接受文本 */
  message: z.object({
    role: z.literal('user'),
    parts: z.array(textPart).min(1).max(16),
  }),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>

/** 发给客户端的消息元数据（UI message 流的 start 事件） */
export interface ChatMessageMetadata {
  readonly conversationId: string
  readonly messageId: string
}

const CONVERSATION_TITLE_LENGTH = 80

/**
 * 本 isolate 中进行中的回复：停止请求落在同一 isolate 时直接中止上游生成，并等待按内存中的完整
 * 已生成内容结算。Workers 不保证停止请求与原请求在同一 isolate，见 `handleChatStopRequest`。
 */
interface ActiveChat {
  /** 发起者：停止请求在本 isolate 命中时，鉴权后先按发起者中止，再查库 */
  readonly userId?: string
  abort(): void
  /** 读流与结算完成 */
  readonly done: Promise<void>
}
const activeChats = new Map<string, ActiveChat>()

/** 按请求 ID 索引本 isolate 的进行中回复；键含用户 ID，他人猜到请求 ID 也命中不了。 */
const activeRequests = new Map<string, ActiveChat & { readonly messageId: string }>()

/**
 * 「停止已请求」标记（issue #362）：停止先于回复入库到达本 isolate 时登记，聊天请求建好消息后、
 * 调用模型前检查，命中即不调用上游、直接按停止结算。只在本 isolate 有效；落在其他 isolate 时由
 * 停止接口等待消息入库后按检查点结算（见 `handleChatRequestStopRequest`）。条目短期过期。
 */
const pendingStops = new Map<string, number>()
const PENDING_STOP_TTL_MS = 60_000

const requestKey = (userId: string, requestId: string) => `${userId}:${requestId}`

function markPendingStop(stops: Map<string, number>, key: string, now = Date.now()) {
  // 顺手清理过期条目，避免长寿 isolate 中积累
  for (const [k, expiresAt] of stops) if (expiresAt <= now) stops.delete(k)
  stops.set(key, now + PENDING_STOP_TTL_MS)
}

function takePendingStop(key: string, now = Date.now()): boolean {
  const expiresAt = pendingStops.get(key)
  if (expiresAt === undefined) return false
  pendingStops.delete(key)
  return expiresAt > now
}

export async function handleChatRequest(request: Request, deps: ChatDeps): Promise<Response> {
  try {
    return await startChat(request, deps)
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) log.error('ai.chat.failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}

async function readRequest(request: Request): Promise<ChatRequest> {
  const body = await request.json().catch(() => undefined)
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid chat request')
  return parsed.data
}

async function startChat(request: Request, deps: ChatDeps): Promise<Response> {
  const { db } = deps
  const fresh = await requireFreshSession({ auth: deps.auth, db, headers: request.headers })
  const { user } = fresh
  const input = await readRequest(request)
  const resolved = await resolveWorkspaceBySlug(db, user.id, input.slug)
  if (!resolved) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  const workspaceId = resolved.workspace.id
  setLogContext({ workspaceId, userId: user.id })
  if (!templateConfig.tenancy.multiTenant && !resolved.workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  // 对话接口不经 withWorkspace，内测准入在此单独检查（add-beta-access-gate）
  await assertAccountActivated(db, user, workspaceId)
  const started = await startWorkspaceChat(
    input,
    { workspaceId, userId: user.id },
    {
      ...deps,
      faultAccess: sessionFaultAccess(fresh, deps.env),
    },
  )
  return started.result.toUIMessageStreamResponse({
    metadata: started.metadata,
    headers: { 'x-conversation-id': started.metadata.conversationId },
  })
}

export type WorkspaceChatDeps = Omit<ChatDeps, 'auth' | 'rateLimiter'> & {
  readonly rateLimiter?: RateLimiter | undefined
  /** 仅站内 fresh session 入口提供；API key 缺省拒绝。 */
  readonly faultAccess?: FaultAccessContext
}

/** 已鉴权入口共用预扣、定价快照、检查点与结算；公开 API 仅转换请求和响应协议。 */
export async function startWorkspaceChat(
  input: ChatRequest,
  context: {
    workspaceId: string
    userId: string
    prompt?: { role: 'system' | 'user' | 'assistant'; text: string }[]
    maxOutputTokens?: number | undefined
    temperature?: number | undefined
  },
  deps: WorkspaceChatDeps,
) {
  const { db } = deps
  const textConfig = deps.textConfig ?? templateConfig.ai.text
  if (input.thinking !== undefined && !textConfig.thinking.userToggle)
    throw new AppError('INVALID_REQUEST', 'Thinking toggle is disabled')
  const { workspaceId, userId } = context
  const s = scoped(db, workspaceId)

  // 1. 权益：模型已启用且当前套餐允许；取定价快照
  const entitlements = await (
    deps.entitlements ??
    ((db, workspaceId) =>
      getEntitlements(db, workspaceId, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      }))
  )(db, workspaceId)
  const model = await requireAvailableModel(
    {
      store: dbModelStore(db),
      workersAi: deps.workersAi ?? false,
      faultAccess: deps.faultAccess,
    },
    entitlements,
    input.modelId,
  )
  if (model.kind !== 'text')
    throw new AppError(MODEL_UNAVAILABLE, 'Model is not available', { status: 404 })
  const pricing = model.pricing
  // fresh 调用闸门已通过，此处固定模式；后续模型修改不改变在途语义。
  const fault = parseAcceptanceFault(model)
  const faultMode =
    fault?.mode === 'chat-before-stream' || fault?.mode === 'chat-mid-stream'
      ? fault.mode
      : undefined

  // 2. 限流（按数据中心计数，只用于防刷）
  if (
    deps.rateLimiter &&
    !(await deps.rateLimiter.limit('ai', `ai:${workspaceId}:${userId}`)).success
  )
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', { status: 429 })

  const languageModel = (deps.languageModelFactory ?? defaultLanguageModelFactory)(model, deps.env)

  // 3. 对话与历史：只读创建者自己的对话。首条 system 消息是建对话时写入的对象上下文
  // （add-subject-chat），作为固定前缀放在提示词最前，截断时保留
  let conversationId = input.conversationId
  let history: { role: 'user' | 'assistant'; text: string }[] = []
  let systemPrefix: { role: 'system'; text: string } | undefined
  if (conversationId !== undefined) {
    const [conversation] = await s
      .select(aiConversation, {
        where: and(eq(aiConversation.id, conversationId), eq(aiConversation.userId, userId)) as SQL,
      })
      .limit(1)
    if (!conversation) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    const rows = await s
      .select(aiMessage, {
        where: and(
          eq(aiMessage.conversationId, conversationId),
          inArray(aiMessage.role, ['system', 'user', 'assistant']),
          inArray(aiMessage.status, ['completed', 'aborted', 'failed']),
        ) as SQL,
      })
      .orderBy(...aiMessageOrder())
    const firstSystem = rows.find((row) => row.role === 'system')
    const prefixText = firstSystem ? messageText(firstSystem.parts) : ''
    if (prefixText) systemPrefix = { role: 'system', text: prefixText }
    history = rows.flatMap((row) => {
      const text = messageText(row.parts)
      return text && (row.role === 'user' || row.role === 'assistant')
        ? [{ role: row.role, text }]
        : []
    })
  }
  const userText = input.message.parts.map((part) => part.text).join('')
  const {
    tokensPerChar,
    maxOutputTokens: modelMaxOutput,
    thinking,
    continuation,
  } = textModelConfig(model)
  let prompt: { role: 'system' | 'user' | 'assistant'; text: string }[] = context.prompt ?? [
    ...history,
    { role: 'user' as const, text: userText },
  ]
  const prefix = context.prompt ? undefined : systemPrefix
  if (pricing.mode === 'per_call' && pricing.limits?.maxInputTokens !== undefined) {
    const reserved = prefix ? estimateInputTokens([prefix], tokensPerChar) : 0
    prompt = truncateHistory(prompt, pricing.limits.maxInputTokens - reserved, tokensPerChar)
  }
  if (prefix) prompt = [prefix, ...prompt]
  const inputTokens = estimateInputTokens(prompt, tokensPerChar)

  // 4. 欠费 / 余额：按余额确定最大输出与预扣额（hold 在锁内再次检查）
  const balance = await getCreditBalance(db, workspaceId)
  if (balance.debt > 0)
    throw new AppError('CREDIT_DEBT', 'Workspace has unpaid credit debt', { status: 402 })
  const budget = planTextBudget({
    pricing,
    inputTokens,
    balance: balance.available,
    maxOutputTokens: Math.min(
      modelMaxOutput,
      context.maxOutputTokens ?? modelMaxOutput,
      faultMode ? TEXT_FAULT_MAX_OUTPUT_TOKENS : modelMaxOutput,
    ),
    ...(context.maxOutputTokens === undefined
      ? {}
      : { minOutputTokens: Math.min(256, context.maxOutputTokens) }),
  })

  // 5. 同一事务：对话、用户消息、预扣、带定价快照的 streaming 消息
  const userMessageId = newId()
  const assistantId = newId()
  const holdDeadline = Date.now() + CHAT_HOLD_TTL_MS
  const streamModel = faultMode
    ? wrapTextFaultModel(languageModel, {
        mode: faultMode,
        env: deps.env,
        tokensPerChar,
        writeProof: (proof) =>
          writeTextFaultProof(db, { workspaceId, messageId: assistantId, proof }),
      })
    : languageModel
  const holdId = await db.transaction(async (tx) => {
    const t = scoped(tx, workspaceId)
    if (conversationId === undefined) {
      conversationId = newId()
      await t.insert(aiConversation, {
        id: conversationId,
        userId,
        title: userText.slice(0, CONVERSATION_TITLE_LENGTH),
        modelKey: model.key,
      })
    }
    await t.insert(aiMessage, {
      id: userMessageId,
      conversationId,
      role: 'user',
      parts: input.message.parts,
    })
    const reservation = await hold(tx, {
      workspaceId,
      userId,
      amount: budget.holdAmount,
      refType: 'ai_message',
      refId: assistantId,
      expiresAt: new Date(holdDeadline),
    })
    await t.insert(aiMessage, {
      id: assistantId,
      conversationId,
      role: 'assistant',
      parts: [],
      modelKey: model.key,
      pricing: pricing as AiPricingJson,
      status: 'streaming',
      // 结算前存放输入估算：兜底处理器在没有检查点时据此收最低费用（design 决策 4）
      inputTokens,
      usageCheckpoint: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        failedReplyRefund: textConfig.failedReplyRefund,
        at: new Date().toISOString(),
        ...(input.requestId ? { clientRequestId: input.requestId } : {}),
        ...(faultMode
          ? {
              acceptanceFaultProof: {
                mode: faultMode,
                policyVersion: 1 as const,
                phase: 'pending' as const,
                injected: false,
                realProviderCalled: false,
                upstreamCalls: 0,
              },
            }
          : {}),
      },
      holdId: reservation.id,
    })
    return reservation.id
  })
  const metadata: ChatMessageMetadata = {
    conversationId: conversationId as string,
    messageId: assistantId,
  }

  // 6. 流式调用；结算与客户端连接解耦
  const overage = deps.overage ?? templateConfig.billing.overage
  const controller = new AbortController()
  const activeKey = input.requestId ? requestKey(userId, input.requestId) : undefined
  // 停止先于消息入库到达本 isolate：不调用上游，读流循环直接以 aborted 结束并按停止规则结算
  if (activeKey && takePendingStop(activeKey)) controller.abort('stop')
  let schedule = checkpointSchedule(deps.checkpoint)
  let checkpoints: Promise<unknown> = Promise.resolve()
  const result = createChatStream({
    model: streamModel,
    provider: model.provider,
    messages: prompt.map((message, index) =>
      index === 0 && prefix
        ? // 固定前缀：Anthropic 需显式标记缓存断点，其他服务商忽略该选项并按前缀自动缓存
          {
            role: 'system' as const,
            content: message.text,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          }
        : { role: message.role, content: message.text },
    ),
    // 模型显式 thinking=false 时下发关闭形式，而不是省略（默认推理的模型会把输出预算耗在 reasoning 上）
    thinking: resolveTextThinking(
      model.provider,
      thinking,
      input.thinking ?? textConfig.thinking.default === 'on',
    ),
    continuation: continuation === 'native' && !faultMode,
    displayReasoning: textConfig.reasoning.display,
    inputTokens,
    tokensPerChar,
    maxOutputTokens: Math.min(
      budget.maxOutputTokens,
      context.maxOutputTokens ?? budget.maxOutputTokens,
      faultMode ? TEXT_FAULT_MAX_OUTPUT_TOKENS : budget.maxOutputTokens,
    ),
    temperature: context.temperature,
    controller,
    deadline: holdDeadline,
    retryDelay: deps.retryDelay ?? chatRetryDelay,
    checkpoint: (snapshot) => {
      // 输出归零意味着丢弃无正文 attempt，必须立刻替换持久化检查点。
      if (snapshot.outputTokens === 0) schedule = checkpointSchedule(deps.checkpoint)
      else if (!schedule.due(snapshot.outputTokens)) return
      checkpoints = checkpoints.then(async () => {
        try {
          const streaming = await writeUsageCheckpoint(db, {
            workspaceId,
            messageId: assistantId,
            ...snapshot,
            reasoning: textConfig.reasoning.display ? snapshot.reasoning : '',
            failedReplyRefund: textConfig.failedReplyRefund,
          })
          if (!streaming) controller.abort('settled')
        } catch (error) {
          log.error('ai.chat.checkpoint_failed', { messageId: assistantId, error })
        }
      })
    },
    settle: async (outcome) => {
      await checkpoints
      const usage = {
        workspaceId,
        messageId: assistantId,
        holdId,
        pricing,
        overage,
        text: outcome.text,
        ...(textConfig.reasoning.display ? { reasoning: outcome.reasoning } : {}),
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        reasoningTokens: outcome.reasoningTokens,
        absorbed: outcome.absorbed,
        total: outcome.total,
        lastAttempt: outcome.lastAttempt,
        usageSource: outcome.usageSource,
        failedReplyRefund: textConfig.failedReplyRefund,
      }
      try {
        if (outcome.status === 'completed') await settleChatMessage(db, usage)
        else
          await settleInterruptedChatMessage(db, {
            ...usage,
            status: outcome.status,
            hasOutput: outcome.text !== '',
          })
      } catch (error) {
        log.error('ai.chat.settle_failed', { messageId: assistantId, error })
      } finally {
        activeChats.delete(assistantId)
        if (activeKey) activeRequests.delete(activeKey)
      }
    },
  })
  const done = result.done.then(() => {})
  const active: ActiveChat = { userId, abort: () => controller.abort('stop'), done }
  activeChats.set(assistantId, active)
  if (activeKey) activeRequests.set(activeKey, { ...active, messageId: assistantId })
  deps.waitUntil(done)

  return { result, metadata, done }
}

export interface ChatStopDeps {
  readonly db: Database
  readonly auth: Parameters<typeof requireFreshSession>[0]['auth']
  /** 默认取模板配置 `billing.overage` */
  readonly overage?: OveragePolicy
  /** 默认本 isolate 的进行中回复；测试传入空表模拟停止请求落在其他 isolate */
  readonly activeChats?: ReadonlyMap<string, ActiveChat>
}

const stopRequestSchema = z.object({ slug: z.string().min(1).max(64) })

/** 停止接口的响应：消息当前（结束后）的状态 */
export interface ChatStopResponse {
  readonly status: 'aborted' | 'completed' | 'failed'
}

/**
 * `POST /api/ai/chat/:messageId/stop`（design 决策 6，specs/ai-chat「主动停止」）：请求体 `{ slug }`，
 * 只能停止自己对话中的回复；他人消息或不存在返回 404，已结束的消息幂等返回当前状态。
 *
 * - 原请求在本 isolate：中止上游生成，按已生成内容（按 token 以文本估算输出用量）结算并标记 aborted。
 * - 原请求在其他 isolate（拿不到 AbortController）：按已持久化的最后一个检查点结算并标记 aborted；
 *   原请求在下次写检查点时发现消息已结束即中止生成，结束时的结算因预扣已结算而跳过，不重复结算。
 */
export async function handleChatStopRequest(
  request: Request,
  messageId: string,
  deps: ChatStopDeps,
): Promise<Response> {
  try {
    return Response.json(await stopChat(request, messageId, deps))
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500)
      log.error('ai.chat.stop_failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

/** 只认创建者自己对话中的回复 */
const ownReply = (s: ReturnType<typeof scoped>, userId: string) =>
  inArray(
    aiMessage.conversationId,
    s.select(aiConversation, {
      where: eq(aiConversation.userId, userId),
      fields: { id: aiConversation.id },
    }),
  )

async function stopChat(
  request: Request,
  messageId: string,
  deps: ChatStopDeps,
): Promise<ChatStopResponse> {
  const { db } = deps
  const { user } = await requireFreshSession({ auth: deps.auth, db, headers: request.headers })
  const parsed = stopRequestSchema.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid stop request')
  // 本 isolate 中发起者本人的进行中回复：先中止上游再解析空间、查库，缩短从点停止到真正停止之间
  // 多生成（并保存、计费）的那一段。只有发起者能命中；之后的归属校验与结算流程不变。
  const local = (deps.activeChats ?? activeChats).get(messageId)
  if (local?.userId === user.id) local.abort()
  const resolved = await resolveWorkspaceBySlug(db, user.id, parsed.data.slug)
  if (!resolved || !z.uuid().safeParse(messageId).success) throw notFound()
  setLogContext({ workspaceId: resolved.workspace.id, userId: user.id })
  const s = scoped(db, resolved.workspace.id)

  const load = async () => {
    const [row] = await s
      .select(aiMessage, {
        where: and(
          eq(aiMessage.id, messageId),
          eq(aiMessage.role, 'assistant'),
          ownReply(s, user.id),
        ) as SQL,
      })
      .limit(1)
    if (!row) throw notFound()
    return row
  }
  return settleStop(db, await load(), load, local, deps.overage)
}

/**
 * 已找到属于本人的回复后的停止流程，两个停止入口共用：本 isolate 有该流时中止并等待内存结算；
 * 否则（或本地结算失败仍为 streaming）按最后一个检查点结算；已结束的消息幂等返回当前状态。
 */
async function settleStop(
  db: Database,
  found: AiMessage,
  load: () => Promise<AiMessage>,
  local: ActiveChat | undefined,
  overage: OveragePolicy | undefined,
): Promise<ChatStopResponse> {
  const ended = (status: AiMessage['status']) =>
    status === 'streaming' ? null : { status: status as ChatStopResponse['status'] }

  let message = found
  if (message.status === 'streaming' && local) {
    local.abort()
    await local.done
    message = await load()
  }
  // 已结束（含本 isolate 刚结算完）；本地结算失败时仍为 streaming，继续按检查点结算
  const result = ended(message.status)
  if (result) return result
  if (!message.holdId || !message.pricing) throw notFound()
  const settled = await settleFromCheckpoint(
    db,
    { ...message, holdId: message.holdId, pricing: message.pricing as Pricing },
    { status: 'aborted', overage: overage ?? templateConfig.billing.overage },
  )
  if (settled) return { status: 'aborted' }
  // 并发的另一方（原请求或兜底处理器）先结算
  return ended((await load()).status) ?? { status: 'aborted' }
}

export interface ChatRequestStopDeps extends Omit<ChatStopDeps, 'activeChats'> {
  /** 默认本 isolate 按请求 ID 索引的进行中回复；测试传入空表模拟停止请求落在其他 isolate */
  readonly activeRequests?: ReadonlyMap<string, ActiveChat & { readonly messageId: string }>
  /** 默认本 isolate 的「停止已请求」标记；测试传入独立的表模拟停止请求落在其他 isolate */
  readonly pendingStops?: Map<string, number>
  /**
   * 回复还没入库时重读的间隔（毫秒）。聊天请求在入库前只做鉴权、权益、限流、历史与余额读取，
   * 通常一秒内完成；默认最长等约 6 秒，期间只按会话索引做少量查询。
   */
  readonly waitDelays?: readonly number[]
}

export const REQUEST_STOP_WAIT_MS: readonly number[] = [0, 100, 200, 400, 800, 1600, 3200]

const requestStopSchema = z.object({
  slug: z.string().min(1).max(64),
  conversationId: z.uuid(),
  requestId: z.uuid(),
})

/** 按请求 ID 停止的响应；`messageId` 为 null 表示等待期内回复没有入库（请求被拒或尚未建好） */
export interface ChatRequestStopResponse {
  readonly status: ChatStopResponse['status']
  readonly messageId: string | null
}

/**
 * `POST /api/ai/chat/stop`（issue #362）：请求体 `{ slug, conversationId, requestId }`。客户端在收到
 * start 事件、拿到回复 ID 之前点停止时使用；拿到回复 ID 后仍走 `/api/ai/chat/:messageId/stop`。
 * 只能停止自己在该空间的对话中的回复，对话不属于本人或不存在返回 404。
 *
 * - 先在本 isolate 登记「停止已请求」：聊天请求若还没建好消息，建好后不调用上游，直接以 aborted 结算。
 * - 按 (对话, 请求 ID) 查回复，查不到时按 `waitDelays` 等待入库（覆盖原请求在其他 isolate 的情况），
 *   找到后与按回复 ID 停止完全相同：本 isolate 中止并按内存结算，其他 isolate 按检查点结算。
 * - 等待期内仍没有回复：返回 `{ status: 'aborted', messageId: null }`，本 isolate 的标记短期保留。
 */
export async function handleChatRequestStopRequest(
  request: Request,
  deps: ChatRequestStopDeps,
): Promise<Response> {
  try {
    return Response.json(await stopChatRequest(request, deps))
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500)
      log.error('ai.chat.stop_failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}

async function stopChatRequest(
  request: Request,
  deps: ChatRequestStopDeps,
): Promise<ChatRequestStopResponse> {
  const { db } = deps
  const { user } = await requireFreshSession({ auth: deps.auth, db, headers: request.headers })
  const parsed = requestStopSchema.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid stop request')
  const { slug, conversationId, requestId } = parsed.data
  // 标记与本地索引都以用户 ID 为前缀：只影响本人带该请求 ID 的聊天请求，无需先查库即可登记，
  // 尽量赶在原请求建好消息、调用上游之前
  const key = requestKey(user.id, requestId)
  const actives = deps.activeRequests ?? activeRequests
  let local = actives.get(key)
  if (local) local.abort()
  else markPendingStop(deps.pendingStops ?? pendingStops, key)

  const resolved = await resolveWorkspaceBySlug(db, user.id, slug)
  if (!resolved) throw notFound()
  setLogContext({ workspaceId: resolved.workspace.id, userId: user.id })
  const s = scoped(db, resolved.workspace.id)
  const [conversation] = await s
    .select(aiConversation, {
      where: and(eq(aiConversation.id, conversationId), eq(aiConversation.userId, user.id)) as SQL,
      fields: { id: aiConversation.id },
    })
    .limit(1)
  if (!conversation) throw notFound()

  const find = async () => {
    const [row] = await s
      .select(aiMessage, {
        where: and(
          eq(aiMessage.conversationId, conversationId),
          eq(aiMessage.role, 'assistant'),
          sql`${aiMessage.usageCheckpoint}->>'clientRequestId' = ${requestId}`,
        ) as SQL,
      })
      .orderBy(...aiMessageOrder('desc'))
      .limit(1)
    return row
  }
  let found: AiMessage | undefined
  for (const delay of deps.waitDelays ?? REQUEST_STOP_WAIT_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    found = await find()
    if (found) break
  }
  if (!found) return { status: 'aborted', messageId: null }
  // 标记不在此删除：原请求可能刚建好消息、尚未检查标记；请求 ID 一次性，残留标记到期即清理
  local ??= actives.get(key)
  const messageId = found.id
  const load = async () => {
    const [row] = await s
      .select(aiMessage, {
        where: and(eq(aiMessage.id, messageId), ownReply(s, user.id)) as SQL,
      })
      .limit(1)
    if (!row) throw notFound()
    return row
  }
  const result = await settleStop(
    db,
    found,
    load,
    local?.messageId === messageId ? local : undefined,
    deps.overage,
  )
  return { ...result, messageId }
}
