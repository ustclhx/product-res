import type { KeyValueStore } from '@product-res/platform'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSafeReturnPath,
  issueSubjectContext,
  openSubjectContext,
  SUBJECT_CONTEXT_MAX_CHARS,
  SUBJECT_CONTEXT_TTL_MS,
  subjectContextMeta,
  subjectSystemParts,
  subjectSystemText,
} from './subject-context.ts'
import { registerConversationSubject } from './subjects.ts'

// add-subject-chat tasks.md 2.2：临时上下文令牌的签发与打开、system 消息的固定前缀。

function memoryKv() {
  const store = new Map<string, string>()
  const kv = {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  }
  return kv as unknown as KeyValueStore & { store: Map<string, string> }
}

const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const NOW = Date.UTC(2026, 10, 10, 12)
const CONTEXT = { version: 'result-v2', text: 'PRIVATE-CONTEXT-BODY', data: { score: 42 } }
let unregister: () => void

beforeEach(() => {
  unregister = registerConversationSubject('result', { label: () => 'Result' })
})
afterEach(() => unregister())

async function issued(kv = memoryKv()) {
  const result = await issueSubjectContext(
    { secret: SECRET, cache: kv, now: NOW },
    {
      userId: 'user-a',
      workspaceId: 'ws-a',
      subjectType: 'result',
      context: CONTEXT,
      title: 'My result',
      suggestions: ['What does it mean?'],
      returnTo: '/results/demo#r=abc',
    },
  )
  return { kv, ...result }
}

const open = (
  kv: KeyValueStore,
  token: string,
  userId = 'user-a',
  now = NOW + 1000,
  workspaceId = 'ws-a',
) => openSubjectContext({ secret: SECRET, cache: kv, now }, { userId, workspaceId, token })

/** 用与实现相同的派生密钥签任意 payload，模拟签发端遗漏校验的情况 */
async function signRaw(payload: unknown) {
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`subject-context:${SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `${body}.${encode(new Uint8Array(sig))}`
}

describe('subject system message', () => {
  it('starts with a fixed header and appends data as JSON; the data part holds no body', () => {
    const text = subjectSystemText('result', CONTEXT)
    expect(text.split('\n')[0]).toBe('[context type=result version=result-v2]')
    expect(text).toContain('PRIVATE-CONTEXT-BODY')
    expect(text).toContain('{"score":42}')
    const parts = subjectSystemParts('result', CONTEXT)
    expect(subjectContextMeta(parts)).toEqual({ subjectType: 'result', version: 'result-v2' })
    expect(JSON.stringify(parts[1])).not.toContain('PRIVATE')
  })
})

describe('temporary subject context', () => {
  it('stores the body under a random key and signs a token without the body', async () => {
    const { kv, token, subjectId, expiresAt } = await issued()
    expect(expiresAt).toBe(NOW + SUBJECT_CONTEXT_TTL_MS)
    expect([...kv.store.keys()]).toEqual([`subject-context:${subjectId}`])
    const body = atob((token.split('.')[0] ?? '').replaceAll('-', '+').replaceAll('_', '/'))
    expect(body).not.toContain('PRIVATE-CONTEXT-BODY')
    expect(JSON.parse(body)).toMatchObject({ uid: 'user-a', type: 'result', id: subjectId })
    const opened = await open(kv, token)
    expect(opened).toMatchObject({
      status: 'ok',
      subjectType: 'result',
      subjectId,
      returnTo: '/results/demo#r=abc',
      stored: { title: 'My result', suggestions: ['What does it mean?'] },
    })
  })

  it('rejects tampered tokens without revealing returnTo', async () => {
    const { kv, token } = await issued()
    const [body, signature] = token.split('.') as [string, string]
    const forged = btoa(
      JSON.stringify({
        ...JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/'))),
        uid: 'user-b',
      }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`
    for (const bad of [
      `${forged}.${signature}`,
      `${body}.${flipped}`,
      `${body}.${signature}.extra`,
      'not-a-token',
      `${body}.`,
      'x'.repeat(2000),
    ])
      expect(await open(kv, bad)).toEqual({ status: 'invalid' })
    // 换密钥签发的令牌同样无效
    const other = await issueSubjectContext(
      { secret: `${SECRET}-other`, cache: kv, now: NOW },
      {
        userId: 'user-a',
        workspaceId: 'ws-a',
        subjectType: 'result',
        context: CONTEXT,
        returnTo: '/r',
      },
    )
    expect(await open(kv, other.token)).toEqual({ status: 'invalid' })
  })

  it('treats another user’s or another workspace’s token as invalid', async () => {
    const { kv, token } = await issued()
    expect(await open(kv, token, 'user-b')).toEqual({ status: 'invalid' })
    expect(await open(kv, token, 'user-a', NOW + 1000, 'ws-b')).toEqual({ status: 'invalid' })
  })

  it('rechecks returnTo when opening, even for a correctly signed token', async () => {
    const { kv, subjectId } = await issued()
    const token = await signRaw({
      v: 1,
      id: subjectId,
      uid: 'user-a',
      ws: 'ws-a',
      type: 'result',
      returnTo: 'https://evil.example',
      exp: NOW + 60_000,
    })
    expect(await open(kv, token)).toEqual({ status: 'invalid' })
  })

  it('reports expiry (or a missing KV entry) with the return path', async () => {
    const { kv, token, subjectId } = await issued()
    expect(await open(kv, token, 'user-a', NOW + SUBJECT_CONTEXT_TTL_MS)).toEqual({
      status: 'expired',
      subjectType: 'result',
      subjectId,
      returnTo: '/results/demo#r=abc',
    })
    kv.store.clear()
    expect(await open(kv, token)).toMatchObject({
      status: 'expired',
      returnTo: '/results/demo#r=abc',
    })
  })

  it('refuses unregistered types, unsafe return paths and empty contexts', async () => {
    const deps = { secret: SECRET, cache: memoryKv(), now: NOW }
    const base = {
      userId: 'u',
      workspaceId: 'w',
      subjectType: 'result',
      context: CONTEXT,
      returnTo: '/ok',
    }
    await expect(issueSubjectContext(deps, { ...base, subjectType: 'unknown' })).rejects.toThrow()
    for (const returnTo of [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      'relative',
      '/javascript:alert(1)',
    ])
      await expect(issueSubjectContext(deps, { ...base, returnTo })).rejects.toThrow()
    await expect(
      issueSubjectContext(deps, { ...base, context: { version: 'v1' } }),
    ).rejects.toThrow()
    // 总长度上限：文本与 JSON 数据合计超过 20 万字符即拒绝
    await expect(
      issueSubjectContext(deps, {
        ...base,
        context: { version: 'v1', text: 'a'.repeat(150_000), data: { b: 'b'.repeat(60_000) } },
      }),
    ).rejects.toThrow()
    await expect(
      issueSubjectContext(deps, {
        ...base,
        context: { version: 'v1', data: { b: 'b'.repeat(SUBJECT_CONTEXT_MAX_CHARS) } },
      }),
    ).rejects.toThrow()
    expect(
      (
        await issueSubjectContext(deps, {
          ...base,
          context: { version: 'v1', text: 'a'.repeat(150_000) },
        })
      ).token,
    ).toBeTruthy()
  })

  it('accepts same-site paths only', () => {
    expect(isSafeReturnPath('/zh/results?x=1#r=2')).toBe(true)
    expect(isSafeReturnPath('/a\nb')).toBe(false)
    expect(isSafeReturnPath('//x')).toBe(false)
  })
})
