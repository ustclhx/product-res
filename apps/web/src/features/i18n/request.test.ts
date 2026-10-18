import { describe, expect, it, vi } from 'vitest'
import { baseLocale, getLocale, isLocale } from '../../paraglide/runtime.js'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { languageUrl, preferredLocale } from './preference.ts'
import { localizeRequest } from './request.server.ts'
import { readRequestSession, withSessionCache } from './session.server.ts'

vi.mock('@product-res/auth', async (original) => ({
  ...(await original<typeof import('@product-res/auth')>()),
  requireFreshSession: vi.fn(async ({ headers }) => ({
    user: { id: headers.get('x-user'), locale: headers.get('x-locale') },
    session: {},
  })),
}))

const runtime = { db: {}, auth: {} } as Pick<WebRuntime, 'db' | 'auth'>

const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
const origin = 'https://product.ezarouter.cc'

describe('请求级语言与只读会话隔离', () => {
  it('并发账号请求各自保留会话与语言，同一请求只读取一次会话', async () => {
    const { requireFreshSession } = await import('@product-res/auth')
    vi.mocked(requireFreshSession).mockClear()
    const run = (locale: string) => {
      const request = new Request(`${origin}/account`, {
        headers: { 'x-user': locale, 'x-locale': locale },
      })
      const handle = async () => {
        await pause()
        const [a, b] = await Promise.all([
          readRequestSession({ headers: request.headers } as Parameters<
            typeof readRequestSession
          >[0]),
          readRequestSession({ headers: request.headers } as Parameters<
            typeof readRequestSession
          >[0]),
        ])
        return Response.json({ locale: getLocale(), a: a.user.id, b: b.user.id })
      }
      return localizeRequest(request, runtime, () =>
        templateConfig.i18n.enabled ? handle() : withSessionCache(handle),
      )
    }
    const responses = await Promise.all([run('zh'), run('en')])
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      {
        locale: templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
        a: 'zh',
        b: 'zh',
      },
      {
        locale: templateConfig.i18n.enabled && isLocale('en') ? 'en' : baseLocale,
        a: 'en',
        b: 'en',
      },
    ])
    expect(requireFreshSession).toHaveBeenCalledTimes(2)
  })

  it('公开 server function 用同源来源页的 URL 语言，Cookie 不覆盖营销页', async () => {
    const request = new Request(`${origin}/_serverFn/test`, {
      headers: { referer: `${origin}/zh/pricing`, cookie: 'PARAGLIDE_LOCALE=en' },
    })
    const response = await localizeRequest(request, runtime, async () => new Response(getLocale()))
    expect(await response.text()).toBe(
      templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
    )
    expect(
      languageUrl(new Request(request, { headers: { referer: 'https://other.test/zh/pricing' } }))
        .pathname,
    ).toBe('/_serverFn/test')
  })

  it('语言识别不消耗 server function 的 POST 请求体', async () => {
    const request = new Request(`${origin}/_serverFn/test`, {
      method: 'POST',
      body: 'zh',
      headers: { referer: `${origin}/pricing` },
    })
    const response = await localizeRequest(
      request,
      runtime,
      async () => new Response(await request.text()),
    )
    expect(await response.text()).toBe('zh')
  })

  it('独立请求缓存上下文结束后不再复用会话', async () => {
    const { requireFreshSession } = await import('@product-res/auth')
    vi.mocked(requireFreshSession).mockClear()
    const options = { headers: new Headers({ 'x-user': 'one' }) } as Parameters<
      typeof readRequestSession
    >[0]
    await withSessionCache(() =>
      Promise.all([readRequestSession(options), readRequestSession(options)]),
    )
    await readRequestSession(options)
    expect(requireFreshSession).toHaveBeenCalledTimes(2)
  })
})

it('账号语言只在多语言模式读取，单语言忽略 Cookie 和账号偏好', async () => {
  const { requireFreshSession } = await import('@product-res/auth')
  vi.mocked(requireFreshSession).mockClear()
  const request = new Request(`${origin}/account`, {
    headers: { 'x-user': 'one', 'x-locale': 'zh', cookie: 'PARAGLIDE_LOCALE=en' },
  })
  const response = await localizeRequest(request, runtime, async () => new Response(getLocale()))
  expect(await response.text()).toBe(
    templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
  )
  expect(requireFreshSession).toHaveBeenCalledTimes(templateConfig.i18n.enabled ? 1 : 0)
  if (!templateConfig.i18n.enabled) {
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  }
})

describe('首次访问建议', () => {
  it('按 Accept-Language 的 q 权重、地区语言和禁用项匹配，默认语言也尊重优先级', () => {
    expect(preferredLocale('fr,zh-CN;q=0.8,en;q=0.2')).toBe(isLocale('zh') ? 'zh' : baseLocale)
    expect(preferredLocale('zh;q=0,en;q=0.9')).toBe(isLocale('en') ? 'en' : baseLocale)
    expect(preferredLocale('en-US;q=0.9,zh;q=0.8')).toBe(isLocale('en') ? 'en' : baseLocale)
    expect(preferredLocale('zh;q=oops,fr')).toBe(baseLocale)
  })
})
