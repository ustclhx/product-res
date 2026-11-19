import type { JsonValue } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { z } from 'zod'
import { getConversationSubject, type SubjectSystemContext } from './subjects.ts'
// 项目注册的对象类型（副作用导入）：签发入口可能在冷启动 isolate 上先于对象对话被调用，
// 必须在这里确保注册表已就绪。本模块只在服务端引用。
import './subject-providers.ts'

/**
 * 对象上下文的 system 消息与临时上下文令牌（add-subject-chat design 决策 3、4，
 * specs/ai-chat「对象上下文只写一次」「临时上下文令牌」）。
 *
 * 临时上下文用于没有持久对象的场景（如免费结果页）：服务端把上下文存进短期 KV（随机键），
 * 地址里只放签名令牌 `{v, id, uid, ws, type, returnTo, exp}`（绑定用户与空间）。令牌只签名不加密，不携带上下文正文；
 * 凭令牌新建对话时验签、核对用户与有效期，再从 KV 取出上下文写成首条 system 消息。
 */

export const SUBJECT_CONTEXT_PART = 'data-subject-context'
export const SUBJECT_CONTEXT_PARAM = 'token'
export const SUBJECT_CONTEXT_TTL_MS = 30 * 60_000
const KV_PREFIX = 'subject-context:'
const TOKEN_SCOPE = 'subject-context'
const MAX_TOKEN_LENGTH = 1024
const MAX_SUGGESTIONS = 6

/** system 消息的固定头：同一上下文每轮逐字节相同，便于服务商的前缀缓存 */
export function subjectSystemText(subjectType: string, context: SubjectSystemContext): string {
  const lines = [`[context type=${subjectType} version=${context.version}]`]
  if (context.text) lines.push(context.text)
  if (context.data !== undefined) lines.push('```json', JSON.stringify(context.data), '```')
  return lines.join('\n')
}

/** 首条 system 消息的 parts：文本进提示词；数据片段只存元数据，不重复正文 */
export function subjectSystemParts(subjectType: string, context: SubjectSystemContext): unknown[] {
  return [
    { type: 'text', text: subjectSystemText(subjectType, context) },
    { type: SUBJECT_CONTEXT_PART, data: { subjectType, version: context.version } },
  ]
}

/** system 上下文的总长度上限（字符）：控制每轮固定前缀的成本与 KV 单值大小 */
export const SUBJECT_CONTEXT_MAX_CHARS = 200_000

export const subjectSystemContextSchema = z
  .object({
    version: z.string().min(1).max(64),
    text: z.string().max(SUBJECT_CONTEXT_MAX_CHARS).optional(),
    data: z.json().optional(),
  })
  .refine((value) => value.text !== undefined || value.data !== undefined, {
    message: 'Context needs text or data',
  })
  .refine((value) => subjectSystemText('_', value).length <= SUBJECT_CONTEXT_MAX_CHARS, {
    message: 'Context is too large',
  })

const suggestionsSchema = z.array(z.string().trim().min(1).max(200)).max(MAX_SUGGESTIONS)

const storedSchema = z.object({
  subjectType: z.string().min(1).max(64),
  context: subjectSystemContextSchema,
  title: z.string().max(200).nullable(),
  suggestions: suggestionsSchema,
})
export type StoredSubjectContext = z.infer<typeof storedSchema>

const payloadSchema = z.strictObject({
  v: z.literal(1),
  id: z.uuid(),
  uid: z.string().min(1).max(64),
  ws: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  returnTo: z.string().max(512),
  exp: z.number().int().positive(),
})

export interface SubjectContextDeps {
  readonly secret: string
  readonly cache: KeyValueStore
  readonly now?: number
}

export type OpenedSubjectContext =
  | {
      readonly status: 'ok'
      readonly subjectType: string
      /** 临时对话的 subject_id：KV 随机键 */
      readonly subjectId: string
      readonly returnTo: string
      readonly stored: StoredSubjectContext
    }
  | {
      readonly status: 'expired'
      readonly subjectType: string
      readonly subjectId: string
      readonly returnTo: string
    }
  | { readonly status: 'invalid' }

/** 站内路径：单个 `/` 开头，不含反斜杠、控制字符与协议 */
export function isSafeReturnPath(value: string): boolean {
  return (
    value.length <= 512 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) &&
    !/^\/[^/?#]*:/.test(value)
  )
}

