import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { adminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import {
  deleteFeedback,
  feedbackSearchSchema,
  feedbackStats,
  listFeedback,
  readSharedConversation,
} from './feedback.ts'

export const getAdminFeedback = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(feedbackSearchSchema)
  .handler(async ({ context, data }) => {
    const [list, stats] = await Promise.all([
      listFeedback(context.db, data),
      feedbackStats(context.db, { from: data.from, to: data.to }),
    ])
    return { ...list, stats }
  })

export const deleteAdminFeedback = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.strictObject({ id: z.uuid() }))
  .handler(
    adminAction('ai.feedback.delete', ({ data, ...scope }) => deleteFeedback(scope, data.id)),
  )

/**
 * 查看用户同意共享的对话片段。读取也走 adminAction：实时管理员校验，并与读取同事务写审计；
 * 未同意时服务端返回 404，不返回正文。
 */
export const getAdminFeedbackConversation = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.strictObject({ id: z.uuid() }))
  .handler(
    adminAction('ai.feedback.view_conversation', ({ data, ...scope }) =>
      readSharedConversation(scope, data.id),
    ),
  )
