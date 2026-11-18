import { aiMessageOrder } from '@product-res/ai'
import { aiConversation, aiMessage, scoped } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { templateConfig } from '../../server/template-config.ts'
import {
  type ChatMessageStatus,
  CONVERSATION_TITLE_LENGTH,
  messageDisplayParts,
} from './conversation.ts'
import { feedbackForMessages } from './feedback.server.ts'
import type { MessageFeedbackValue } from './feedback.ts'
import {
  openSubjectContext,
  type SubjectContextDeps,
  subjectSystemContextSchema,
  subjectSystemParts,
} from './subject-context.ts'
import {
  resolveConversationSubject,
  type SubjectRequestContext,
  type SubjectSystemContext,
  subjectLabel,
} from './subjects.ts'
// 项目注册的对象 provider（副作用导入）：注册表在任何对象对话请求之前就绪
import './subject-providers.ts'

/**
 * 对象对话的服务端逻辑（add-subject-chat tasks.md 2.3）。server function 只做会话与空间解析，
 * 这里接收已鉴权的空间与用户，便于集成测试直接调用。
 *
 * 安全约束：
 * - 未注册类型、无 resolve 的类型、不存在或他人的对象一律 404，响应不区分；
 * - 上下文只在新建对话时构建并写成首条 system 消息（与对话同一事务），客户端只传引用；
 * - 日志只记对象类型与上下文版本，不记正文。
 */

export interface SubjectRef {
  readonly type: string
  readonly id: string
}

export interface SubjectView {
  readonly type: string
  readonly label: string
  readonly title: string | null
  readonly suggestions: readonly string[]
  readonly defaultModelKey: string | null
}

/** 对话消息（与 getConversation 相同的展示形态，只含 user / assistant） */
export interface SubjectChatMessage {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly parts: { type: 'text' | 'reasoning'; text: string }[]
  readonly status: ChatMessageStatus
}

export interface SubjectChatData {
  readonly subject: SubjectView
  readonly conversation: { readonly id: string; readonly title: string } | null
  readonly conversations: readonly { id: string; title: string; updatedAt: Date }[]
  readonly messages: readonly SubjectChatMessage[]
  readonly feedback: Readonly<Record<string, MessageFeedbackValue>>
}

export type TemporarySubjectChat =
  | ({ readonly status: 'ok'; readonly returnTo: string } & SubjectChatData)
  | ({ readonly status: 'expired'; readonly returnTo: string } & Partial<SubjectChatData>)
  | { readonly status: 'invalid' }

export type StartTemporaryResult =
  | { readonly status: 'ok'; readonly id: string }
  | { readonly status: 'expired'; readonly returnTo: string }
  | { readonly status: 'invalid' }

const SUBJECT_CONVERSATION_LIMIT = 20

/** 对话列表行加上来源标签（未绑定对象为 null） */
export const subjectLabels =
  (locale: string) =>
  <T extends { subjectType: string | null }>(row: T): T & { subjectLabel: string | null } => ({
    ...row,
    subjectLabel: subjectLabel(row.subjectType, locale),
  })

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

async function requireSubject(ctx: SubjectRequestContext, ref: SubjectRef) {
  const resolved = await resolveConversationSubject(ctx, ref.type, ref.id)
  if (!resolved) throw notFound()
  return resolved
}

/** 打开持久对象的对话：默认进入最近一个未归档的对话 */
export async function loadSubjectChat(
  ctx: SubjectRequestContext,
  ref: SubjectRef,
  conversationId?: string,
): Promise<SubjectChatData> {
  const resolved = await requireSubject(ctx, ref)
  return loadChatData(
    ctx,
    ref,
    {
      type: ref.type,
      label: subjectLabel(ref.type, ctx.locale) ?? ref.type,
      title: resolved.title ?? null,
      suggestions: resolved.suggestions ?? [],
      defaultModelKey: resolved.defaultModelKey ?? null,
    },
    conversationId,
  )
}

/** 为持久对象新建对话：构建上下文并写成首条 system 消息 */
export async function startSubjectConversation(
  ctx: SubjectRequestContext,
  ref: SubjectRef,
): Promise<{ id: string }> {
  const resolved = await requireSubject(ctx, ref)
  // provider 返回的上下文同样受格式与总长度约束；错误信息不含正文
  const parsed = subjectSystemContextSchema.safeParse(await resolved.context())
  if (!parsed.success)
    throw new AppError('INVALID_SUBJECT_CONTEXT', 'Subject context is invalid or too large', {
      status: 422,
    })
  const context = parsed.data
  return insertSubjectConversation(ctx, ref, context, {
    title: resolved.title,
    modelKey: resolved.defaultModelKey,
    temporary: false,
  })
}

