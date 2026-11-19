import type { Database } from '@product-res/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverServerAnalytics, type ServerAnalyticsTarget } from './analytics.ts'

const target: ServerAnalyticsTarget = {
  appUrl: 'https://own.example',
  site: {
    domain: 'own-staging',
    origin: 'https://plausible.example',
    scriptUrl: 'https://plausible.example/js/script.manual.js',
    eventUrl: 'https://plausible.example/api/event',
  },
}
const paid = {
  workspaceId: '0192f3a0-1111-7222-8333-444455556666',
  amount: 1999,
  currency: 'USD',
  status: 'succeeded',
  plan: 'pro',
}
const attribution = {
  source: 'chatgpt',
  landingPath: '/guides/x',
  device: 'mobile',
  locale: 'zh',
}

/** select 按调用顺序返回结果；insert 模拟主键占位，claimed=false 表示已被占用。 */
function fakeDb(results: unknown[][], claimed = true) {
  const inserts: unknown[] = []
  const deletes: unknown[] = []
  const query = () => {
    const rows = results.shift() ?? []
    const chain: Record<string, unknown> = {}
    for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit'])
      chain[method] = () => chain
    // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle 查询的 thenable。
    chain.then = (resolve: (value: unknown) => void) => resolve(rows)
    return chain
  }
  const db = {
    select: query,
    insert: () => ({
      values: (value: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            inserts.push(value)
            return claimed ? [value] : []
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (value: unknown) => {
        deletes.push(value)
      },
    }),
  } as unknown as Database
  return { db, inserts, deletes }
}

const event = {
  event: 'payment_success',
  provider: 'stripe',
  providerPaymentId: 'pi_1',
} as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deliverServerAnalytics', () => {
  it('付款事件带首触归因与收入发往本站 site，并写入去重标记', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const { db, inserts } = fakeDb([[paid], [{ userId: 'u1' }], [attribution]])
    await deliverServerAnalytics(db, target, event)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://plausible.example/api/event')
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'payment_success',
      domain: 'own-staging',
      url: 'https://own.example/app/billing',
      props: {
        source: 'chatgpt',
        landing_path: '/guides/x',
        locale: 'zh',
        plan: 'pro',
        device: 'mobile',
      },
      revenue: { currency: 'USD', amount: '19.99' },
    })
    expect(inserts).toEqual([{ eventKey: 'payment_success:stripe:pi_1' }])
  })

  it('已发送过、未配置或付款已非成功状态时不发送', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await deliverServerAnalytics(
      fakeDb([[paid], [{ userId: 'u1' }], [attribution]], false).db,
      target,
      event,
    )
    await deliverServerAnalytics(fakeDb([]).db, null, event)
    await deliverServerAnalytics(fakeDb([[{ ...paid, status: 'refunded' }]]).db, target, event)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sign_up 用真实访客的 IP 与 UA，便于与页面浏览串联', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await deliverServerAnalytics(fakeDb([[attribution]]).db, target, {
      event: 'sign_up',
      userId: 'u1',
      clientIp: '203.0.113.9',
      userAgent: 'Mozilla/5.0 Test',
    })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 Test',
    })
  })

  it('发送失败时抛出可重试错误并释放占位，错误不含响应细节', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret detail', { status: 500 })),
    )
    const { db, deletes } = fakeDb([[paid], [{ userId: 'u1' }], [attribution]])
    await expect(deliverServerAnalytics(db, target, event)).rejects.toMatchObject({
      code: 'ANALYTICS_DELIVERY_FAILED',
      status: 503,
    })
    expect(deletes).toHaveLength(1)
  })
})

describe('deliverServerAnalytics 多站', () => {
  const multi: ServerAnalyticsTarget = {
    appUrl: 'https://ganjiday.com',
    site: {
      ...target.site,
      domain: '',
      sites: { 'ganjiday.com': 'ganjiday.com', 'arcanumber.com': 'arcanumber.com' },
    },
  }
  const body = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))

  it('sign_up 按消息中的注册域名选择 site，事件 URL 使用该域名', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await deliverServerAnalytics(fakeDb([[attribution]]).db, multi, {
      event: 'sign_up',
      userId: 'u1',
      host: 'www.arcanumber.com',
    })
    expect(body(fetchMock)).toMatchObject({
      domain: 'arcanumber.com',
      url: 'https://arcanumber.com/register',
    })
  })

  it('付款按所有者归因行的 signup_host 选择 site', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const row = { ...attribution, signupHost: 'ganjiday.com' }
    await deliverServerAnalytics(fakeDb([[paid], [{ userId: 'u1' }], [row]]).db, multi, event)
    expect(body(fetchMock)).toMatchObject({
      domain: 'ganjiday.com',
      url: 'https://ganjiday.com/app/billing',
    })
  })

  it('未登记域名退回兜底 site 与 APP_URL', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const withFallback = { ...multi, site: { ...multi.site, domain: 'fallback-site' } }
    await deliverServerAnalytics(fakeDb([[attribution]]).db, withFallback, {
      event: 'sign_up',
      userId: 'u1',
      host: 'evil.example',
    })
    expect(body(fetchMock)).toMatchObject({
      domain: 'fallback-site',
      url: 'https://ganjiday.com/register',
    })
  })

  it('注册域名缺失且无兜底时不发送，也不占位', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const row = { ...attribution, signupHost: null }
    const { db, inserts } = fakeDb([[paid], [{ userId: 'u1' }], [row]])
    await deliverServerAnalytics(db, multi, event)
    const signUp = fakeDb([[attribution]])
    await deliverServerAnalytics(signUp.db, multi, { event: 'sign_up', userId: 'u1' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect([...inserts, ...signUp.inserts]).toEqual([])
  })
})
