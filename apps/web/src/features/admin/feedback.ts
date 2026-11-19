import { aiMessageOrder, messageText } from '@product-res/ai'
import {
  AI_FEEDBACK_REASONS,
  type AiFeedbackReason,
  aiConversation,
  aiMessage,
  aiMessageFeedback,
  type Database,
  scoped,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, count, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { FEEDBACK_SHARED_PRIOR_MESSAGES, scrubSecrets } from '../ai/feedback.ts'
import type { AdminActionScope } from './action.ts'
import { ADMIN_PAGE_SIZE } from './list.ts'

/**
 * 后台 AI 回复反馈（add-subject-chat tasks.md 4.1、10.x，specs/admin-console「AI 回复反馈列表」「满意率统计」
 * 「查看用户共享的对话」）。列表只读评分、点踩原因、反馈文字与共享标记，不联查对话正文或对象上下文；
 * 用户同意共享的条目经 `readSharedConversation` 单独读取对话片段并写审计；删除经 adminAction 写审计（不含反馈文字）。
 */

const date = z.iso.date()

export const feedbackSearchSchema = z
  .object({
    offset: z.number().int().min(0).max(100_000),
    // 地址栏中的非法评分值按未筛选处理
    rating: z
      .string()
      .max(16)
      .optional()
      .transform((value) => (value === 'up' || value === 'down' ? value : undefined)),
    // 点踩原因；非法值同样按未筛选处理
    reason: z
      .string()
      .max(32)
      .optional()
      .transform((value) =>
        (AI_FEEDBACK_REASONS as readonly string[]).includes(value ?? '')
          ? (value as AiFeedbackReason)
          : undefined,
      ),
    // 共享对话：yes / no；非法值按未筛选处理
    shared: z
      .string()
      .max(8)
      .optional()
      .transform((value) => (value === 'yes' || value === 'no' ? value : undefined)),
    model: z.string().max(200).optional(),
    subjectType: z.string().max(64).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Start date must precede end date',
  })
export type FeedbackSearch = z.infer<typeof feedbackSearchSchema>

/** 未选日期时统计最近 30 天（含今天，UTC） */
const STATS_DAYS = 30
const DAY_MS = 86_400_000

function range(input: { from?: string | undefined; to?: string | undefined }, now: Date) {
  const to = input.to ?? now.toISOString().slice(0, 10)
  const from =
    input.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (STATS_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)
  return {
    from,
    to,
    where: and(
      gte(aiMessageFeedback.createdAt, new Date(`${from}T00:00:00Z`)),
      lt(aiMessageFeedback.createdAt, new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS)),
    ) as SQL,
  }
}

/** 「无对象」在筛选中用 `-` 表示，统计中归为一组 */
export const NO_SUBJECT = '-'

export async function listFeedback(db: Database, input: z.input<typeof feedbackSearchSchema>) {
  const data = feedbackSearchSchema.parse(input)
  const where = and(
    data.rating ? eq(aiMessageFeedback.rating, data.rating) : undefined,
    data.reason ? eq(aiMessageFeedback.reason, data.reason) : undefined,
    data.shared ? eq(aiMessageFeedback.shareConversation, data.shared === 'yes') : undefined,
    data.model ? eq(aiMessageFeedback.modelKey, data.model) : undefined,
    data.subjectType
      ? data.subjectType === NO_SUBJECT
        ? sql`${aiMessageFeedback.subjectType} is null`
        : eq(aiMessageFeedback.subjectType, data.subjectType)
      : undefined,
    data.from ? gte(aiMessageFeedback.createdAt, new Date(`${data.from}T00:00:00Z`)) : undefined,
    data.to
      ? lt(aiMessageFeedback.createdAt, new Date(Date.parse(`${data.to}T00:00:00Z`) + DAY_MS))
      : undefined,
  )
  const rows = await db
    .select({
      id: aiMessageFeedback.id,
      createdAt: aiMessageFeedback.createdAt,
      workspaceId: aiMessageFeedback.workspaceId,
      messageId: aiMessageFeedback.messageId,
      rating: aiMessageFeedback.rating,
      comment: aiMessageFeedback.comment,
      reason: aiMessageFeedback.reason,
      shareConversation: aiMessageFeedback.shareConversation,
      modelKey: aiMessageFeedback.modelKey,
      subjectType: aiMessageFeedback.subjectType,
    })
    // biome-ignore lint/plugin: 已通过实时管理员守卫，后台反馈列表允许跨空间查询。
    .from(aiMessageFeedback)
    .where(where)
    .orderBy(desc(aiMessageFeedback.id))
    .offset(data.offset)
    .limit(ADMIN_PAGE_SIZE + 1)
  return { rows: rows.slice(0, ADMIN_PAGE_SIZE), hasMore: rows.length > ADMIN_PAGE_SIZE }
}

export interface SatisfactionRow {
  readonly key: string
  readonly up: number
  readonly down: number
  /** up / (up + down) */
  readonly rate: number
}

