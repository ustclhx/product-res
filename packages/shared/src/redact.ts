/**
 * 统一脱敏过滤器（design 决策 3，specs/observability「敏感信息脱敏」）：按字段名移除密钥、密码、
 * 令牌、Cookie 与 AI 对话内容。结构化日志在输出前经过这里；接入 Sentry 后 `beforeSend` 复用同一函数。
 *
 * 字段名比较时忽略大小写与 `-` / `_`，因此 `Authorization`、`set-cookie`、`api_key` 都能匹配。
 */
export const REDACTED = '[REDACTED]'

/** 整个字段视为敏感的名称（归一化后精确匹配） */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'discordwebhookurl',
  'operations.discordwebhookurl',
  'telegrambottoken',
  'operations.telegrambottoken',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
  'xapikey',
  'otp',
  'cardnumber',
  'cvc',
  'cvv',
  // AI 对话内容：UI 消息的 parts、模型消息列表、提示词与消息正文
  'parts',
  'messages',
  'prompt',
  'system',
  'content',
])
/** 以这些词结尾的字段也视为敏感，如 accessToken、clientSecret、newPassword、stripeApiKey */
const SENSITIVE_SUFFIX = /(token|secret|password|apikey)$/

const MAX_DEPTH = 8

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIX.test(normalized)
}

/**
 * 返回脱敏后的副本（不修改入参）：敏感字段的值替换为 `[REDACTED]`；`Headers` / `Map` 转为普通对象后同样处理；
 * `Error` 只保留 name / message / stack 与 cause；`Request` 只保留方法、不含查询串的地址与脱敏后的头部。
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet())
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value
  }
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[Truncated]'
  seen.add(value)
  try {
    if (value instanceof Date) return value.toISOString()
    if (isRequestLike(value)) {
      return {
        method: value.method,
        url: value.url.split(/[?#]/)[0],
        headers: walk(value.headers, depth + 1, seen),
      }
    }
    // Headers / Map：按键值对处理（Headers 的键已是小写）
    if (isEntriesLike(value)) return walkEntries(value.entries(), depth, seen)
    if (value instanceof Error) {
      const error: Record<string, unknown> = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      }
      if (value.cause !== undefined) error.cause = value.cause
      return walkEntries(Object.entries(error), depth, seen)
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen))
    return walkEntries(Object.entries(value), depth, seen)
  } finally {
    seen.delete(value)
  }
}

// 按结构判断而不用 instanceof：本包不依赖 DOM / Workers 的全局类型，所有运行时都能用
function isRequestLike(value: object): value is { method: string; url: string; headers: object } {
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.method === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.headers === 'object' &&
    candidate.headers !== null
  )
}

function isEntriesLike(value: object): value is { entries(): Iterable<[string, unknown]> } {
  const candidate = value as Record<string, unknown>
  return typeof candidate.entries === 'function' && typeof candidate.get === 'function'
}

function walkEntries(
  entries: Iterable<[string, unknown]>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    result[key] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1, seen)
  }
  return result
}
