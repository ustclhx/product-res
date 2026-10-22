import { ConnectorError, httpRequest, parseJson } from '@product-res/datasources'
import { EBAY_API, type EbayAppToken, ebayTokenFresh, requestEbayAppToken } from './ebay-token.ts'

/**
 * eBay 通知协议（openspec/changes/add-ebay-account-deletion design D1、D2）。
 * 依据 developer.ebay.com/marketplace-account-deletion、Notification API getPublicKey 与官方
 * event-notification-nodejs-sdk / java-sdk 实现；只用 WebCrypto，Node 与 Workers 都可运行。
 */

export const EBAY_ACCOUNT_DELETION_TOPIC = 'MARKETPLACE_ACCOUNT_DELETION'
export const EBAY_ACCOUNT_DELETION_PATH = '/api/webhooks/ebay/account-deletion'

const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{32,80}$/
const KEY_ID = /^[A-Za-z0-9._:-]{1,200}$/
/** 官方建议公钥缓存约 1 小时 */
const KEY_TTL_MS = 60 * 60_000
const KEY_CACHE_MAX = 32

/** eBay 要求 verification token 为 32–80 位，只含字母数字、下划线与连字符 */
export function isValidEbayVerificationToken(token: string | undefined): token is string {
  return token !== undefined && VERIFICATION_TOKEN.test(token)
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/** challengeResponse = hex(SHA-256(challengeCode + verificationToken + endpoint))，顺序不能变 */
export function ebayChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): Promise<string> {
  return sha256Hex(challengeCode + verificationToken + endpoint)
}

export interface EbaySignatureHeader {
  readonly alg?: string
  readonly kid: string
  readonly signature: string
  readonly digest?: string
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** X-EBAY-SIGNATURE = base64(JSON {alg, kid, signature, digest})；无法解析返回 null */
export function parseEbaySignatureHeader(
  header: string | null | undefined,
): EbaySignatureHeader | null {
  if (!header || header.length > 8192) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Bytes(header))) as Record<
      string,
      unknown
    >
    const { kid, signature, alg, digest } = parsed
    if (typeof kid !== 'string' || !KEY_ID.test(kid)) return null
    if (typeof signature !== 'string' || signature.length === 0) return null
    return {
      kid,
      signature,
      ...(typeof alg === 'string' ? { alg } : {}),
      ...(typeof digest === 'string' ? { digest } : {}),
    }
  } catch {
    return null
  }
}

/** getPublicKey 的响应：key 为不带换行的 PEM，algorithm 如 ECDSA，digest 如 SHA1 */
export interface EbayPublicKey {
  readonly key: string
  readonly algorithm: string
  readonly digest: string
}

const CURVES = [
  { name: 'P-256', size: 32 },
  { name: 'P-384', size: 48 },
  { name: 'P-521', size: 66 },
] as const

function hashName(digest: string): string | null {
  const m = /^SHA-?(1|256|384|512)$/i.exec(digest.trim())
  return m ? `SHA-${m[1]}` : null
}

function pemBytes(pem: string): Uint8Array {
  return base64Bytes(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, ''))
}

/** DER 长度字段（支持长格式） */
function derLength(der: Uint8Array, at: number): [length: number, next: number] {
  const first = der[at] ?? 0
  if (first < 0x80) return [first, at + 1]
  const count = first & 0x7f
  if (count === 0 || count > 2) throw new Error('DER_LENGTH')
  let length = 0
  for (let i = 1; i <= count; i++) length = (length << 8) | (der[at + i] ?? 0)
  return [length, at + 1 + count]
}

/** DER ECDSA 签名（SEQUENCE { INTEGER r, INTEGER s }）转 WebCrypto 需要的 r‖s 定长格式 */
export function derToP1363(der: Uint8Array, size: number): Uint8Array {
  if (der[0] !== 0x30) throw new Error('DER_SEQUENCE')
  let [, at] = derLength(der, 1)
  const out = new Uint8Array(size * 2)
  for (let part = 0; part < 2; part++) {
    if (der[at] !== 0x02) throw new Error('DER_INTEGER')
    const [length, start] = derLength(der, at + 1)
    let value = der.subarray(start, start + length)
    while (value.length > size && value[0] === 0) value = value.subarray(1)
    if (value.length > size) throw new Error('DER_INTEGER_SIZE')
    out.set(value, part * size + (size - value.length))
    at = start + length
  }
  return out
}

