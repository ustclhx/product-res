import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createEbayPublicKeyStore,
  ebayChallengeResponse,
  isValidEbayVerificationToken,
  parseEbaySignatureHeader,
  verifyEbaySignature,
} from '../src/index.ts'

// add-ebay-account-deletion 1.1：challenge、签名头、验签与公钥缓存。不调用真实 eBay 接口。

const ENDPOINT = 'https://product.ezarouter.cc/api/webhooks/ebay/account-deletion'
const TOKEN = 'test-verification-token_0123456789abcdef'

/** 按 eBay 通知格式（官方文档样例结构）生成正文 */
const notification = {
  metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0', deprecated: false },
  notification: {
    notificationId: '49feeaeb-4982-42d9-a377-9645b8479411_33f7e043-fed8-442b-9d44-791923bd9a6d',
    eventDate: '2026-10-22T12:00:00.000Z',
    publishDate: '2026-10-22T12:00:00.000Z',
    publishAttemptCount: 1,
    data: {
      username: 'kitchen_pro',
      userId: 'ma8vp1jySJC',
      eiasToken: 'nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6wJnY+gAZGEpwmdj6x9nY+seQ==',
    },
  },
}

function keyPair(curve: 'prime256v1' | 'secp384r1' = 'prime256v1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve })
  // eBay 返回的 PEM 不带换行，与官方 SDK 的 formatKey 输入一致
  const pem = (publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '')
  return { privateKey, pem }
}

function signatureHeader(privateKey: KeyObject, body: string, kid = 'kid-1') {
  const signature = sign('sha1', Buffer.from(body), privateKey).toString('base64')
  return Buffer.from(JSON.stringify({ alg: 'ECDSA', kid, signature, digest: 'SHA1' })).toString(
    'base64',
  )
}

describe('eBay challenge', () => {
  it('按 challengeCode + verificationToken + endpoint 的顺序计算 SHA-256（与官方 SDK 逐段 update 一致）', async () => {
    // 期望值由官方 Node SDK 的算法（crypto.createHash 依次 update 三段）离线算出
    await expect(
      ebayChallengeResponse('a8628072-3d33-45ee-9004-bee86830a22d', TOKEN, ENDPOINT),
    ).resolves.toBe('e824488f487cce14a18662cd018dfb181f18a42bb65b3b40609a684599d30b40')
  })

  it('verification token 只接受 32–80 位 [A-Za-z0-9_-]', () => {
    expect(isValidEbayVerificationToken(TOKEN)).toBe(true)
    expect(isValidEbayVerificationToken('a'.repeat(31))).toBe(false)
    expect(isValidEbayVerificationToken('a'.repeat(81))).toBe(false)
    expect(isValidEbayVerificationToken(`${'a'.repeat(40)}!`)).toBe(false)
    expect(isValidEbayVerificationToken(undefined)).toBe(false)
  })
})

