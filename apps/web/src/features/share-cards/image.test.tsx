import { AppError } from '@product-res/shared'
import {
  type ShareCardObjects,
  shareCardImageKey,
  shareCardRevokedKey,
  shareCardTombstoneKey,
  shareCardWorkspaceKey,
} from '@product-res/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareCardEdgeCache, WebRuntime } from '../../server/runtime.ts'
import { withWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { handleShareCardImageRequest } from './image.server.ts'
import { invalidateShareCard } from './invalidate.server.ts'
import { registerShareCard } from './registry.ts'
import { SHARE_CARD_BUSY } from './renderer.ts'
import type { ShareResolution } from './types.ts'

interface Data {
  title: string
}

const TYPE = 'image-test'
const token = 'AbCdEfGhIjKlMnOpQrStUv_-0123456789'
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const shares = new Map<string, ShareResolution<Data>>()
const resolve = vi.fn(async (value: string) => shares.get(value) ?? null)
registerShareCard<Data>({
  type: TYPE,
  version: 2,
  resolve,
  digest: (data) => `${data.title.toLowerCase()}00000000`,
  render: (data) => <div>{data.title}</div>,
  alt: (data) => data.title,
  page: (data) => ({ title: data.title, description: '' }),
})
const variantOf = (title: string) => `2-${title.toLowerCase()}00000000`.slice(0, 10)

/** 进程内的对象存储、KV、Cache API 与渲染器；渲染器可注入钩子模拟渲染期间的并发失效。 */
function setup() {
  const objects = new Map<string, { body: Uint8Array; metadata: Record<string, string> }>()
  const kv = new Map<string, string>()
  const edge = new Map<string, Response>()
  const limit = vi.fn(async () => ({ success: true }))
  const render = vi.fn(async (): Promise<Uint8Array> => PNG)
  const store: ShareCardObjects = {
    async list({ prefix }) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(prefix)) }
    },
    get: async (key) => objects.get(key) ?? null,
    async put(key, body, options = {}) {
      objects.set(key, { body, metadata: options.metadata ?? {} })
    },
    async delete(key) {
      objects.delete(key)
    },
  }
  const cache: ShareCardEdgeCache = {
    match: async (url) => edge.get(url)?.clone(),
    async put(url, response) {
      edge.set(url, response)
    },
  }
  const runtime = {
    config: { APP_URL: 'https://app.example' },
    db: {},
    cache: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value)
      },
      delete: async (key: string) => {
        kv.delete(key)
      },
    },
    rateLimiter: { limit },
    requestMeta: { requestId: 'request', clientIp: '203.0.113.9' },
    files: { available: true, value: { shareCards: store } },
    shareCardRenderer: { available: true, value: async () => ({ render }) },
    shareCardCache: { available: true, value: cache },
  } as unknown as WebRuntime
  const request = (path: string) =>
    withWebRuntime(runtime, () => {
      const url = new URL(path, 'https://app.example')
      const [, , type, file] = url.pathname.split('/')
      return handleShareCardImageRequest(new Request(url), { type, file })
    })
  // 撤销墓碑永不删除，不计入「留下的卡片」。
  const live = () => [...objects.keys()].filter((key) => !key.startsWith('share-cards/revoked/'))
  const tombstone = (value = token) =>
    objects.set(shareCardTombstoneKey(TYPE, value), { body: new Uint8Array(), metadata: {} })
  return { objects, live, tombstone, kv, edge, limit, render, store, runtime, request }
}

const cardPath = (title: string, value = token) =>
  `/share-card/${TYPE}/${value}.png?v=${variantOf(title)}`

beforeEach(() => {
  shares.clear()
  resolve.mockClear()
  shares.set(token, {
    workspaceId: 'workspace-1',
    sharedAt: new Date(),
    expiresAt: null,
    data: { title: 'Survey' },
  })
})

