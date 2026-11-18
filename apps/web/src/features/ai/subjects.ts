import type { Database, JsonValue } from '@product-res/db'

/**
 * 对话绑定对象的提供者注册表（add-subject-chat design 决策 2，specs/ai-chat「对话绑定业务对象」）。
 *
 * 衍生项目在 `subject-providers.ts` 中调用 `registerConversationSubject` 注册对象类型；
 * provider 负责鉴权（对象必须属于当前空间且当前用户可访问，否则返回 null，统一按 404 处理）
 * 与上下文构建。上下文只在新建对话时构建一次，写成对话的首条 system 消息。
 */

export interface SubjectRequestContext {
  readonly db: Database
  readonly workspaceId: string
  readonly userId: string
  /** 当前界面语言，用于推荐问题与标题 */
  readonly locale: string
}

/** 对象上下文：文本与结构化数据至少其一；版本号随提示词或数据口径变化递增 */
export interface SubjectSystemContext {
  readonly version: string
  readonly text?: string | undefined
  readonly data?: JsonValue | undefined
}

export interface ResolvedSubject {
  /** 新对话的默认标题 */
  readonly title?: string
  /** 计费模型默认值（模型 key）；当前套餐不可用时回落到第一个可用模型 */
  readonly defaultModelKey?: string
  /** 开场推荐问题，已按 `ctx.locale` 给出 */
  readonly suggestions?: readonly string[]
  /** 只在新建对话时调用 */
  context(): Promise<SubjectSystemContext>
}

export interface ConversationSubjectProvider {
  /** 对话列表上的来源标签，不查库 */
  label(locale: string): string
  /**
   * 鉴权并读取对象：必须同时校验 `workspaceId` 与 `userId`；不存在或无权访问时返回 null。
   * 省略时该类型只能经临时上下文令牌使用（见 subject-context.ts）。
   */
  resolve?(ctx: SubjectRequestContext, subjectId: string): Promise<ResolvedSubject | null>
}

export const SUBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/
export const SUBJECT_ID_MAX_LENGTH = 128

const providers = new Map<string, ConversationSubjectProvider>()

export function registerConversationSubject(
  type: string,
  provider: ConversationSubjectProvider,
): () => void {
  if (!SUBJECT_TYPE_PATTERN.test(type)) throw new RangeError(`Invalid subject type: ${type}`)
  if (providers.has(type)) throw new RangeError(`Subject type already registered: ${type}`)
  providers.set(type, provider)
  return () => {
    if (providers.get(type) === provider) providers.delete(type)
  }
}

export function getConversationSubject(type: string): ConversationSubjectProvider | undefined {
  return providers.get(type)
}

/** 对话列表的来源标签；类型已不再注册时显示类型本身 */
export function subjectLabel(type: string | null, locale: string): string | null {
  if (type === null) return null
  try {
    return providers.get(type)?.label(locale) ?? type
  } catch {
    return type
  }
}

/** 解析持久对象：未注册类型、无 resolve 的类型与无权访问的对象一律返回 null（调用方按 404 处理） */
export async function resolveConversationSubject(
  ctx: SubjectRequestContext,
  type: string,
  subjectId: string,
): Promise<ResolvedSubject | null> {
  const provider = providers.get(type)
  if (!provider?.resolve || subjectId.length > SUBJECT_ID_MAX_LENGTH) return null
  return provider.resolve(ctx, subjectId)
}