/**
 * 存入上下文并签发令牌（服务端调用；上下文必须由服务端复算或读取，不能直接取自客户端提交）。
 * 类型必须已注册，以便对话列表显示来源标签。
 */
export async function issueSubjectContext(
  deps: SubjectContextDeps,
  input: {
    userId: string
    /** 签发时的空间：令牌只能在同一空间中使用 */
    workspaceId: string
    subjectType: string
    context: SubjectSystemContext
    title?: string
    suggestions?: readonly string[]
    returnTo: string
  },
): Promise<{ token: string; subjectId: string; expiresAt: number }> {
  if (!getConversationSubject(input.subjectType))
    throw new RangeError(`Subject type is not registered: ${input.subjectType}`)
  if (!isSafeReturnPath(input.returnTo)) throw new RangeError('returnTo must be a same-site path')
  const stored = storedSchema.parse({
    subjectType: input.subjectType,
    context: input.context,
    title: input.title ?? null,
    suggestions: input.suggestions ?? [],
  })
  const now = deps.now ?? Date.now()
  const id = crypto.randomUUID()
  await deps.cache.put(`${KV_PREFIX}${id}`, JSON.stringify(stored), {
    expirationTtl: SUBJECT_CONTEXT_TTL_MS / 1000,
  })
  const exp = now + SUBJECT_CONTEXT_TTL_MS
  const token = await signToken(deps.secret, {
    v: 1,
    id,
    uid: input.userId,
    ws: input.workspaceId,
    type: input.subjectType,
    returnTo: input.returnTo,
    exp,
  })
  return { token, subjectId: id, expiresAt: exp }
}

/**
 * 验签并取出上下文：格式或签名无效、不属于当前用户一律 invalid（不回显返回地址）；
 * 过期或 KV 已失效为 expired，附返回地址供页面引导回原页。
 */
export async function openSubjectContext(
  deps: SubjectContextDeps,
  input: { userId: string; workspaceId: string; token: string },
): Promise<OpenedSubjectContext> {
  const payload = await verifyToken(deps.secret, input.token)
  // 用户、空间不符或返回地址不安全（防御签发端遗漏）一律按无效处理
  if (
    !payload ||
    payload.uid !== input.userId ||
    payload.ws !== input.workspaceId ||
    !isSafeReturnPath(payload.returnTo)
  )
    return { status: 'invalid' }
  const base = { subjectType: payload.type, subjectId: payload.id, returnTo: payload.returnTo }
  if (payload.exp <= (deps.now ?? Date.now())) return { status: 'expired', ...base }
  const raw = await deps.cache.get(`${KV_PREFIX}${payload.id}`)
  const stored = raw === null ? null : storedSchema.safeParse(safeJson(raw))
  if (!stored?.success || stored.data.subjectType !== payload.type)
    return { status: 'expired', ...base }
  return { status: 'ok', ...base, stored: stored.data }
}

/** 数据片段中的上下文元数据（不含正文）；不是对象上下文消息时返回 null */
export function subjectContextMeta(
  parts: readonly unknown[],
): { subjectType: string; version: string } | null {
  const schema = z.object({
    type: z.literal(SUBJECT_CONTEXT_PART),
    data: z.object({ subjectType: z.string(), version: z.string() }),
  })
  for (const part of parts) {
    const parsed = schema.safeParse(part)
    if (parsed.success) return parsed.data.data
  }
  return null
}

function safeJson(raw: string): JsonValue | null {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return null
  }
}

// 令牌：`<base64url(JSON)>.<base64url(HMAC-SHA256)>`；用途前缀参与密钥派生，与其他令牌不能互相冒用。
const encoder = new TextEncoder()
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(`${TOKEN_SCOPE}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

async function signToken(secret: string, payload: z.infer<typeof payloadSchema>) {
  const body = encode(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))
  return `${body}.${encode(new Uint8Array(signature))}`
}

async function verifyToken(secret: string, token: string) {
  if (token.length > MAX_TOKEN_LENGTH) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = decode(signature)
  } catch {
    return null
  }
  // 先验签再解析正文，未签名的输入不进入 JSON 解析
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    bytes,
    encoder.encode(body),
  )
  if (!valid) return null
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(new TextDecoder().decode(decode(body))))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