/** 按模型与对象类型分组的满意率；没有评分的分组不出现 */
export async function feedbackStats(
  db: Database,
  input: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
) {
  const { from, to, where } = range(input, now)
  const group = async (column: SQL) => {
    const rows = await db
      .select({
        key: sql<string>`coalesce(${column}, ${NO_SUBJECT})`,
        up: count(sql`case when ${aiMessageFeedback.rating} = 'up' then 1 end`),
        down: count(sql`case when ${aiMessageFeedback.rating} = 'down' then 1 end`),
      })
      // biome-ignore lint/plugin: 已通过实时管理员守卫，满意率统计按全平台汇总。
      .from(aiMessageFeedback)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`)
    return rows.map(
      (row): SatisfactionRow => ({ ...row, rate: row.up / Math.max(1, row.up + row.down) }),
    )
  }
  const [byModel, bySubject] = await Promise.all([
    group(sql`${aiMessageFeedback.modelKey}`),
    group(sql`${aiMessageFeedback.subjectType}`),
  ])
  return { from, to, byModel, bySubject }
}

/** 删除单条反馈；审计只记 ID、空间、模型、对象类型与评分，不记反馈文字 */
export async function deleteFeedback(scope: AdminActionScope, id: string) {
  const [row] = await scope.tx
    // biome-ignore lint/plugin: 平台管理员按反馈 ID 删除，空间来自被删行并写入审计。
    .delete(aiMessageFeedback)
    .where(eq(aiMessageFeedback.id, id))
    .returning({
      workspaceId: aiMessageFeedback.workspaceId,
      modelKey: aiMessageFeedback.modelKey,
      subjectType: aiMessageFeedback.subjectType,
      rating: aiMessageFeedback.rating,
    })
  if (!row) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  await scope.audit({
    action: 'ai.feedback.delete',
    targetType: 'ai_message_feedback',
    targetId: id,
    workspaceId: row.workspaceId,
    meta: { modelKey: row.modelKey, subjectType: row.subjectType, rating: row.rating },
  })
  return { deleted: true }
}

export interface SharedConversationMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  /** 只取文本片段（推理、工具调用与数据片段不展示），并按反馈文字的规则去除疑似密钥 */
  readonly text: string
  /** 是否为被评的回复 */
  readonly rated: boolean
}

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

/**
 * 读取用户同意共享的对话片段（design 决策 6「共享对话同意」）：被评回复加上它之前最近
 * `FEEDBACK_SHARED_PRIOR_MESSAGES` 条 user/assistant 消息，不含 system 消息（对象上下文）与之后的消息。
 * 同意状态在服务端检查：未同意、记录不存在、已撤回，或被评回复不在该空间、对话不属于评分者，一律 404
 * （记 warn 日志，事务回滚、不留审计）；
 * 成功读取时在同一事务内写审计，审计只含反馈 ID、空间、消息 ID 与条数，不含正文。
 */
export async function readSharedConversation(scope: AdminActionScope, id: string) {
  const [feedback] = await scope.tx
    .select({
      workspaceId: aiMessageFeedback.workspaceId,
      messageId: aiMessageFeedback.messageId,
      userId: aiMessageFeedback.userId,
      shareConversation: aiMessageFeedback.shareConversation,
    })
    // biome-ignore lint/plugin: 平台管理员按反馈 ID 读取；正文随后按该行的空间经 scoped 查询。
    .from(aiMessageFeedback)
    .where(eq(aiMessageFeedback.id, id))
    .limit(1)
    // 与用户撤回互斥：读取正文期间同意不会被改写
    .for('share')
  // 未同意或已撤回时仍被请求正文，可能是直接调用接口；只记管理员与反馈 ID
  const refuse = () => {
    log.warn('ai.feedback.view_conversation_refused', { adminId: scope.admin.id, feedbackId: id })
    return notFound()
  }
  if (!feedback?.shareConversation) throw refuse()
  const tenant = scoped(scope.tx, feedback.workspaceId)
  const fields = {
    id: aiMessage.id,
    role: aiMessage.role,
    parts: aiMessage.parts,
    conversationId: aiMessage.conversationId,
  }
  const [rated] = await tenant
    .select(aiMessage, {
      // created_at 以文本取回，保留微秒精度供下面的比较（JS Date 只到毫秒）
      fields: { ...fields, createdAt: sql<string>`${aiMessage.createdAt}::text` },
      where: and(eq(aiMessage.id, feedback.messageId), eq(aiMessage.role, 'assistant')) as SQL,
    })
    .limit(1)
  // 被评回复必须在反馈行所属空间内（租户隔离），且对话属于评分者本人；否则同样拒绝
  const [conversation] = rated
    ? await tenant
        .select(aiConversation, {
          fields: { id: aiConversation.id },
          where: and(
            eq(aiConversation.id, rated.conversationId),
            eq(aiConversation.userId, feedback.userId),
          ) as SQL,
        })
        .limit(1)
    : []
  if (!rated || !conversation) throw refuse()
  // 顺序与对话页一致，用 @product-res/ai 的 aiMessageOrder：(created_at, 同一轮用户在前, id)。
  // 「早于被评回复」按同一组排序键做行比较；created_at 以文本代入，保留微秒精度
  const prior = await tenant
    .select(aiMessage, {
      fields,
      where: and(
        eq(aiMessage.conversationId, rated.conversationId),
        inArray(aiMessage.role, ['user', 'assistant']),
        sql`(${aiMessage.createdAt}, case when ${aiMessage.role} = 'user' then 0 else 1 end, ${aiMessage.id}) < (${rated.createdAt}::timestamptz, 1, ${rated.id}::uuid)`,
      ) as SQL,
    })
    .orderBy(...aiMessageOrder('desc'))
    .limit(FEEDBACK_SHARED_PRIOR_MESSAGES)
  const messages: SharedConversationMessage[] = [...prior.reverse(), rated].map((row) => ({
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    text: scrubSecrets(messageText(Array.isArray(row.parts) ? row.parts : [])),
    rated: row.id === rated.id,
  }))
  await scope.audit({
    action: 'ai.feedback.view_conversation',
    targetType: 'ai_message_feedback',
    targetId: id,
    workspaceId: feedback.workspaceId,
    meta: { messageId: feedback.messageId, messageCount: messages.length },
  })
  return { messages }
}
