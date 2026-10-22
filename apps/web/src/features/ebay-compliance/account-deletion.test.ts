import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { ConnectorError } from '@product-res/datasources'
import type { EbayAccountDeletionInput } from '@product-res/follow'
import { describe, expect, it, vi } from 'vitest'
import {
  type EbayAccountDeletionDeps,
  ebayAccountDeletionEndpoint,
  handleEbayChallenge,
  handleEbayNotification,
} from './account-deletion.ts'

// add-ebay-account-deletion 3.1：GET challenge、POST 验签 → 去重 → 删除 → 204；token 缺失 503、验签失败 412。

const TOKEN = 'Abc_DEF-0123456789abcdefghijklmnopqrstuv'
const URL_BASE = 'https://product.ezarouter.cc/api/webhooks/ebay/account-deletion'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pem = (publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '')

const payload = (topic = 'MARKETPLACE_ACCOUNT_DELETION') =>
  JSON.stringify({
    metadata: { topic, schemaVersion: '1.0', deprecated: false },
    notification: {
      notificationId: 'n-1',
      eventDate: '2026-10-22T00:00:00.000Z',
      publishDate: '2026-10-22T00:00:01.000Z',
      publishAttemptCount: 2,
      data: { username: 'kitchen_pro', userId: 'uid-1', eiasToken: 'eias' },
    },
  })

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

function header(body: string, kid = 'kid-1') {
  const signature = b64(new Uint8Array(sign('sha1', new TextEncoder().encode(body), privateKey)))
  return b64(
    new TextEncoder().encode(JSON.stringify({ alg: 'ECDSA', kid, signature, digest: 'SHA1' })),
  )
}

function deps(overrides: Partial<EbayAccountDeletionDeps> = {}) {
  const deleted: EbayAccountDeletionInput[] = []
  const value: EbayAccountDeletionDeps = {
    appUrl: 'https://product.ezarouter.cc/',
    secret: (name) => (name === 'EBAY_VERIFICATION_TOKEN' ? TOKEN : undefined),
    publicKeys: {
      get: async (kid) => {
        if (kid !== 'kid-1') throw new ConnectorError('permanent', 'EBAY_PUBLIC_KEY_NOT_FOUND')
        return { key: pem, algorithm: 'ECDSA', digest: 'SHA1' }
      },
    },
    deleteUserData: async (input) => {
      deleted.push(input)
      return {
        status: deleted.length > 1 ? 'duplicate' : 'processed',
        userHash: 'hash',
        counts: {
          trackedStores: 1,
          directionSellers: 0,
          storeListings: 0,
          sellers: 0,
          sellerObservations: 0,
          productsUnlinked: 0,
          leadEvents: 0,
          syncRuns: 0,
          rawPayloads: 0,
        },
      }
    },
    ...overrides,
  }
  return { value, deleted }
}

const post = (body: string, signature?: string) =>
  new Request(URL_BASE, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-ebay-signature': signature }),
    },
  })

describe('GET challenge', () => {
  it('endpoint 取 APP_URL 的 origin 加固定路径', () => {
    expect(ebayAccountDeletionEndpoint('https://product.ezarouter.cc/')).toBe(URL_BASE)
  })

  it('返回 JSON challengeResponse = sha256(code + token + endpoint)', async () => {
    const res = await handleEbayChallenge(
      new Request(`${URL_BASE}?challenge_code=abc123`),
      deps().value,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const expected = createHash('sha256')
      .update('abc123')
      .update(TOKEN)
      .update(URL_BASE)
      .digest('hex')
    await expect(res.json()).resolves.toEqual({ challengeResponse: expected })
  })

  it('token 缺失或不合规返回 503', async () => {
    for (const secret of [() => undefined, () => 'short']) {
      const res = await handleEbayChallenge(
        new Request(`${URL_BASE}?challenge_code=abc`),
        deps({ secret }).value,
      )
      expect(res.status).toBe(503)
    }
  })

  it('缺少 challenge_code 返回 400', async () => {
    const res = await handleEbayChallenge(new Request(URL_BASE), deps().value)
    expect(res.status).toBe(400)
  })
})

describe('POST 通知', () => {
  it('验签通过后删除并返回 204；日志不含用户名', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { value, deleted } = deps()
    const body = payload()
    const res = await handleEbayNotification(post(body, header(body)), value)
    expect(res.status).toBe(204)
    expect(deleted).toEqual([
      {
        notificationId: 'n-1',
        username: 'kitchen_pro',
        userId: 'uid-1',
        eventDate: '2026-10-22T00:00:00.000Z',
        publishAttemptCount: 2,
      },
    ])
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(lines).toContain('ebay.account_deletion.processed')
    expect(lines).not.toContain('kitchen_pro')
    expect(lines).not.toContain('uid-1')
    log.mockRestore()
  })

  it('篡改正文、缺少签名头、未知 kid 返回 412 且不删除', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { value, deleted } = deps()
    const body = payload()
    const tampered = body.replace('kitchen_pro', 'someone_else')
    expect((await handleEbayNotification(post(tampered, header(body)), value)).status).toBe(412)
    expect((await handleEbayNotification(post(body), value)).status).toBe(412)
    expect((await handleEbayNotification(post(body, 'garbage'), value)).status).toBe(412)
    expect((await handleEbayNotification(post(body, header(body, 'kid-x')), value)).status).toBe(
      412,
    )
    expect(deleted).toHaveLength(0)
    warn.mockRestore()
  })

  it('重复通知仍返回 204', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { value, deleted } = deps()
    const body = payload()
    expect((await handleEbayNotification(post(body, header(body)), value)).status).toBe(204)
    expect((await handleEbayNotification(post(body, header(body)), value)).status).toBe(204)
    expect(deleted).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('token 缺失返回 503，不验签不删除', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const get = vi.fn()
    const { value, deleted } = deps({ secret: () => undefined, publicKeys: { get } })
    const body = payload()
    expect((await handleEbayNotification(post(body, header(body)), value)).status).toBe(503)
    expect(get).not.toHaveBeenCalled()
    expect(deleted).toHaveLength(0)
    vi.restoreAllMocks()
  })

  it('公钥接口不可用返回 503；删除失败返回 500（eBay 重发）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = payload()
    const down = deps({
      publicKeys: {
        get: async () => {
          throw new ConnectorError('retryable', 'HTTP_TIMEOUT')
        },
      },
    })
    expect((await handleEbayNotification(post(body, header(body)), down.value)).status).toBe(503)
    const failing = deps({
      deleteUserData: async () => {
        throw new Error('db down')
      },
    })
    expect((await handleEbayNotification(post(body, header(body)), failing.value)).status).toBe(500)
    vi.restoreAllMocks()
  })

  it('其他主题确认但不删除', async () => {
    const { value, deleted } = deps()
    const body = payload('ITEM_SOLD')
    expect((await handleEbayNotification(post(body, header(body)), value)).status).toBe(204)
    expect(deleted).toHaveLength(0)
  })
})
