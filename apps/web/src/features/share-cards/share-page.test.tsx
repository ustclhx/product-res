import { shareCardRevokedKey } from '@product-res/storage'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type WebRuntime, withWebRuntime } from '../../server/runtime.ts'
import { lookupShare, type ShareLookupDeps } from './lookup.ts'
import { shareCardMeta } from './meta.server.ts'
import { shareCardImagePath } from './meta.ts'
import { handleSharePageRequest, loadSharePage } from './page.server.ts'
import { registerShareCard } from './registry.ts'
import { SharePage, SharePageGone } from './share-page.tsx'
import type { ShareCardDefinition, ShareResolution } from './types.ts'

const current = vi.hoisted(() => ({ request: new Request('https://app.example/s/x/y') }))
// 页头页脚的链接只需输出 href，组件测试不搭建完整路由。
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: () => false,
}))
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => current.request }))
// 页脚的手机端设置行含语言选择（依赖路由位置），与本测试无关
vi.mock('../i18n/language-controls.tsx', () => ({ LanguageControls: () => null }))

interface Data {
  title: string
  description: string
}

const token = 'AbCdEfGhIjKlMnOpQrStUv_-0123456789'
const now = new Date('2026-11-13T00:00:00Z')
const shares = new Map<string, ShareResolution<Data>>()
const resolve = vi.fn(async (value: string) => shares.get(value) ?? null)
const definition = (type: string, extra: Partial<ShareCardDefinition<Data>> = {}) =>
  registerShareCard<Data>({
    type,
    version: 3,
    resolve,
    digest: (data) => `digest-${data.title.length}-abcdef`,
    render: () => <div />,
    alt: (data) => `Card: ${data.title}`,
    page: (data) => ({ title: data.title, description: data.description, label: 'Report' }),
    ...extra,
  })

const card = definition('page-test')
definition('page-off-test', { sharePage: false })
definition('page-month-test', { ttlDays: 30 })
definition('page-long-test', { tokenPattern: /^a+$/ })

function deps(overrides: Partial<ShareLookupDeps> = {}) {
  const revoked = new Set<string>()
  const limit = vi.fn(async () => ({ success: true }))
  return {
    revoked,
    limit,
    deps: {
      db: {} as ShareLookupDeps['db'],
      cache: { get: async (key: string) => (revoked.has(key) ? '1' : null) },
      rateLimiter: { limit },
      clientIp: '203.0.113.9',
      now,
      ...overrides,
    } satisfies ShareLookupDeps,
  }
}

beforeEach(() => {
  shares.clear()
  resolve.mockClear()
  current.request = new Request('https://app.example/s/x/y')
  shares.set(token, {
    workspaceId: 'workspace-1',
    sharedAt: new Date('2026-11-01T08:00:00Z'),
    data: { title: 'Quarterly survey notes', description: 'Retention rose by 12%.' },
  })
})

