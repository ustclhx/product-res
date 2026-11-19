import { z } from 'zod'

/**
 * 消息评分的共享类型与纯函数（add-subject-chat design 决策 6，specs/ai-chat「消息评分」）。
 * 浏览器与服务端都会导入本文件，数据库读写在 `feedback.server.ts`。
 */

export type FeedbackRating = 'up' | 'down'

/**
 * 点踩原因（单选、可不选）。取值与 `@product-res/db` 的 `AI_FEEDBACK_REASONS` 及 check 约束一致；
 * 这里另写一份是因为本文件进入浏览器包，不能引入 db 包（单元测试比对两者）。
 */
export const FEEDBACK_REASONS = ['inaccurate', 'incomplete', 'no_source', 'too_long'] as const
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

export const isFeedbackReason = (value: unknown): value is FeedbackReason =>
  (FEEDBACK_REASONS as readonly unknown[]).includes(value)

export interface MessageFeedbackValue {
  readonly rating: FeedbackRating
  readonly comment: string | null
  /** 只在点踩时可能有值 */
  readonly reason: FeedbackReason | null
  /**
   * 是否同意把这段对话共享给平台用于改进（只属于本条反馈，再次提交时不勾选即撤回）。
   * 缺省视为 false；服务端返回值总是带上该字段。
   */
  readonly shareConversation?: boolean
}

export const FEEDBACK_COMMENT_MAX_LENGTH = 1000

/**
 * 同意共享时后台可见的范围：被评的回复，加上它之前最近的这么多条 user/assistant 消息
 * （add-subject-chat design 决策 6「共享对话同意」）。3 条覆盖本轮提问和上一轮完整问答，
 * 足以看懂追问类问题；更早的内容与 system 消息（对象上下文）不共享。勾选项文案引用同一数值。
 */
export const FEEDBACK_SHARED_PRIOR_MESSAGES = 3

export const feedbackInputSchema = z.strictObject({
  slug: z.string().min(1).max(64),
  messageId: z.uuid(),
  /** null = 撤销 */
  rating: z.enum(['up', 'down']).nullable(),
  comment: z.string().max(FEEDBACK_COMMENT_MAX_LENGTH).optional(),
  /** 只允许与点踩一起提交；点赞或撤销时服务端清空 */
  reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
  /** 共享对话同意；不传按不同意处理（每次保存整体写入，因此不勾选即撤回） */
  shareConversation: z.boolean().optional(),
})
export type FeedbackInput = z.infer<typeof feedbackInputSchema>

const REDACTED = '[REDACTED]'

/**
 * 反馈文字入库前去除疑似密钥与令牌：反馈用于迭代提示词，会在后台被多人查看。
 * 只做常见形态的保守替换（链接凭据、密码/密钥键值、API Key 前缀、Bearer、AWS / Google / Stripe webhook /
 * Slack / GitHub 令牌、JWT、长十六进制/base64 串）。
 */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // 链接中的用户名与密码：保留协议与主机，便于理解反馈
  [/:\/\/[^/\s:]+:[^@\s]+@/g, `://${REDACTED}@`],
  // 形如 password=… / api_key: … 的键值
  [/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, REDACTED],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{24,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr])_[A-Za-z0-9_]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b[A-Fa-f0-9]{32,}\b/g, REDACTED],
  [/(?<![A-Za-z0-9+/])[A-Za-z0-9+/_-]{40,}={0,2}/g, REDACTED],
]

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    text,
  )
}

/** 规范化反馈文字：去首尾空白、去密钥，空串存为 null */
export function normalizeFeedbackComment(comment: string | undefined): string | null {
  const trimmed = comment?.trim() ?? ''
  return trimmed ? scrubSecrets(trimmed).slice(0, FEEDBACK_COMMENT_MAX_LENGTH) : null
}
