import { describe, expect, it } from 'vitest'
import { ConnectorError, httpRequest, parseJson, redactUrl } from '../src/index.ts'

const respond = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch

describe('redactUrl', () => {
  it('去掉用户信息与敏感查询参数', () => {
    expect(redactUrl('https://u:p@api.test/x?key=abc&q=shoes&access_token=t')).toBe(
      'https://api.test/x?key=%5BREDACTED%5D&q=shoes&access_token=%5BREDACTED%5D',
    )
  })

  it('查询参数中的 api_key 各种写法都脱敏（SerpApi 把密钥放在查询参数）', () => {
    const url = redactUrl(
      'https://serpapi.com/search.json?engine=amazon_product&asin=B0&api_key=sk-123&apiKey=aa1&api-key=bb2',
    )
    expect(url).not.toMatch(/sk-123|aa1|bb2/)
    expect(url).toContain('engine=amazon_product')
    expect(url).toContain('asin=B0')
  })
})

describe('httpRequest', () => {
  it('网络错误的 cause 不含原始密钥', async () => {
    const failing = (async (url: string) => {
      throw new TypeError(`fetch failed: ${url}`)
    }) as unknown as typeof fetch
    const error = await httpRequest(failing, {
      url: 'https://serpapi.com/search.json?engine=amazon_product&api_key=sk-secret',
    }).catch((e) => e)
    expect(error).toMatchObject({ kind: 'retryable', code: 'HTTP_NETWORK_ERROR' })
    expect(String((error.cause as Error).message)).not.toContain('sk-secret')
    expect(String((error.cause as Error).message)).toContain('REDACTED')
  })

  it('2xx 返回正文与脱敏后的请求摘要', async () => {
    const res = await httpRequest(respond(200, '{"ok":true}'), {
      url: 'https://api.test/a?api_key=s',
    })
    expect(parseJson(res.body)).toEqual({ ok: true })
    expect(res.request.url).not.toContain('s&')
    expect(res.request.url).toContain('REDACTED')
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'retryable'],
    [503, 'retryable'],
    [400, 'permanent'],
  ] as const)('HTTP %i 分类为 %s', async (status, kind) => {
    const error = await httpRequest(respond(status), { url: 'https://api.test' }).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect(error.kind).toBe(kind)
  })

  it('凭据失效与额度耗尽会停止数据源', () => {
    expect(new ConnectorError('auth', 'X').stopsSource).toBe(true)
    expect(new ConnectorError('quota', 'X').stopsSource).toBe(true)
    expect(new ConnectorError('retryable', 'X').stopsSource).toBe(false)
  })

  it('可自定义分类（例如把 429 判为额度耗尽）', async () => {
    const error = await httpRequest(
      respond(429, '{"error":"daily limit"}'),
      { url: 'https://api.test' },
      (s, b) =>
        s === 429 && b.includes('daily') ? new ConnectorError('quota', 'DAILY_LIMIT') : null,
    ).catch((e) => e)
    expect(error.kind).toBe('quota')
  })

  it('响应体超过上限视为无效响应', async () => {
    const error = await httpRequest(respond(200, 'x'.repeat(100)), {
      url: 'https://api.test',
      maxBytes: 10,
    }).catch((e) => e)
    expect(error.code).toBe('RESPONSE_TOO_LARGE')
  })

  it('超时按可重试处理', async () => {
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })) as unknown as typeof fetch
    const error = await httpRequest(hang, { url: 'https://api.test', timeoutMs: 10 }).catch(
      (e) => e,
    )
    expect(error).toMatchObject({ kind: 'retryable', code: 'HTTP_TIMEOUT' })
  })

  it('错误信息不含响应正文', async () => {
    const error = await httpRequest(respond(400, 'secret-body'), { url: 'https://api.test' }).catch(
      (e) => e,
    )
    expect(String(error.message)).not.toContain('secret-body')
  })
})
