import { AppError } from '@product-res/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type WebRuntime, withWebRuntime } from '../../server/runtime.ts'
import { handleSampleShareFixture, handleShareCardPreviewRequest } from './preview.server.ts'

const admin = vi.hoisted(() => ({ allowed: false }))
vi.mock('../admin/guard.ts', () => ({
  requireAdmin: async () => {
    if (!admin.allowed) throw new AppError('NOT_FOUND', 'Not Found', { status: 404 })
    return {}
  },
  isAdminNotFound: (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
}))

const invalidate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./invalidate.server.ts', () => ({ invalidateShareCard: invalidate }))

const kvPut = vi.hoisted(() =>
  vi.fn(async (_key: string, _value: string, _options?: { expirationTtl?: number }) => {}),
)

function runtime(preview: boolean, limited = false) {
  return {
    cache: { put: kvPut, get: vi.fn(async () => null) },
    config: { APP_URL: 'https://app.example', UI_PREVIEW: preview ? 'true' : undefined },
    db: {},
    auth: {},
    rateLimiter: { limit: vi.fn(async () => ({ success: !limited })) },
    requestMeta: { requestId: 'request', clientIp: '203.0.113.9' },
    shareCardRenderer: {
      available: true,
      value: async () => ({ render: async () => new Uint8Array([137, 80, 78, 71]) }),
    },
  } as unknown as WebRuntime
}

const post = (body: unknown) =>
  new Request('https://app.example/api/dev/share-cards', {
    method: 'POST',
    body: JSON.stringify(body),
  })

beforeEach(() => {
  admin.allowed = false
  invalidate.mockClear()
  kvPut.mockClear()
})

describe('sample share fixture endpoint', () => {
  it('answers 404 in production (UI_PREVIEW off) even for admins', async () => {
    admin.allowed = true
    const response = await withWebRuntime(runtime(false), () =>
      handleSampleShareFixture(post({ action: 'create' })),
    )
    expect(response.status).toBe(404)
  })

  it('answers 404 without a platform admin session', async () => {
    for (const action of ['create', 'invalidate']) {
      const response = await withWebRuntime(runtime(true), () =>
        handleSampleShareFixture(post({ action, token: 'AbCdEfGhIjKlMnOpQrStUv' })),
      )
      expect(response.status).toBe(404)
    }
    expect(invalidate).not.toHaveBeenCalled()
    expect(kvPut).not.toHaveBeenCalled()
  })

  it('lets admins create fixed sample shares and invalidate only sample tokens', async () => {
    admin.allowed = true
    const created = await withWebRuntime(runtime(true), () =>
      handleSampleShareFixture(post({ action: 'create', title: '<script>' })),
    )
    expect(created.status).toBe(200)
    const { token, page } = (await created.json()) as { token: string; page: string }
    expect(page).toBe(`/s/sample/${token}`)
    // 记录写入 KV（1 天 TTL），staging 其他隔离区也能解析；不接受请求中的任意文本。
    expect(kvPut).toHaveBeenCalledWith(`share-sample:${token}`, expect.any(String), {
      expirationTtl: 86_400,
    })
    expect(kvPut.mock.calls[0]?.[1]).not.toContain('<script>')
    const zh = await withWebRuntime(runtime(true), () =>
      handleSampleShareFixture(post({ action: 'create', variant: 'zh' })),
    )
    expect(zh.status).toBe(200)
    expect(kvPut.mock.calls.at(-1)?.[1]).toContain('第三季度')
    await withWebRuntime(runtime(true), () =>
      handleSampleShareFixture(post({ action: 'create', variant: 'constructor' })),
    )
    expect(kvPut.mock.calls.at(-1)?.[1]).toContain('Q3 2026')
    const ok = await withWebRuntime(runtime(true), () =>
      handleSampleShareFixture(post({ action: 'invalidate', token })),
    )
    expect(ok.status).toBe(200)
    expect(invalidate).toHaveBeenCalledWith({
      type: 'sample',
      token,
      workspaceId: 'sample-workspace',
    })
    const bad = await withWebRuntime(runtime(true), () =>
      handleSampleShareFixture(post({ action: 'invalidate', token: '../other' })),
    )
    expect(bad.status).toBe(400)
  })
})

describe('share card preview image endpoint', () => {
  const get = (query: string) =>
    new Request(`https://app.example/api/dev/share-card-preview?${query}`)

  it('is closed when UI_PREVIEW is off and validates the variant', async () => {
    expect(
      (await withWebRuntime(runtime(false), () => handleShareCardPreviewRequest(get('variant=zh'))))
        .status,
    ).toBe(404)
    expect(
      (
        await withWebRuntime(runtime(true), () =>
          handleShareCardPreviewRequest(get('variant=constructor')),
        )
      ).status,
    ).toBe(404)
  })

  it('renders a PNG and shares the shareCard rate limit', async () => {
    const open = runtime(true)
    const response = await withWebRuntime(open, () =>
      handleShareCardPreviewRequest(get('variant=zh&mode=dark')),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(open.rateLimiter.limit).toHaveBeenCalledWith('shareCard', 'share:ip:203.0.113.9')
    const limited = await withWebRuntime(runtime(true, true), () =>
      handleShareCardPreviewRequest(get('variant=zh')),
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })
})