/**
 * 校验通知签名。官方 SDK 都对“解析后紧凑序列化”的 JSON 验签；先用原始正文，失败再用紧凑序列化。
 * 算法不是 ECDSA、摘要未知、签名格式错误都视为校验失败。
 */
export async function verifyEbaySignature(input: {
  readonly rawBody: string
  readonly signature: EbaySignatureHeader
  readonly publicKey: EbayPublicKey
}): Promise<boolean> {
  const { publicKey, signature } = input
  if (publicKey.algorithm.trim().toUpperCase() !== 'ECDSA') return false
  const hash = hashName(publicKey.digest || signature.digest || '')
  if (!hash) return false
  let der: Uint8Array
  let spki: Uint8Array
  try {
    der = base64Bytes(signature.signature)
    spki = pemBytes(publicKey.key)
  } catch {
    return false
  }
  const candidates = [input.rawBody]
  try {
    const compact = JSON.stringify(JSON.parse(input.rawBody))
    if (compact !== input.rawBody) candidates.push(compact)
  } catch {
    // 非 JSON 正文只按原文校验
  }
  for (const curve of CURVES) {
    let key: CryptoKey
    try {
      key = await crypto.subtle.importKey(
        'spki',
        spki as BufferSource,
        { name: 'ECDSA', namedCurve: curve.name },
        false,
        ['verify'],
      )
    } catch {
      continue
    }
    let raw: Uint8Array
    try {
      raw = derToP1363(der, curve.size)
    } catch {
      return false
    }
    for (const body of candidates) {
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash },
        key,
        raw as BufferSource,
        encoder.encode(body),
      )
      if (ok) return true
    }
    return false
  }
  return false
}

export interface EbayPublicKeyStore {
  /** 未知 kid 抛出 ConnectorError('permanent', 'EBAY_PUBLIC_KEY_NOT_FOUND')；凭据或网络问题抛出其他 ConnectorError */
  get(kid: string): Promise<EbayPublicKey>
}

/** 按 kid 缓存公钥 1 小时（官方建议）；应用令牌缓存到过期前 5 分钟。拉取失败不缓存 */
export function createEbayPublicKeyStore(options: {
  readonly fetch: typeof fetch
  readonly secret: (name: string) => string | undefined
  readonly now?: () => number
  readonly ttlMs?: number
}): EbayPublicKeyStore {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? KEY_TTL_MS
  const keys = new Map<string, { value: EbayPublicKey; expiresAt: number }>()
  let token: EbayAppToken | undefined

  async function accessToken() {
    const at = now()
    if (ebayTokenFresh(token, at)) return token.value
    token = await requestEbayAppToken(
      options.fetch,
      {
        clientId: options.secret('EBAY_CLIENT_ID'),
        clientSecret: options.secret('EBAY_CLIENT_SECRET'),
      },
      at,
    )
    return token.value
  }

  return {
    async get(kid) {
      const cached = keys.get(kid)
      if (cached && cached.expiresAt > now()) return cached.value
      let body: string
      try {
        const res = await httpRequest(options.fetch, {
          url: `${EBAY_API}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
          headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' },
          timeoutMs: 10_000,
        })
        body = res.body
      } catch (error) {
        if (error instanceof ConnectorError && (error.status === 400 || error.status === 404))
          throw new ConnectorError('permanent', 'EBAY_PUBLIC_KEY_NOT_FOUND', {
            status: error.status,
          })
        // 令牌被拒时丢弃缓存，下次重新申请
        if (error instanceof ConnectorError && error.status === 401) token = undefined
        throw error
      }
      const parsed = parseJson<Partial<EbayPublicKey>>(body)
      if (!parsed.key || !parsed.algorithm || !parsed.digest)
        throw new ConnectorError('invalid-response', 'EBAY_PUBLIC_KEY_INVALID')
      const value = { key: parsed.key, algorithm: parsed.algorithm, digest: parsed.digest }
      if (keys.size >= KEY_CACHE_MAX) keys.delete(keys.keys().next().value as string)
      keys.set(kid, { value, expiresAt: now() + ttl })
      return value
    },
  }
}