describe('eBay 签名', () => {
  const { privateKey, pem } = keyPair()
  const publicKey = { key: pem, algorithm: 'ECDSA', digest: 'SHA1' }

  it('解析签名头；非 base64 JSON、缺 kid 或 kid 含路径字符时返回 null', () => {
    const header = signatureHeader(privateKey, '{}')
    expect(parseEbaySignatureHeader(header)).toMatchObject({ kid: 'kid-1', alg: 'ECDSA' })
    expect(parseEbaySignatureHeader('not-base64!')).toBeNull()
    expect(parseEbaySignatureHeader(null)).toBeNull()
    const bad = Buffer.from(JSON.stringify({ kid: '../x', signature: 'AA==' })).toString('base64')
    expect(parseEbaySignatureHeader(bad)).toBeNull()
  })

  it('原始正文签名通过，篡改正文失败', async () => {
    const body = JSON.stringify(notification)
    const signature = parseEbaySignatureHeader(signatureHeader(privateKey, body))
    if (!signature) throw new Error('header')
    await expect(verifyEbaySignature({ rawBody: body, signature, publicKey })).resolves.toBe(true)
    const tampered = body.replace('kitchen_pro', 'kitchen_pr0')
    await expect(verifyEbaySignature({ rawBody: tampered, signature, publicKey })).resolves.toBe(
      false,
    )
  })

  it('官方 SDK 对紧凑序列化 JSON 验签：带空白的正文按紧凑序列化也能通过', async () => {
    const compact = JSON.stringify(notification)
    const pretty = JSON.stringify(notification, null, 2)
    const signature = parseEbaySignatureHeader(signatureHeader(privateKey, compact))
    if (!signature) throw new Error('header')
    await expect(verifyEbaySignature({ rawBody: pretty, signature, publicKey })).resolves.toBe(true)
  })

  it('其他密钥签名、非 ECDSA 算法或未知摘要都失败', async () => {
    const body = JSON.stringify(notification)
    const other = keyPair()
    const signature = parseEbaySignatureHeader(signatureHeader(other.privateKey, body))
    if (!signature) throw new Error('header')
    await expect(verifyEbaySignature({ rawBody: body, signature, publicKey })).resolves.toBe(false)
    const own = parseEbaySignatureHeader(signatureHeader(privateKey, body))
    if (!own) throw new Error('header')
    await expect(
      verifyEbaySignature({
        rawBody: body,
        signature: own,
        publicKey: { ...publicKey, algorithm: 'RSA' },
      }),
    ).resolves.toBe(false)
    await expect(
      verifyEbaySignature({
        rawBody: body,
        signature: own,
        publicKey: { ...publicKey, digest: 'MD5' },
      }),
    ).resolves.toBe(false)
  })

  it('支持 P-384 公钥', async () => {
    const p384 = keyPair('secp384r1')
    const body = JSON.stringify(notification)
    const signature = parseEbaySignatureHeader(signatureHeader(p384.privateKey, body))
    if (!signature) throw new Error('header')
    await expect(
      verifyEbaySignature({
        rawBody: body,
        signature,
        publicKey: { key: p384.pem, algorithm: 'ECDSA', digest: 'SHA1' },
      }),
    ).resolves.toBe(true)
  })
})

describe('eBay 公钥缓存', () => {
  const secrets: Record<string, string> = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' }

  function fakeEbay(status = 200) {
    const calls: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
      if (url.includes('oauth2/token'))
        return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 7200 }))
      if (status !== 200) return new Response('{}', { status })
      return new Response(JSON.stringify({ key: 'PEM', algorithm: 'ECDSA', digest: 'SHA1' }))
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it('同一 kid 在 1 小时内只拉取一次，过期后重新拉取；用应用令牌调用 getPublicKey', async () => {
    let now = 1_000_000
    const { calls, fetchImpl } = fakeEbay()
    const store = createEbayPublicKeyStore({
      fetch: fetchImpl,
      secret: (n) => secrets[n],
      now: () => now,
    })
    await store.get('kid-1')
    await store.get('kid-1')
    const keyCalls = () => calls.filter((c) => c.url.includes('/public_key/'))
    expect(keyCalls()).toHaveLength(1)
    expect(keyCalls()[0]).toEqual({
      url: 'https://api.ebay.com/commerce/notification/v1/public_key/kid-1',
      auth: 'Bearer app-token',
    })
    now += 60 * 60_000 + 1
    await store.get('kid-1')
    expect(keyCalls()).toHaveLength(2)
    // 令牌仍在有效期内，只申请一次
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(1)
  })

  it('未知 kid 报 EBAY_PUBLIC_KEY_NOT_FOUND；缺少凭据报 EBAY_CREDENTIALS_MISSING', async () => {
    const missing = fakeEbay(404)
    const store = createEbayPublicKeyStore({ fetch: missing.fetchImpl, secret: (n) => secrets[n] })
    await expect(store.get('nope')).rejects.toMatchObject({ code: 'EBAY_PUBLIC_KEY_NOT_FOUND' })
    const noCreds = createEbayPublicKeyStore({
      fetch: fakeEbay().fetchImpl,
      secret: () => undefined,
    })
    await expect(noCreds.get('kid-1')).rejects.toMatchObject({ code: 'EBAY_CREDENTIALS_MISSING' })
  })
})
