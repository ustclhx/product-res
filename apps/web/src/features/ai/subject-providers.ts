/**
 * 项目注册的对话对象类型（add-subject-chat design 决策 2）。模板只在此放示例注释，
 * 项目创建后模板不再修改本文件，template-sync 不会产生冲突。
 *
 * 示例：把一份报告注册为可追问的对象（`report` 表与文案由项目提供）。
 *
 * ```ts
 * import { report, scoped } from '@product-res/db'
 * import { and, eq, type SQL } from 'drizzle-orm'
 * import { registerConversationSubject } from './subjects.ts'
 *
 * registerConversationSubject('report', {
 *   label: (locale) => (locale === 'zh' ? '报告' : 'Report'),
 *   async resolve(ctx, subjectId) {
 *     // 必须同时校验空间与用户；查不到即返回 null（统一 404）
 *     const [row] = await scoped(ctx.db, ctx.workspaceId)
 *       .select(report, { where: and(eq(report.id, subjectId), eq(report.userId, ctx.userId)) as SQL })
 *       .limit(1)
 *     if (!row) return null
 *     return {
 *       title: row.title,
 *       suggestions: ctx.locale === 'zh' ? ['总结要点'] : ['Summarize the key points'],
 *       context: async () => ({ version: 'report-v1', text: row.summary, data: row.result }),
 *     }
 *   },
 * })
 *
 * // 只经临时上下文令牌使用的类型（无持久对象）：省略 resolve
 * registerConversationSubject('result', { label: (locale) => (locale === 'zh' ? '结果' : 'Result') })
 * ```
 */
export {}
