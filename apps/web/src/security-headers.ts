export interface SecurityHeaderOptions {
  readonly https: boolean
  readonly nonce?: string | undefined
  readonly scriptHashes?: readonly string[]
  readonly r2AccountId?: string | undefined
  readonly sentryDsn?: string | undefined
  readonly storageOrigin?: string | undefined
  /** 本环境 Plausible 实例的 origin；未配置时 CSP 不放行任何分析域名 */
  readonly analyticsOrigin?: string | undefined
  /** 配置了 Clarity 项目时放行其域名；默认关闭 */
  readonly clarity?: boolean | undefined
}

/** 只列出浏览器实际使用的集成；Sentry 目前仅在服务端运行，预留配置的精确 ingest origin。 */
export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  const turnstile = 'https://challenges.cloudflare.com'
  const r2 =
    options.r2AccountId && /^[a-f0-9]{32}$/.test(options.r2AccountId)
      ? `https://${options.r2AccountId}.r2.cloudflarestorage.com`
      : ''
  const sentry =
    options.sentryDsn && URL.canParse(options.sentryDsn) ? new URL(options.sentryDsn).origin : ''
  const storage =
    options.storageOrigin && URL.canParse(options.storageOrigin)
      ? new URL(options.storageOrigin).origin
      : ''
  const analytics =
    options.analyticsOrigin && URL.canParse(options.analyticsOrigin)
      ? new URL(options.analyticsOrigin).origin
      : ''
  const scripts = [
    "'self'",
    ...(options.nonce ? [`'nonce-${options.nonce}'`] : []),
    ...(options.scriptHashes ?? []),
    turnstile,
    ...(analytics ? [analytics] : []),
    ...(options.clarity ? ['https://www.clarity.ms', 'https://*.clarity.ms'] : []),
  ]
  const clarity = options.clarity ? 'https://*.clarity.ms' : ''
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    // 组件库和主题控件使用内联 style 属性；脚本仍只通过 nonce/hash 授权。
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${r2} ${storage} ${clarity}`.replace(/ +/g, ' ').trim(),
    `media-src 'self' blob: ${r2} ${storage}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' ${turnstile} ${r2} ${storage} ${sentry} ${analytics} ${clarity}`
      .replace(/ +/g, ' ')
      .trim(),
    `frame-src ${turnstile}`,
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** 上游头具有优先权；返回副本以支持重定向等只读 Headers。 */
export function withSecurityHeaders(headers: HeadersInit, options: SecurityHeaderOptions): Headers {
  const result = new Headers(headers)
  const defaults: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy-Report-Only': contentSecurityPolicy(options),
  }
  if (options.https) defaults['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  for (const [name, value] of Object.entries(defaults)) {
    if (!result.has(name)) result.set(name, value)
  }
  return result
}

/** 仅处理构建生成的静态 HTML；SSR 与 API 流直接透传，不缓冲。 */
export async function withStaticSecurityHeaders(
  response: Response,
  options: SecurityHeaderOptions,
): Promise<Response> {
  let body: BodyInit | ReadableStream<Uint8Array> | null = response.body
  let scriptHashes: string[] = []
  if (body && response.headers.get('content-type')?.includes('text/html')) {
    const bytes = await response.arrayBuffer()
    body = bytes
    const html = new TextDecoder().decode(bytes)
    scriptHashes = await Promise.all(
      [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
        .filter((match) => !/\bsrc\s*=/i.test(match[1] ?? ''))
        .map(async (match) => {
          const digest = await crypto.subtle.digest(
            'SHA-256',
            // HTML parser 会规范化换行，并把 NUL 替换为 U+FFFD；CSP 按解析后的脚本文本计算哈希。
            new TextEncoder().encode(
              (match[2] ?? '').replace(/\r\n?/g, '\n').replaceAll('\0', '\uFFFD'),
            ),
          )
          return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`
        }),
    )
  }
  const headers = withSecurityHeaders(response.headers, {
    ...options,
    nonce: undefined,
    scriptHashes,
  })
  // 304 复用缓存文档及其哈希策略；不能用没有脚本哈希的新策略替换缓存的响应头。
  if (response.status === 304 && !response.headers.has('Content-Security-Policy-Report-Only')) {
    headers.delete('Content-Security-Policy-Report-Only')
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
