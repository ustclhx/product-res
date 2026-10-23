import { ConnectorError, classifyStatus } from './errors.ts'

/**
 * URL 中常见的凭据参数；请求摘要与日志中替换为 [REDACTED]。
 * SerpApi、Keepa 等把密钥放在查询参数（api_key / key），存档与日志都只能看到脱敏后的 URL。
 */
const SECRET_PARAMS =
  /^(key|api[_-]?key|x[_-]api[_-]?key|access[_-]?token|token|secret|client[_-]?secret|password|sig|signature|auth)$/i

/** 去掉 URL 中的凭据：用户信息与敏感查询参数 */
export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '[invalid-url]'
  }
  url.username = ''
  url.password = ''
  for (const name of [...url.searchParams.keys()])
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, '[REDACTED]')
  return url.toString()
}

export interface HttpRequest {
  readonly method?: 'GET' | 'POST'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  /** 默认 20 秒 */
  readonly timeoutMs?: number
  /** 响应体上限，默认 8 MiB；超过视为无效响应 */
  readonly maxBytes?: number
  /**
   * 跳转策略，默认 follow。manual 时 3xx 原样返回给调用方，由调用方校验 Location，
   * 用于只允许固定站点的抓取（防 SSRF 跳到其他域名）。
   */
  readonly redirect?: 'follow' | 'manual'
}

export interface HttpResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: string
  /** 已去掉凭据的请求摘要 */
  readonly request: { readonly method: string; readonly url: string }
}

/**
 * 外部 HTTP 请求的统一入口：超时、响应体上限、状态分类、凭据脱敏。
 * 非 2xx 抛出 ConnectorError；调用方可传 classify 覆盖默认分类（例如把特定 429 判为额度耗尽）。
 */
export async function httpRequest(
  fetchImpl: typeof fetch,
  req: HttpRequest,
  classify?: (status: number, body: string) => ConnectorError | null,
): Promise<HttpResponse> {
  const method = req.method ?? 'GET'
  const summary = { method, url: redactUrl(req.url) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000)
  let response: Response
  try {
    response = await fetchImpl(req.url, {
      method,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body === undefined ? {} : { body: req.body }),
      ...(req.redirect ? { redirect: req.redirect } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const aborted = error instanceof Error && error.name === 'AbortError'
    throw new ConnectorError('retryable', aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK_ERROR', {
      cause: redactCause(error, req.url, summary.url),
    })
  }
  let body: string
  try {
    body = await readLimited(response, req.maxBytes ?? 8 * 1024 * 1024)
  } finally {
    clearTimeout(timer)
  }
  const custom = classify?.(response.status, body)
  if (custom) throw custom
  if (req.redirect === 'manual' && response.status >= 300 && response.status < 400)
    return { status: response.status, headers: response.headers, body, request: summary }
  const kind = classifyStatus(response.status)
  if (kind) throw new ConnectorError(kind, `HTTP_${response.status}`, { status: response.status })
  return { status: response.status, headers: response.headers, body, request: summary }
}

/** 网络错误的消息可能带完整 URL（含查询参数中的密钥）；日志记录 cause 前替换为脱敏 URL */
function redactCause(error: unknown, rawUrl: string, redacted: string) {
  if (!(error instanceof Error) || !error.message.includes(rawUrl)) return error
  const safe = new Error(error.message.split(rawUrl).join(redacted))
  safe.name = error.name
  return safe
}

async function readLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ConnectorError('invalid-response', 'RESPONSE_TOO_LARGE', { status: response.status })
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new ConnectorError('invalid-response', 'RESPONSE_TOO_LARGE', {
        status: response.status,
      })
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(concat(chunks, total))
}

function concat(chunks: Uint8Array[], total: number) {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** 解析 JSON 响应；失败时抛出 invalid-response，不把正文放进错误 */
export function parseJson<T = unknown>(body: string): T {
  try {
    return JSON.parse(body) as T
  } catch (error) {
    throw new ConnectorError('invalid-response', 'INVALID_JSON', { cause: error })
  }
}
