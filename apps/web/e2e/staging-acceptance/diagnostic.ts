// Playwright 原始异常会带 URL、选择器、页面文本或请求体，不能整体输出；
// 这里只提取固定形态的类别（调用名、网络错误码、超时、页面关闭等），让失败仍可定位。
const API =
  /^(?:[A-Za-z]*Error: )?((?:page|frame|locator|browserType|browser|context|request|response)\.[a-zA-Z]+):/
const ERROR_NAME = /^([A-Za-z]*Error)\b/
const CATEGORIES = [
  /\bnet::ERR_[A-Z0-9_]+/,
  /\bTest timeout of \d+ms exceeded/,
  /\bTimeout \d+ms exceeded/,
  /\bTarget page, context or browser has been closed/,
  /\bTarget crashed/,
  /\bis interrupted by another navigation/,
  /\b[Ff]rame was detached/,
  /\bBrowser has been disconnected/i,
  /\bBrowser closed/,
  /\bProtocol error \([A-Za-z.]+\)/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
  /\bRead-only evidence query failed \((?:connect|timeout|ssl|auth|sql|unknown)\)/,
]

export function safeDiagnostic(message: string | undefined) {
  // 只看首行：后续的调用日志会回显导航 URL 与页面内容。
  const first = message?.split('\n', 1)[0] ?? ''
  const parts = [API.exec(first)?.[1] ?? ERROR_NAME.exec(first)?.[1]]
  for (const pattern of CATEGORIES) parts.push(pattern.exec(first)?.[0])
  const safe = parts.filter(Boolean)
  return safe.length > 0 ? safe.join(': ') : 'unclassified'
}

export type PgFailure = 'connect' | 'timeout' | 'ssl' | 'auth' | 'sql' | 'unknown'

// SQLSTATE 08 类为连接异常；57P01-57P03 为服务端关闭/重启；53300 为连接数已满，均可重连重放。
const RECONNECTABLE_SQLSTATE = /^(?:08|57P0[123]$|53300$)/
// postgres.js 自身的连接错误码与 Node 套接字错误码。
const CONNECT_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
])

export const TRANSIENT_PG_FAILURES: ReadonlySet<PgFailure> = new Set(['connect', 'timeout', 'ssl'])

// 驱动错误的 message 可能含主机名、SQL 片段或数据，只按错误码与固定短语归为类别，原文不外传。
export function classifyPgFailure(error: unknown): PgFailure {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  const sqlstate = typeof code === 'string' ? code : ''
  const text = typeof message === 'string' ? message : ''
  if (sqlstate === 'CONNECT_TIMEOUT' || sqlstate === 'ETIMEDOUT') return 'timeout'
  if (CONNECT_CODES.has(sqlstate)) return 'connect'
  if (/^(?:ERR_SSL|ERR_TLS)|^EPROTO$|CERT|^DEPTH_ZERO/.test(sqlstate)) return 'ssl'
  if (/^28/.test(sqlstate) || /^SASL_/.test(sqlstate)) return 'auth'
  if (RECONNECTABLE_SQLSTATE.test(sqlstate)) return 'connect'
  // Neon 代理在计算节点唤醒或不可达时以 XX000 等通用码返回，靠固定短语识别。
  if (/compute node|compute is starting|endpoint is starting|could not connect/i.test(text))
    return 'connect'
  if (/^[0-9A-Z]{5}$/.test(sqlstate)) return 'sql'
  return 'unknown'
}