describe('share card image route', () => {
  it('renders on a miss, stores image, index and edge cache, then hits without resolve', async () => {
    const t = setup()
    const first = await t.request(cardPath('Survey'))
    expect(first.status).toBe(200)
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400')
    expect(first.headers.get('x-robots-tag')).toBe('noindex')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(t.limit).toHaveBeenCalledWith('shareCard', 'share:ip:203.0.113.9')
    const imageKey = shareCardImageKey(TYPE, token, variantOf('Survey'))
    expect(t.objects.get(imageKey)?.metadata).toEqual({
      'expires-at': 'never',
      'workspace-id': 'workspace-1',
    })
    expect(
      t.objects.has(shareCardWorkspaceKey({ type: TYPE, token, workspaceId: 'workspace-1' })),
    ).toBe(true)
    expect(t.edge.size).toBe(1)

    // Cache API 命中：不调用 resolve、不消耗限流、不渲染。
    const cached = await t.request(`${cardPath('Survey')}&utm=x`)
    expect(cached.status).toBe(200)
    // 对象存储命中（另一个数据中心没有 Cache API 条目）：同样不调用 resolve。
    t.edge.clear()
    const stored = await t.request(cardPath('Survey'))
    expect(stored.status).toBe(200)
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(PNG)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(t.limit).toHaveBeenCalledTimes(1)
    expect(t.render).toHaveBeenCalledTimes(1)
    expect(t.edge.size).toBe(1)
  })

  it('answers 404 without resolve for bad formats, unknown types and non-png paths', async () => {
    const t = setup()
    for (const path of [
      `/share-card/${TYPE}/short.png?v=x`,
      `/share-card/${TYPE}/${token}!.png?v=x`,
      `/share-card/${TYPE}/${'a'.repeat(300)}.png?v=x`,
      `/share-card/missing-type/${token}.png?v=x`,
      `/share-card/${TYPE}/${token}.jpg?v=x`,
    ]) {
      const response = await t.request(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-robots-tag')).toBe('noindex')
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(t.limit).not.toHaveBeenCalled()
  })

  it('answers 404 when resolve is empty or expired, and 429 when rate limited', async () => {
    const t = setup()
    const unknown = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'
    const empty = await t.request(cardPath('Survey', unknown))
    expect(empty.status).toBe(404)
    expect(await empty.text()).not.toContain('Survey')
    shares.set(unknown, {
      workspaceId: 'workspace-1',
      sharedAt: new Date(Date.now() - 91 * 86_400_000),
      data: { title: 'Survey' },
    })
    expect((await t.request(cardPath('Survey', unknown))).status).toBe(404)
    t.limit.mockResolvedValueOnce({ success: false })
    const limited = await t.request(cardPath('Survey'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(limited.headers.get('cache-control')).toBe('no-store')
    expect(t.objects.size).toBe(0)
  })

  it('returns 404 after invalidation even with a cached and stored image', async () => {
    const t = setup()
    expect((await t.request(cardPath('Survey'))).status).toBe(200)
    await withWebRuntime(t.runtime, () =>
      invalidateShareCard({ type: TYPE, token, workspaceId: 'workspace-1' }),
    )
    expect(t.live()).toEqual([])
    expect(t.objects.has(shareCardTombstoneKey(TYPE, token))).toBe(true)
    expect(t.kv.get(shareCardRevokedKey(TYPE, token))).toBe('1')
    // 边缘缓存条目仍在，但撤销标记先于 Cache API 检查。
    expect(t.edge.size).toBe(1)
    expect((await t.request(cardPath('Survey'))).status).toBe(404)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('deletes a stored image whose metadata expiry has passed and answers 404', async () => {
    const t = setup()
    const key = shareCardImageKey(TYPE, token, variantOf('Survey'))
    t.objects.set(key, {
      body: PNG,
      metadata: { 'expires-at': new Date(Date.now() - 1000).toISOString(), 'workspace-id': 'w' },
    })
    expect((await t.request(cardPath('Survey'))).status).toBe(404)
    expect(t.objects.has(key)).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('redirects to the current address when the digest changed', async () => {
    const t = setup()
    shares.set(token, {
      ...(shares.get(token) as ShareResolution<Data>),
      data: { title: 'Renamed' },
    })
    const response = await t.request(cardPath('Survey'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(cardPath('Renamed'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    // 缺少 v 时同样跳转到当前地址。
    const bare = await t.request(`/share-card/${TYPE}/${token}.png`)
    expect(bare.headers.get('location')).toBe(cardPath('Renamed'))
    expect(t.render).not.toHaveBeenCalled()
    expect(t.objects.size).toBe(0)
  })

  it('ignores the locale parameter when the project has no site overrides', async () => {
    const t = setup()
    // 没有站点覆盖时 l 不进入 v：任何语言（含未知值）都是同一地址、同一缓存条目。
    for (const locale of [templateConfig.i18n.defaultLocale, 'xx', '../en']) {
      const response = await t.request(`${cardPath('Survey')}&l=${encodeURIComponent(locale)}`)
      expect(response.status).toBe(200)
    }
    expect(t.render).toHaveBeenCalledTimes(1)
    expect(t.edge.size).toBe(1)
  })

  it('bounds browser and edge cache to the remaining lifetime', async () => {
    const t = setup()
    shares.set(token, {
      ...(shares.get(token) as ShareResolution<Data>),
      expiresAt: new Date(Date.now() + 2 * 3600_000),
    })
    const response = await t.request(cardPath('Survey'))
    const header = response.headers.get('cache-control') ?? ''
    const maxAge = Number(/(?:^|\s)max-age=(\d+)/.exec(header)?.[1])
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(header)?.[1])
    expect(sMaxAge).toBeGreaterThan(7100)
    expect(sMaxAge).toBeLessThanOrEqual(7200)
    expect(maxAge).toBeLessThanOrEqual(7200)
    expect(header).not.toContain('immutable')
    // 对象存储命中时按元数据中的到期时间计算剩余有效期。
    t.edge.clear()
    const stored = await t.request(cardPath('Survey'))
    expect(
      Number(/s-maxage=(\d+)/.exec(stored.headers.get('cache-control') ?? '')?.[1]),
    ).toBeLessThanOrEqual(7200)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not leave an image or index when the share is invalidated during rendering', async () => {
    const t = setup()
    t.render.mockImplementationOnce(async () => {
      await withWebRuntime(t.runtime, () =>
        invalidateShareCard({ type: TYPE, token, workspaceId: 'workspace-1' }),
      )
      return PNG
    })
    expect((await t.request(cardPath('Survey'))).status).toBe(404)
    expect(t.live()).toEqual([])
    expect(t.edge.size).toBe(0)
  })

  it('sees a tombstone-only invalidation during rendering even when KV still reads stale', async () => {
    const t = setup()
    // KV 读取有缓存：并发失效只让强一致的 R2 墓碑可见，KV 标记仍读不到。
    t.render.mockImplementationOnce(async () => {
      t.tombstone()
      return PNG
    })
    expect((await t.request(cardPath('Survey'))).status).toBe(404)
    expect(t.live()).toEqual([])
    expect(t.edge.size).toBe(0)
  })

  it('withdraws its own write when invalidation lands between the write and the response', async () => {
    const t = setup()
    const runtime = t.runtime as unknown as {
      files: { value: { shareCards: ShareCardObjects } }
    }
    const store = runtime.files.value.shareCards
    const put = store.put
    let revoked = false
    store.put = async (key, body, options) => {
      await put(key, body, options)
      // 失效在列出前缀之后才看到本次写入的图片：只有墓碑可见（KV 仍读到旧值），图片仍在。
      if (!revoked && key.includes('/img/')) {
        revoked = true
        t.tombstone()
      }
    }
    expect((await t.request(cardPath('Survey'))).status).toBe(404)
    expect(t.live()).toEqual([])
    expect(t.edge.size).toBe(0)
  })

  it('maps renderer saturation to 503 with Retry-After and hides other render errors', async () => {
    const t = setup()
    t.render.mockRejectedValueOnce(new AppError(SHARE_CARD_BUSY, 'busy', { status: 503 }))
    const busy = await t.request(cardPath('Survey'))
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('5')
    expect(busy.headers.get('cache-control')).toBe('no-store')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      t.render.mockRejectedValueOnce(new Error('secret detail'))
      const failed = await t.request(cardPath('Survey'))
      expect(failed.status).toBe(500)
      expect(await failed.text()).not.toContain('secret')
    } finally {
      error.mockRestore()
    }
    expect(t.objects.size).toBe(0)
  })

  it('serves self-hosted requests without Cache API from object storage', async () => {
    const t = setup()
    const runtime = { ...t.runtime, shareCardCache: { available: false } } as WebRuntime
    const request = (path: string) =>
      withWebRuntime(runtime, () => {
        const url = new URL(path, 'https://app.example')
        const [, , type, file] = url.pathname.split('/')
        return handleShareCardImageRequest(new Request(url), { type, file })
      })
    expect((await request(cardPath('Survey'))).status).toBe(200)
    expect((await request(cardPath('Survey'))).status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(t.edge.size).toBe(0)
  })

  it('caps edge entries at one day so they lapse with the KV revocation flag', async () => {
    const t = setup()
    expect((await t.request(cardPath('Survey'))).status).toBe(200)
    const entry = [...t.edge.values()][0]
    const header = entry?.headers.get('cache-control') ?? ''
    expect(Number(/s-maxage=(\d+)/.exec(header)?.[1])).toBeLessThanOrEqual(86_400)
    expect(header).not.toContain('immutable')
    expect(entry?.headers.get('x-share-card-expires')).toBe('never')
    // 撤销后 KV 标记过期：即便边缘条目被手动保留，其 s-maxage 也不超过标记的 1 天 TTL。
    await withWebRuntime(t.runtime, () =>
      invalidateShareCard({ type: TYPE, token, workspaceId: 'workspace-1' }),
    )
    t.kv.delete(shareCardRevokedKey(TYPE, token))
    expect(Number(/s-maxage=(\d+)/.exec(header)?.[1])).toBeLessThanOrEqual(86_400)
  })

  it('recomputes cache headers on an edge hit from the stored expiry', async () => {
    const t = setup()
    const url = `https://app.example${cardPath('Survey').replace(/\?.*/, '')}?v=${variantOf('Survey')}`
    t.edge.set(
      url,
      new Response(PNG, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400, s-maxage=86400',
          'x-share-card-expires': new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    )
    const hit = await t.request(cardPath('Survey'))
    expect(hit.status).toBe(200)
    const header = hit.headers.get('cache-control') ?? ''
    expect(Number(/s-maxage=(\d+)/.exec(header)?.[1])).toBeLessThanOrEqual(3600)
    expect(Number(/(?:^|\s)max-age=(\d+)/.exec(header)?.[1])).toBeLessThanOrEqual(3600)
    expect(hit.headers.get('x-share-card-expires')).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
    // 记录已到期的边缘条目视为未命中，交给解析。
    t.edge.set(
      url,
      new Response(PNG, {
        headers: { 'x-share-card-expires': new Date(Date.now() - 1000).toISOString() },
      }),
    )
    expect((await t.request(cardPath('Survey'))).status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('redirects malformed v values instead of touching cache or storage', async () => {
    const t = setup()
    const get = vi.spyOn(t.store, 'get')
    for (const v of ['..', '.', '%2F', 'a/b', 'x'.repeat(65)]) {
      const response = await t.request(`/share-card/${TYPE}/${token}.png?v=${v}`)
      expect(response.status, v).toBe(302)
      expect(response.headers.get('location')).toBe(cardPath('Survey'))
    }
    expect(get).not.toHaveBeenCalled()
  })

  it('treats a storage read failure as a miss and hides resolve errors as 500', async () => {
    const t = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const get = t.store.get
      t.store.get = async (key) => {
        if (key.includes('/img/')) throw new Error('storage down')
        return get(key)
      }
      const rendered = await t.request(cardPath('Survey'))
      expect(rendered.status).toBe(200)
      expect(t.render).toHaveBeenCalledTimes(1)
      t.edge.clear()
      resolve.mockRejectedValueOnce(new Error('secret database detail'))
      const failed = await t.request(cardPath('Survey'))
      expect(failed.status).toBe(500)
      expect(failed.headers.get('cache-control')).toBe('no-store')
      expect(failed.headers.get('x-robots-tag')).toBe('noindex')
      expect(failed.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await failed.text()).not.toContain('secret')
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
