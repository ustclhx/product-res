import { describe, expect, it, vi } from 'vitest'
import { isShareCardExpired, shareCardExpiresAt } from './expiry.ts'
import { defaultShareTokenPattern, getShareCard, registerShareCard } from './registry.ts'
import {
  addSampleShare,
  registerSampleShareCard,
  SAMPLE_SHARE_TTL,
  sampleShareKey,
  sampleShareToken,
} from './sample.ts'
import { createShareToken } from './token.ts'
import type { ShareCardDefinition } from './types.ts'

const definition: ShareCardDefinition<{ title: string }> = {
  type: 'registry-test',
  version: 1,
  resolve: async () => null,
  digest: (data) => data.title,
  render: () => <div />,
  alt: (data) => data.title,
  page: (data) => ({ title: data.title, description: '' }),
}

describe('share card registry', () => {
  it('rejects duplicate types and leaves unknown types unregistered', () => {
    expect(getShareCard('unregistered')).toBeUndefined()
    const registered = registerShareCard(definition)
    expect(getShareCard(definition.type)).toBe(registered)
    expect(registered.tokenPattern).toEqual(defaultShareTokenPattern)
    expect(registered.ttlDays).toBe(90)
    expect(registered.sharePage).toBe(true)
    expect(() => registerShareCard(definition)).toThrow(/already registered/)
    expect(() => registerShareCard({ ...definition, type: '../invalid' })).toThrow(TypeError)
  })

  it('replaces a re-registered type on dev reloads and still rejects duplicates otherwise', () => {
    const type = 'reload-test'
    registerShareCard({ ...definition, type })
    // 开发服务器热更新重新执行注册入口：新定义替换旧定义，不让 /s/ 返回 500。
    vi.stubEnv('MODE', 'development')
    vi.stubEnv('DEV', true)
    try {
      const reloaded = registerShareCard({ ...definition, type, version: 2 })
      expect(getShareCard(type)).toBe(reloaded)
      expect(getShareCard(type)?.version).toBe(2)
    } finally {
      vi.unstubAllEnvs()
    }
    vi.stubEnv('DEV', false)
    vi.stubEnv('MODE', 'production')
    try {
      expect(() => registerShareCard({ ...definition, type })).toThrow(/already registered/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps per-type token, expiry and share-page choices', () => {
    const custom = registerShareCard({
      ...definition,
      type: 'custom-test',
      ttlDays: 30,
      tokenPattern: /^custom-[a-z]+$/,
      sharePage: false,
    })
    expect(custom.ttlDays).toBe(30)
    expect(custom.tokenPattern.test('custom-example')).toBe(true)
    expect(custom.sharePage).toBe(false)
    expect(
      registerShareCard({ ...definition, type: 'permanent-test', ttlDays: null }).ttlDays,
    ).toBeNull()
  })

  it('registers the sample explicitly and resolves fixture shares from KV', async () => {
    expect(getShareCard('sample')).toBeUndefined()
    // 两个独立的 Map 模拟 KV：写入与读取发生在不同隔离区时仍能解析。
    const entries = new Map<string, { value: string; ttl?: number | undefined }>()
    const kv = {
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        entries.set(key, { value, ttl: options?.expirationTtl })
      }),
      get: vi.fn(async (key: string) => {
        const raw = entries.get(key)?.value
        return raw === undefined ? null : JSON.parse(raw)
      }),
    }
    const sample = registerSampleShareCard(
      () => <div />,
      () => kv as never,
    )
    const ctx = { db: {} as Parameters<typeof sample.resolve>[1]['db'] }
    expect((await sample.resolve(sampleShareToken, ctx))?.data.title).toBe('Project summary')
    expect(await sample.resolve('missing', ctx)).toBeNull()

    const token = createShareToken()
    const expiresAt = new Date('2030-01-01T00:00:00.000Z')
    await addSampleShare(kv, token, { title: 'Fixture', description: 'From KV' }, expiresAt)
    expect(entries.get(sampleShareKey(token))?.ttl).toBe(SAMPLE_SHARE_TTL)
    expect(sampleShareKey(token)).toBe(`share-sample:${token}`)
    const resolved = await sample.resolve(token, ctx)
    expect(resolved?.workspaceId).toBe('sample-workspace')
    expect(resolved?.data.title).toBe('Fixture')
    expect(resolved?.expiresAt?.toISOString()).toBe(expiresAt.toISOString())
    expect(resolved?.sharedAt).toBeInstanceOf(Date)
  })

  it('rejects invalid type TTL values without registering the type', () => {
    for (const ttlDays of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      const type = 'invalid-ttl-test'
      expect(() => registerShareCard({ ...definition, type, ttlDays })).toThrow(
        /positive integer or null/,
      )
      expect(getShareCard(type)).toBeUndefined()
    }
  })
})

it('creates independent 32-byte base64url tokens within the default format', () => {
  const tokens = Array.from({ length: 20 }, createShareToken)
  expect(new Set(tokens).size).toBe(tokens.length)
  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(defaultShareTokenPattern.test(token)).toBe(true)
    expect(atob(`${token.replaceAll('-', '+').replaceAll('_', '/')}=`).length).toBe(32)
  }
  for (const invalid of [
    'a'.repeat(21),
    'a'.repeat(65),
    `${'a'.repeat(22)}/`,
    `${'a'.repeat(22)}=`,
  ]) {
    expect(defaultShareTokenPattern.test(invalid)).toBe(false)
  }
})

describe('share card expiry', () => {
  const sharedAt = new Date('2026-01-01T12:00:00Z')
  it('uses 90 days by default and allows a type to select 30 days', () => {
    expect(shareCardExpiresAt({ sharedAt })).toEqual(new Date('2026-04-01T12:00:00Z'))
    const expiry = shareCardExpiresAt({ sharedAt }, 30)
    expect(expiry).toEqual(new Date('2026-01-31T12:00:00Z'))
    expect(isShareCardExpired(expiry, new Date('2026-01-31T11:59:59Z'))).toBe(false)
    expect(isShareCardExpired(expiry, new Date('2026-01-31T12:00:00Z'))).toBe(true)
  })

  it('gives explicit expiresAt priority, including null, over type defaults', () => {
    const expiresAt = new Date('2026-01-05T12:00:00Z')
    expect(shareCardExpiresAt({ sharedAt, expiresAt }, null)).toBe(expiresAt)
    expect(shareCardExpiresAt({ sharedAt, expiresAt: null }, 30)).toBeNull()
    expect(shareCardExpiresAt({ sharedAt }, null)).toBeNull()
    expect(isShareCardExpired(null, new Date('2099-01-01T00:00:00Z'))).toBe(false)
  })

  it('treats invalid explicit or calculated expiry dates as expired', () => {
    const invalid = new Date(Number.NaN)
    expect(isShareCardExpired(shareCardExpiresAt({ sharedAt, expiresAt: invalid }))).toBe(true)
    expect(isShareCardExpired(shareCardExpiresAt({ sharedAt: invalid }))).toBe(true)
    expect(isShareCardExpired(new Date('2099-01-01T00:00:00Z'), invalid)).toBe(true)
  })
})