describe('share lookup', () => {
  it('returns 404 for unregistered types and disabled share pages without resolving', async () => {
    const { deps: d, limit } = deps()
    expect(await lookupShare(d, { type: 'missing-type', token, page: true })).toEqual({
      status: 'not-found',
    })
    expect(await lookupShare(d, { type: 'page-off-test', token, page: true })).toEqual({
      status: 'not-found',
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
    // 关闭通用分享页只影响 /s/，项目自建页面的元数据仍可解析。
    expect((await lookupShare(d, { type: 'page-off-test', token, page: false })).status).toBe('ok')
  })

  it('rejects bad and over-long tokens before reading KV', async () => {
    const get = vi.fn(async () => null)
    const { deps: base, limit } = deps()
    const d = { ...base, cache: { get } }
    for (const bad of ['short', `${token}!`, 'a'.repeat(65), 'a'.repeat(4096)])
      expect((await lookupShare(d, { type: 'page-test', token: bad, page: true })).status).toBe(
        'not-found',
      )
    // 自定义格式放行超长令牌时，长度上限仍在读 KV 之前拦截（KV 键最长 512 字节）。
    expect(
      (await lookupShare(d, { type: 'page-long-test', token: 'a'.repeat(600), page: true })).status,
    ).toBe('not-found')
    expect(get).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('checks the revocation mark and token format before resolve or rate limiting', async () => {
    const { deps: d, revoked, limit } = deps()
    revoked.add(shareCardRevokedKey('page-test', token))
    expect((await lookupShare(d, { type: 'page-test', token, page: true })).status).toBe(
      'not-found',
    )
    for (const bad of ['short', `${token}!`, '..', 'a'.repeat(65)])
      expect((await lookupShare(d, { type: 'page-test', token: bad, page: true })).status).toBe(
        'not-found',
      )
    expect(resolve).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
  })

  it('returns 404 when resolve is empty and expired after the effective expiry', async () => {
    const { deps: d } = deps()
    const unknown = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'
    expect((await lookupShare(d, { type: 'page-test', token: unknown, page: true })).status).toBe(
      'not-found',
    )
    shares.set(unknown, { ...(shares.get(token) as ShareResolution<Data>), expiresAt: now })
    expect((await lookupShare(d, { type: 'page-test', token: unknown, page: true })).status).toBe(
      'expired',
    )
    // 按类型 30 天：11-01 分享，12-01 起到期；默认 90 天的类型仍有效。
    const later = deps({ now: new Date('2026-12-02T00:00:00Z') }).deps
    expect((await lookupShare(later, { type: 'page-month-test', token, page: true })).status).toBe(
      'expired',
    )
    expect((await lookupShare(later, { type: 'page-test', token, page: true })).status).toBe('ok')
  })

  it('consumes the shareCard policy per client IP and stops before resolve when limited', async () => {
    const { deps: d, limit } = deps()
    limit.mockResolvedValueOnce({ success: false })
    expect((await lookupShare(d, { type: 'page-test', token, page: true })).status).toBe(
      'rate-limited',
    )
    expect(limit).toHaveBeenCalledWith('shareCard', 'share:ip:203.0.113.9')
    expect(resolve).not.toHaveBeenCalled()
  })
})

function runtime(d: ShareLookupDeps) {
  return {
    config: { APP_URL: 'https://app.example' },
    db: d.db,
    cache: d.cache,
    rateLimiter: d.rateLimiter,
    requestMeta: { requestId: 'request', clientIp: d.clientIp },
  } as unknown as WebRuntime
}

describe('share page loader and metadata', () => {
  /** 模拟文档请求：渲染前的处理函数，再在同一请求内由页面 loader 取数据。 */
  async function documentRequest(d: ShareLookupDeps, type: string, value: string) {
    let view: Awaited<ReturnType<typeof loadSharePage>> | undefined
    const next = vi.fn(async () => {
      view = await loadSharePage({ type, token: value })
      return { response: new Response('page', { status: view.status === 'ok' ? 200 : 404 }) }
    })
    const result = await withWebRuntime(runtime(d), () =>
      handleSharePageRequest({ request: current.request, params: { type, token: value }, next }),
    )
    const response = result instanceof Response ? result : result.response
    return { response, view, next }
  }

  it('renders valid shares with card metadata, noindex and a five-minute edge cache', async () => {
    const d = deps()
    const { response, view } = await documentRequest(d.deps, 'page-test', token)
    expect(response?.headers.get('cache-control')).toBe('public, s-maxage=300')
    expect(response?.headers.get('x-robots-tag')).toBe('noindex')
    // 文档请求只查找一次：限流配额与 resolve 都不因页面 loader 重复消耗。
    expect(d.limit).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    if (view?.status !== 'ok') throw new Error(`Unexpected ${view?.status}`)
    const image = `https://app.example/share-card/page-test/${token}.png?v=3-digest-2`
    expect(view).toMatchObject({
      title: 'Quarterly survey notes',
      label: 'Report',
      sharedOn: '2026-11-01',
      expiresOn: '2027-01-30',
      card: { image, width: 1200, height: 630, alt: 'Card: Quarterly survey notes' },
    })
    expect(view.meta).toEqual(
      expect.arrayContaining([
        { name: 'robots', content: 'noindex' },
        { property: 'og:image', content: image },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: 'Card: Quarterly survey notes' },
        { property: 'og:url', content: `https://app.example/s/page-test/${token}` },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: image },
      ]),
    )
    // 页面数据不下发空间 ID 等解析结果。
    expect(JSON.stringify(view)).not.toContain('workspace-1')
  })

  it('caps the edge cache at the remaining lifetime and treats under one second as expired', async () => {
    const d = deps({ now: new Date() })
    const soon = 'soonsoonsoonsoonsoonsoon'
    shares.set(soon, {
      workspaceId: 'workspace-1',
      sharedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() + 120_500),
      data: { title: 'Soon', description: 'Soon' },
    })
    const { response, view } = await documentRequest(d.deps, 'page-test', soon)
    expect(view?.status).toBe('ok')
    const maxAge = Number(/s-maxage=(\d+)/.exec(response?.headers.get('cache-control') ?? '')?.[1])
    expect(maxAge).toBeGreaterThan(100)
    expect(maxAge).toBeLessThanOrEqual(120)
    shares.set(soon, {
      ...(shares.get(soon) as ShareResolution<Data>),
      expiresAt: new Date(Date.now() + 500),
    })
    current.request = new Request('https://app.example/s/page-test/soon-again')
    const nearly = await documentRequest(deps({ now: new Date() }).deps, 'page-test', soon)
    expect(nearly.view).toEqual({ status: 'expired' })
    expect(nearly.response?.headers.get('x-robots-tag')).toBe('noindex')
    expect(nearly.response?.status).toBe(404)
  })

  it('maps the four 404 cases and keeps noindex; rate limits answer 429 before rendering', async () => {
    const d = deps()
    d.revoked.add(shareCardRevokedKey('page-test', 'revokedrevokedrevokedrev'))
    shares.set('expiredexpiredexpiredexp', {
      workspaceId: 'workspace-1',
      sharedAt: new Date('2026-01-01T00:00:00Z'),
      data: { title: 'Old', description: 'Old' },
    })
    const cases = [
      ['missing-type', token, 'not-found'],
      ['page-off-test', token, 'not-found'],
      ['page-test', 'bad', 'not-found'],
      ['page-test', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'not-found'],
      ['page-test', 'revokedrevokedrevokedrev', 'not-found'],
      ['page-test', 'expiredexpiredexpiredexp', 'expired'],
    ] as const
    for (const [type, value, status] of cases) {
      current.request = new Request(`https://app.example/s/${type}/${value}`)
      const { response, view } = await documentRequest(d.deps, type, value)
      expect(view).toEqual({ status })
      expect(response?.status).toBe(404)
      expect(response?.headers.get('x-robots-tag')).toBe('noindex')
    }
    d.limit.mockResolvedValueOnce({ success: false })
    current.request = new Request('https://app.example/s/page-test/limited')
    const limited = await documentRequest(d.deps, 'page-test', token)
    expect(limited.next).not.toHaveBeenCalled()
    expect(limited.response?.status).toBe(429)
    expect(limited.response?.headers.get('retry-after')).toBe('60')
    expect(limited.response?.headers.get('cache-control')).toBe('no-store')
    // 客户端路由跳转经 server function 请求，没有渲染前结果，自行查找并同样受限流约束。
    d.limit.mockResolvedValueOnce({ success: false })
    current.request = new Request('https://app.example/_serverFn/share')
    expect(
      await withWebRuntime(runtime(d.deps), () => loadSharePage({ type: 'page-test', token })),
    ).toEqual({ status: 'rate-limited' })
  })

  it('shareCardMeta serves self-built pages and returns null for invalid shares', async () => {
    const d = deps().deps
    const meta = await withWebRuntime(runtime(d), () =>
      shareCardMeta('page-off-test', token, { pageUrl: 'https://app.example/own' }),
    )
    expect(meta?.image).toBe(
      `https://app.example/share-card/page-off-test/${token}.png?v=3-digest-2`,
    )
    expect(meta?.meta).toContainEqual({ property: 'og:url', content: 'https://app.example/own' })
    expect(await withWebRuntime(runtime(d), () => shareCardMeta('page-test', 'bad'))).toBeNull()
    // 展示数据变化时地址随摘要变化。
    const data = { title: 'Renamed survey notes', description: '' }
    expect(shareCardImagePath(card, token, data)).toContain('?v=3-digest-2')
    expect(shareCardImagePath(card, token, data)).not.toBe(
      shareCardImagePath(card, token, { title: 'Short', description: '' }),
    )
  })
})

describe('share page view', () => {
  it('shows the card, title, description and site entry; gone states show no resource data', () => {
    const html = renderToStaticMarkup(
      <SharePage
        view={{
          status: 'ok',
          title: 'Quarterly survey notes',
          description: 'Retention rose by 12%.',
          label: 'Report',
          sharedOn: '2026-11-01',
          expiresOn: null,
          card: { image: 'https://app.example/card.png', width: 1200, height: 630, alt: 'Card' },
          meta: [],
        }}
      />,
    )
    for (const text of ['Quarterly survey notes', 'Retention rose by 12%.', 'Report'])
      expect(html).toContain(text)
    expect(html).toContain('src="https://app.example/card.png"')
    expect(html).toContain('href="/register"')
    for (const reason of ['not-found', 'expired', 'rate-limited'] as const) {
      const gone = renderToStaticMarkup(<SharePageGone reason={reason} />)
      expect(gone).toContain(`data-share-page="${reason}"`)
      expect(gone).not.toContain('Quarterly')
    }
  })
})