/** 临时上下文页的数据：令牌有效时显示已有对话；过期时只给返回引导（若已有对话仍可继续） */
export async function loadTemporarySubjectChat(
  ctx: SubjectRequestContext,
  deps: SubjectContextDeps,
  token: string,
): Promise<TemporarySubjectChat> {
  const opened = await openSubjectContext(deps, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    token,
  })
  if (opened.status === 'invalid') return { status: 'invalid' }
  const ref = { type: opened.subjectType, id: opened.subjectId }
  const view: SubjectView = {
    type: ref.type,
    label: subjectLabel(ref.type, ctx.locale) ?? ref.type,
    title: opened.status === 'ok' ? opened.stored.title : null,
    suggestions: opened.status === 'ok' ? opened.stored.suggestions : [],
    defaultModelKey: null,
  }
  const data = await loadChatData(ctx, ref, view)
  if (opened.status === 'ok') return { status: 'ok', returnTo: opened.returnTo, ...data }
  return data.conversation
    ? { status: 'expired', returnTo: opened.returnTo, ...data }
    : { status: 'expired', returnTo: opened.returnTo }
}

/** 凭临时上下文令牌新建对话 */
export async function startTemporarySubjectConversation(
  ctx: SubjectRequestContext,
  deps: SubjectContextDeps,
  token: string,
): Promise<StartTemporaryResult> {
  const opened = await openSubjectContext(deps, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    token,
  })
  if (opened.status === 'invalid') return { status: 'invalid' }
  if (opened.status === 'expired') return { status: 'expired', returnTo: opened.returnTo }
  const created = await insertSubjectConversation(
    ctx,
    { type: opened.subjectType, id: opened.subjectId },
    opened.stored.context,
    { title: opened.stored.title ?? undefined, modelKey: undefined, temporary: true },
  )
  return { status: 'ok', id: created.id }
}

async function insertSubjectConversation(
  ctx: SubjectRequestContext,
  ref: SubjectRef,
  context: SubjectSystemContext,
  options: { title: string | undefined; modelKey: string | undefined; temporary: boolean },
): Promise<{ id: string }> {
  const id = await ctx.db.transaction(async (tx) => {
    const t = scoped(tx, ctx.workspaceId)
    const [row] = await t
      .insert(aiConversation, {
        userId: ctx.userId,
        title: (options.title ?? '').trim().slice(0, CONVERSATION_TITLE_LENGTH),
        modelKey: options.modelKey ?? '',
        subjectType: ref.type,
        subjectId: ref.id,
      })
      .returning({ id: aiConversation.id })
    if (!row) throw new AppError('CONVERSATION_FAILED', 'Conversation was not created')
    await t.insert(aiMessage, {
      conversationId: row.id,
      role: 'system',
      parts: subjectSystemParts(ref.type, context),
    })
    return row.id
  })
  log.info('ai.subject_conversation.created', {
    conversationId: id,
    subjectType: ref.type,
    contextVersion: context.version,
    temporary: options.temporary,
  })
  return { id }
}

async function loadChatData(
  ctx: SubjectRequestContext,
  ref: SubjectRef,
  subject: SubjectView,
  conversationId?: string,
): Promise<SubjectChatData> {
  const s = scoped(ctx.db, ctx.workspaceId)
  const conversations = await s
    .select(aiConversation, {
      fields: {
        id: aiConversation.id,
        title: aiConversation.title,
        updatedAt: aiConversation.updatedAt,
      },
      where: and(
        eq(aiConversation.userId, ctx.userId),
        eq(aiConversation.subjectType, ref.type),
        eq(aiConversation.subjectId, ref.id),
        eq(aiConversation.archived, false),
      ) as SQL,
    })
    .orderBy(desc(aiConversation.id))
    .limit(SUBJECT_CONVERSATION_LIMIT)
  const current =
    (conversationId && conversations.find((row) => row.id === conversationId)) ||
    conversations[0] ||
    null
  if (!current) return { subject, conversation: null, conversations, messages: [], feedback: {} }
  const rows = await s
    .select(aiMessage, {
      fields: {
        id: aiMessage.id,
        role: aiMessage.role,
        parts: aiMessage.parts,
        status: aiMessage.status,
      },
      where: and(
        eq(aiMessage.conversationId, current.id),
        inArray(aiMessage.role, ['user', 'assistant']),
      ) as SQL,
    })
    .orderBy(...aiMessageOrder())
  const messages = rows.map((row) => ({
    ...row,
    parts: messageDisplayParts(
      row.parts,
      row.role === 'assistant' && templateConfig.ai.text.reasoning.display,
    ),
  }))
  const feedback = await feedbackForMessages(
    ctx,
    rows.filter((row) => row.role === 'assistant').map((row) => row.id),
  )
  return {
    subject,
    conversation: { id: current.id, title: current.title },
    conversations,
    messages,
    feedback,
  }
}
