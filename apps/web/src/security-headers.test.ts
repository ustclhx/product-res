import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, withSecurityHeaders } from './security-headers.ts'

describe('统一安全响应头', () => {
  it('只补缺失的头，保留上游策略与 Cookie，且不修改输入', () => {
    const upstream = new Headers({
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'upstream',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'Content-Security-Policy': "default-src 'none'",
      'Content-Security-Policy-Report-Only': "default-src 'none'",
    })
    upstream.append('set-cookie', 'a=1; HttpOnly')
    upstream.append('set-cookie', 'b=2; HttpOnly')
    const result = withSecurityHeaders(upstream, { https: true })
    expect([...result]).toEqual([...upstream])
    expect(result.getSetCookie()).toEqual(upstream.getSetCookie())
    expect(withSecurityHeaders(new Headers(), { https: false }).get('X-Frame-Options')).toBe('DENY')
    expect(upstream.get('x-request-id')).toBeNull()
  })

  it.each([false, true])('基础头和 HSTS（https=%s）', (https) => {
    const result = withSecurityHeaders({}, { https })
    expect(result.get('X-Frame-Options')).toBe('DENY')
    expect(result.get('X-Content-Type-Options')).toBe('nosniff')
    expect(result.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(result.get('Strict-Transport-Security')).toBe(
      https ? 'max-age=31536000; includeSubDomains' : null,
    )
    expect(result.get('Content-Security-Policy')).toBeNull()
    expect(result.get('Content-Security-Policy-Report-Only')).toContain("frame-ancestors 'none'")
  })

  it('CSP 只授权本请求 nonce 与精确集成域名', () => {
    const csp = contentSecurityPolicy({
      https: true,
      nonce: 'request-nonce',
      r2AccountId: 'a'.repeat(32),
      sentryDsn: 'https://public@ingest.sentry.io/123',
    })
    expect(csp).toContain(
      "script-src 'self' 'nonce-request-nonce' https://challenges.cloudflare.com",
    )
    expect(csp).toContain('https://checkout.stripe.com')
    expect(csp).toContain('https://billing.stripe.com')
    expect(csp).toContain(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`)
    expect(csp).toContain('https://ingest.sentry.io')
    expect(csp).not.toContain('public@')
    expect(csp).not.toContain('*')
    expect(csp.split('; ').find((directive) => directive.startsWith('script-src'))).not.toContain(
      'unsafe-inline',
    )
  })
})

it('静态首页用内容哈希授权主题与水合脚本，保留原字节和缓存头', async () => {
  const { withStaticSecurityHeaders } = await import('./security-headers.ts')
  const html =
    '<html><script nonce="build-time">theme()</script><script>hydrate(\x00\r\n)</script><script src="/assets/app.js"></script></html>'
  const response = await withStaticSecurityHeaders(
    new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', etag: 'static-version' },
    }),
    { https: true },
  )
  const hash = async (script: string) =>
    `'sha256-${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))).toString('base64')}'`
  const csp = response.headers.get('Content-Security-Policy-Report-Only')
  expect(csp).toContain(await hash('theme()'))
  expect(csp).toContain(await hash('hydrate(\uFFFD\n)'))
  expect(csp).not.toContain('nonce-build-time')
  expect(response.headers.get('etag')).toBe('static-version')
  expect(await response.text()).toBe(html)
})

it('304 不替换缓存 HTML 原有的脚本授权策略', async () => {
  const { withStaticSecurityHeaders } = await import('./security-headers.ts')
  const response = await withStaticSecurityHeaders(
    new Response(null, { status: 304, headers: { etag: 'same-document' } }),
    { https: true },
  )
  expect(response.status).toBe(304)
  expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeNull()
  expect(response.headers.get('X-Frame-Options')).toBe('DENY')
})

describe('分析域名的 CSP', () => {
  it('未配置时不放行任何分析域名，配置后只放行本环境实例', () => {
    const none = contentSecurityPolicy({ https: true })
    expect(none).not.toMatch(/plausible|clarity/)
    const policy = contentSecurityPolicy({
      https: true,
      analyticsOrigin: 'https://plausible.example/x',
    })
    expect(policy).toMatch(/script-src [^;]*https:\/\/plausible\.example/)
    expect(policy).toMatch(/connect-src [^;]*https:\/\/plausible\.example/)
    expect(policy).not.toContain('clarity')
  })

  it('只有显式配置 Clarity 才放行其域名', () => {
    const policy = contentSecurityPolicy({ https: true, clarity: true })
    expect(policy).toMatch(/script-src [^;]*https:\/\/www\.clarity\.ms/)
    expect(policy).toMatch(/connect-src [^;]*https:\/\/\*\.clarity\.ms/)
  })
})
