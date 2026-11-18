/** 配置错误（退出码 2）：在任何模型调用前发现，不写报告（design D9） */
export class EvalConfigError extends Error {
  override readonly name = 'EvalConfigError'
}

export const EXIT = {
  ok: 0,
  failed: 1,
  config: 2,
  budget: 3,
  regression: 4,
  /** 套件 evaluateRun 的门槛未达成或必需门槛证据不足 */
  gates: 5,
} as const

/** 文本模型出口读取的环境变量；值只交给模型工厂，并从任何错误信息中抹去 */
export const TEXT_ENV_KEYS = [
  'AI_TEXT_EGRESS',
  'OPENAI_BASE_URL',
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'AI_GATEWAY_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
] as const

// AI_TEXT_EGRESS 只是 direct / gateway，不算敏感值，也避免把普通单词替换掉
const SECRET_KEYS = TEXT_ENV_KEYS.filter((key) => key !== 'AI_TEXT_EGRESS')
const secretValues = new Set<string>()

/** 登记本次运行环境中的凭据与端点值，之后的错误信息一律按字面抹去 */
export function registerSecretValues(env: Readonly<Record<string, string | undefined>>) {
  for (const key of SECRET_KEYS) {
    const value = env[key]?.trim()
    if (value && value.length >= 4) secretValues.add(value)
  }
}

const HEADER_NAMES =
  'authorization|proxy-authorization|x-api-key|x-goog-api-key|cf-aig-authorization|api[-_]?key'

/**
 * 错误信息只保留消息正文，抹去：URL、凭据请求头的整个值（含 `Bearer …`、JSON 形式
 * `"authorization":"…"`）、常见密钥形态，以及已登记的环境变量字面值。
 */
export function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  // 先抹字面值：URL 规则会改变包含它们的文本
  for (const value of [...secretValues].sort((a, b) => b.length - a.length))
    message = message.split(value).join('<redacted>')
  return message
    .replace(
      new RegExp(`(["']?(?:${HEADER_NAMES})["']?\\s*[:=]\\s*)"[^"]*"`, 'gi'),
      '$1"<redacted>"',
    )
    .replace(
      new RegExp(`(["']?(?:${HEADER_NAMES})["']?\\s*[:=]\\s*)'[^']*'`, 'gi'),
      "$1'<redacted>'",
    )
    .replace(
      new RegExp(`((?:${HEADER_NAMES})\\s*[:=]\\s*)(?:(?:Bearer|Basic)\\s+)?[^\\s"',;]+`, 'gi'),
      '$1<redacted>',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 <redacted>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '<redacted>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 500)
}
