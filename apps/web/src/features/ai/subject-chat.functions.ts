import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getLocale } from '../../paraglide/runtime.js'
import { withBilling } from '../../server/feature-gates.ts'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { feedbackInputSchema } from './feedback.ts'
import { SUBJECT_ID_MAX_LENGTH, SUBJECT_TYPE_PATTERN } from './subjects.ts'

// 对象对话、临时上下文与消息评分的 server function（add-subject-chat tasks.md 2.3、3.2）。
// 输入一律 strictObject：客户端只能传对象引用或令牌，附带上下文正文等多余字段直接拒绝。
// 数据库逻辑与项目 provider 注册（有副作用）在 *.server.ts 中，handler 内动态导入，
// 不进入浏览器 bundle。

const slug = z.string().min(1).max(64)
const subjectRef = z.strictObject({
  type: z.string().regex(SUBJECT_TYPE_PATTERN),
  id: z.string().min(1).max(SUBJECT_ID_MAX_LENGTH),
})
const token = z.string().min(1).max(1024)

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
    if (!(error instanceof AppError)) log.error('ai.subject_chat.failed', { error })
    return { ok: false, error: error instanceof AppError ? error.code : 'CONVERSATION_FAILED' }
  }
}

function requestContext(context: {
  db: Database
  workspace: { id: string }
  user: { id: string }
}) {
  return {
    db: context.db,
    workspaceId: context.workspace.id,
    userId: context.user.id,
    locale: getLocale(),
  }
}

function contextDeps() {
  const runtime = getWebRuntime()
  return { secret: runtime.config.BETTER_AUTH_SECRET, cache: runtime.cache }
}

/** 嵌入式对象对话的数据；未注册、不存在或无权访问的对象返回 404 */
export const getSubjectChat = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(
    z.strictObject({ slug, subject: subjectRef, conversationId: z.uuid().optional() }),
  )
  .handler(async ({ context, data }) => {
    const { loadSubjectChat } = await import('./subject-chat.server.ts')
    try {
      const chat = await loadSubjectChat(requestContext(context), data.subject, data.conversationId)
      return { ...chat, readOnly: context.workspaceReadOnly }
    } catch (error) {
      if (error instanceof AppError && error.status === 404) throw notFound()
      throw error
    }
  })

/** 为对象新建对话（上下文由服务端构建并写成首条 system 消息） */
export const startSubjectConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.strictObject({ slug, subject: subjectRef }))
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      const { startSubjectConversation } = await import('./subject-chat.server.ts')
      return startSubjectConversation(requestContext(context), data.subject)
    }),
  )

/** 临时上下文页：令牌无效、过期（附返回地址）或有效时的对话数据 */
export const getTemporarySubjectChat = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.strictObject({ slug, token }))
  .handler(async ({ context, data }) => {
    const { loadTemporarySubjectChat } = await import('./subject-chat.server.ts')
    const chat = await loadTemporarySubjectChat(requestContext(context), contextDeps(), data.token)
    return { ...chat, readOnly: context.workspaceReadOnly }
  })

/** 凭临时上下文令牌新建对话 */
export const startTemporarySubjectConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.strictObject({ slug, token }))
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      const { startTemporarySubjectConversation } = await import('./subject-chat.server.ts')
      return startTemporarySubjectConversation(requestContext(context), contextDeps(), data.token)
    }),
  )

/** 设置、修改或撤销对助手回复的评分 */
export const setMessageFeedback = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(feedbackInputSchema)
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      const { saveMessageFeedback } = await import('./feedback.server.ts')
      return saveMessageFeedback(
        { db: context.db, workspaceId: context.workspace.id, userId: context.user.id },
        data,
      )
    }),
  )

/** 某条助手回复的后续推荐问题；配置关闭时返回空列表 */
export const getFollowUps = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.strictObject({ slug, messageId: z.uuid() }))
  .handler(async ({ context, data }) => {
    if (!templateConfig.ai.text.followUps.enabled || context.workspaceReadOnly)
      return { questions: [] }
    const [{ generateFollowUps }, { getAiHttpDeps }] = await Promise.all([
      import('./follow-ups.server.ts'),
      import('./runtime.ts'),
    ])
    const deps = getAiHttpDeps()
    return generateFollowUps(
      { ...deps, cache: getWebRuntime().cache },
      { workspaceId: context.workspace.id, userId: context.user.id },
      data.messageId,
    )
  })
