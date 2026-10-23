import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ebayStorePageUrl,
  extractEbayStoreUsername,
  resolveEbayStoreUsername,
} from '../src/index.ts'

// 实测修正（2026-10-23）：/str/<店铺名> 解析为卖家用户名。不调用真实 eBay。

const page = readFileSync(new URL('./fixtures/ebay-store-page.html', import.meta.url), 'utf8')

function stubFetch(responses: Response[]) {
  const urls: string[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    expect(init?.redirect).toBe('manual')
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return next
  }) as typeof fetch
  return { impl, urls }
}

describe('店铺页用户名提取', () => {
  it('真实页面片段中取出唯一用户名', () => {
    expect(extractEbayStoreUsername(page)).toEqual({ ok: true, username: 'dexclusive-fashion' })
  })

  it('没有用户名字段、出现多个不同用户名时都不猜测', () => {
    expect(extractEbayStoreUsername('<html>captcha</html>')).toEqual({
      ok: false,
      reason: 'not-found',
    })
    expect(extractEbayStoreUsername('{"username":"a-1"} {"username":"b-2"}')).toEqual({
      ok: false,
      reason: 'ambiguous',
    })
    // 同一用户名重复出现不算歧义；不合规的取值忽略
    expect(
      extractEbayStoreUsername('{"username":"a-1"}{"username":"a-1"}{"username":"<x>"}'),
    ).toEqual({ ok: true, username: 'a-1' })
  })

  it('店铺页地址固定 www.ebay.com，拒绝含路径字符的店铺名', () => {
    expect(ebayStorePageUrl('watch genies')).toBe('https://www.ebay.com/str/watch%20genies')
    expect(ebayStorePageUrl('../usr/x')).toBeUndefined()
    expect(ebayStorePageUrl('a/b')).toBeUndefined()
  })
})

describe('店铺页抓取', () => {
  it('带浏览器 UA 请求店铺页，跳转只跟随同站 /str/', async () => {
    const { impl, urls } = stubFetch([
      new Response(null, { status: 301, headers: { location: '/str/WatchGenies' } }),
      new Response(page, { status: 200 }),
    ])
    await expect(resolveEbayStoreUsername('watchgenies', { fetch: impl })).resolves.toEqual({
      ok: true,
      username: 'dexclusive-fashion',
    })
    expect(urls).toEqual([
      'https://www.ebay.com/str/watchgenies',
      'https://www.ebay.com/str/WatchGenies',
    ])
  })

  it('验证码页、站外跳转与非 2xx 都返回失败', async () => {
    for (const location of [
      'https://www.ebay.com/splashui/captcha?ap=1',
      'https://evil.example/str/x',
      'http://www.ebay.com/str/x',
      'https://www.ebay.com.evil.example/str/x',
    ]) {
      const { impl } = stubFetch([new Response(null, { status: 307, headers: { location } })])
      await expect(resolveEbayStoreUsername('watchgenies', { fetch: impl })).resolves.toEqual({
        ok: false,
        reason: 'blocked',
      })
    }
    const { impl } = stubFetch([new Response('gone', { status: 404 })])
    await expect(resolveEbayStoreUsername('watchgenies', { fetch: impl })).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    })
  })

  it('响应过大视为不可达', async () => {
    const { impl } = stubFetch([
      new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }),
    ])
    await expect(resolveEbayStoreUsername('watchgenies', { fetch: impl })).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    })
  })
})
