import { aiMessageOrder } from '@product-res/ai'
import { aiConversation, aiMessage, type Database, scoped } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getLocale } from '../../paraglide/runtime.js'
import { withBilling } from '../../server/feature-gates.ts'
import { withWorkspace } from '../../server/middleware.ts'
import { templateConfig } from '../../server/template-config.ts'
import { conversationTitleSchema, messageDisplayParts } from './conversation.ts'
import { feedbackForMessages } from './feedback.server.ts'

// 对话列表与对话页的数据（tasks.md 3.1，specs/ai-chat「会话管理」）。
// 对话只对创建者可见：所有读写都在 scoped(ws) 之上再按 user_id 过滤，
// 他人的对话与不存在的对话一样返回 404（空间 owner / admin 也不例外）。

const workspace = z.object({ slug: z.string().min(1).max(64) })
const conversationInput = workspace.extend({ conversationId: z.uuid() })

/** 列表每组最多返回的对话数 */
const LIST_LIMIT = 100

const ownConversation = (userId: string, conversationId?: string) =>
  and(
    eq(aiConversation.userId, userId),
    conversationId === undefined ? undefined : eq(aiConversation.id, conversationId),
  ) as SQL

type MutationResult<T> = { ok: true; result: T } | { ok: false; error: string }

async function mutation<T>(
  readOnly: boolean,
  action: () => Promise<T>,
): Promise<MutationResult<T>> {
  try {
    if (readOnly)
      throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', {
        status: 403,
      })
    return { ok: true, result: await action() }
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500)
      log.error('ai.conversation.failed', { error })
    return { ok: false, error: error instanceof AppError ? error.code : 'CONVERSATION_FAILED' }
  }
}

async function updateOwn(
  db: Database,
  workspaceId: string,
  userId: string,
  conversationId: string,
  set: { title?: string; archived?: boolean },
) {
  const rows = await scoped(db, workspaceId)
    .update(aiConversation, set, ownConversation(userId, conversationId))
    .returning({ id: aiConversation.id })
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  return { id: conversationId }
}

export const listConversations = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => {
    const s = scoped(context.db, context.workspace.id)
    const fields = {
      id: aiConversation.id,
      title: aiConversation.title,
      archived: aiConversation.archived,
      updatedAt: aiConversation.updatedAt,
      subjectType: aiConversation.subjectType,
    }
    const list = (archived: boolean) =>
      s
        .select(aiConversation, {
          fields,
          where: and(
            ownConversation(context.user.id),
            eq(aiConversation.archived, archived),
          ) as SQL,
        })
        .orderBy(desc(aiConversation.id))
        .limit(LIST_LIMIT)
    const [[active, archived], { subjectLabels }] = await Promise.all([
      Promise.all([list(false), list(true)]),
      import('./subject-chat.server.ts'),
    ])
    // 来源标签按当前语言由已注册的 provider 给出，不查对象本身
    const labelled = subjectLabels(getLocale())
    return {
      active: active.map(labelled),
      archived: archived.map(labelled),
      readOnly: context.workspaceTeamReadOnly,
    }
  })

export const getConversation = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput)
  .handler(async ({ context, data }) => {
    const s = scoped(context.db, context.workspace.id)
    const [conversation] = await s
      .select(aiConversation, {
        fields: {
          id: aiConversation.id,
          title: aiConversation.title,
          archived: aiConversation.archived,
        },
        where: ownConversation(context.user.id, data.conversationId),
      })
      .limit(1)
    if (!conversation) throw notFound()
    const messages = await s
      .select(aiMessage, {
        fields: {
          id: aiMessage.id,
          role: aiMessage.role,
          parts: aiMessage.parts,
          status: aiMessage.status,
          credits: aiMessage.credits,
          modelKey: aiMessage.modelKey,
        },
        where: and(
          eq(aiMessage.conversationId, conversation.id),
          inArray(aiMessage.role, ['user', 'assistant']),
        ) as SQL,
      })
      .orderBy(...aiMessageOrder())
    const feedback = await feedbackForMessages(
      { db: context.db, workspaceId: context.workspace.id, userId: context.user.id },
      messages.filter((message) => message.role === 'assistant').map((message) => message.id),
    )
    return {
      conversation,
      feedback,
      messages: messages.map((message) => ({
        ...message,
        parts: messageDisplayParts(
          message.parts,
          message.role === 'assistant' && templateConfig.ai.text.reasoning.display,
        ),
      })),
      readOnly: context.workspaceTeamReadOnly,
    }
  })

/**
 * 单条回复的保存结果（正文、状态、结算积分与模型）：回复结束（完成、停止、出错、断开）后对话页据此
 * 把本地消息换成已保存、已计费的版本（停止后服务端可能比客户端多生成一段）。他人或不存在的消息返回 null。
 */
export const getChatMessage = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace.extend({ messageId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const s = scoped(context.db, context.workspace.id)
    const [message] = await s
      .select(aiMessage, {
        fields: {
          id: aiMessage.id,
          role: aiMessage.role,
          parts: aiMessage.parts,
          status: aiMessage.status,
          credits: aiMessage.credits,
          modelKey: aiMessage.modelKey,
        },
        where: and(
          eq(aiMessage.id, data.messageId),
          eq(aiMessage.role, 'assistant'),
          inArray(
            aiMessage.conversationId,
            s.select(aiConversation, {
              where: ownConversation(context.user.id),
              fields: { id: aiConversation.id },
            }),
          ),
        ) as SQL,
      })
      .limit(1)
    if (!message) return null
    return {
      ...message,
      parts: messageDisplayParts(message.parts, templateConfig.ai.text.reasoning.display),
    }
  })

/** 新建空对话；标题在首轮回复完成后由对话页按首条消息填入，模型在发送时选择 */
export const createConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace)
  .handler(({ context }) =>
    mutation(context.workspaceTeamReadOnly, async () => {
      const [row] = await scoped(context.db, context.workspace.id)
        .insert(aiConversation, { userId: context.user.id, title: '', modelKey: '' })
        .returning({ id: aiConversation.id })
      if (!row) throw new AppError('CONVERSATION_FAILED', 'Conversation was not created')
      return row
    }),
  )

export const renameConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput.extend({ title: conversationTitleSchema }))
  .handler(({ context, data }) =>
    mutation(context.workspaceTeamReadOnly, () =>
      updateOwn(context.db, context.workspace.id, context.user.id, data.conversationId, {
        title: data.title,
      }),
    ),
  )

export const setConversationArchived = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput.extend({ archived: z.boolean() }))
  .handler(({ context, data }) =>
    mutation(context.workspaceTeamReadOnly, () =>
      updateOwn(context.db, context.workspace.id, context.user.id, data.conversationId, {
        archived: data.archived,
      }),
    ),
  )
