import type { KeyValueStore } from '@product-res/platform'

// OAuth 仅读取文本；写入使用平台 TTL 契约，适配器负责目标平台细节。
export interface PayPalTokenCache extends Pick<KeyValueStore, 'put'> {
  get(key: string): Promise<string | null>
}

export interface PayPalTransportOptions {
  environment: 'sandbox' | 'live'
  clientId?: string
  clientSecret?: string
  fetch: typeof fetch
  cache: PayPalTokenCache
  now?: () => number
}

export interface PayPalRequestOptions {
  body?: unknown
  idempotencyKey?: string
}

export interface PayPalTransport {
  readonly apiOrigin: string
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options?: PayPalRequestOptions,
  ): Promise<T>
}

/** Do not attach response bodies: OAuth errors can contain sensitive input. */
export class PayPalHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`PayPal HTTP request failed (${status})`)
    this.status = status
    this.name = 'PayPalHttpError'
  }
}

/** Operation-scoped deterministic ID fits PayPal request-ID limits. */
export async function payPalRequestId(scope: string, key: string): Promise<string> {
  if (!key.trim()) throw new Error('A nonempty stable idempotency key is required')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${scope}\0${key}`))
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** Construction performs no credential checks or I/O. All HTTP uses the injected fetch. */
export function createPayPalTransport(options: PayPalTransportOptions): PayPalTransport {
  // 原生 fetch 不接受 options 作为 this，保持普通函数调用。
  const { fetch } = options
  const base =
    options.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
  const now = options.now ?? Date.now
  let pendingToken: Promise<string> | undefined

  async function loadToken(): Promise<string> {
    const { clientId, clientSecret } = options
    if (!clientId || !clientSecret) throw new Error('PayPal credentials are not configured')
    const cacheKey = `paypal:oauth:v1:${options.environment}:${encodeURIComponent(clientId)}`
    const cached = await options.cache.get(cacheKey)
    if (cached) {
      let token: unknown
      try {
        token = JSON.parse(cached)
      } catch {
        // A malformed cache entry is a miss; never expose its token in a parser error.
        token = null
      }
      if (
        typeof token === 'object' &&
        token !== null &&
        'accessToken' in token &&
        'expiresAt' in token &&
        typeof token.accessToken === 'string' &&
        token.accessToken.length > 0 &&
        typeof token.expiresAt === 'number' &&
        Number.isFinite(token.expiresAt) &&
        token.expiresAt > now()
      ) {
        return token.accessToken
      }
    }
    const startedAt = now()
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!response.ok) throw new PayPalHttpError(response.status)
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch {
      throw new Error('Invalid PayPal OAuth response')
    }
    if (typeof decoded !== 'object' || decoded === null)
      throw new Error('Invalid PayPal OAuth response')
    const token = decoded as { access_token?: unknown; expires_in?: unknown }
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      typeof token.expires_in !== 'number' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    ) {
      throw new Error('Invalid PayPal OAuth response')
    }
    const ttl = Math.floor(token.expires_in - Math.min(60, token.expires_in / 10))
    const expiresAt = startedAt + ttl * 1000
    const remaining = Math.floor((expiresAt - now()) / 1000)
    // KV requires a minimum TTL of 60; short-lived tokens can still be used once.
    if (remaining >= 60)
      await options.cache.put(
        cacheKey,
        JSON.stringify({ accessToken: token.access_token, expiresAt }),
        { expirationTtl: remaining },
      )
    return token.access_token
  }

  async function accessToken() {
    if (!pendingToken)
      pendingToken = loadToken().finally(() => {
        pendingToken = undefined
      })
    return pendingToken
  }

  return {
    apiOrigin: base,
    async request<T>(
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      request: PayPalRequestOptions = {},
    ): Promise<T> {
      if (!/^\/v[12]\/[a-z0-9/_?=&%.-]+$/i.test(path))
        throw new Error('Expected a relative PayPal API path')
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      }
      if (request.idempotencyKey !== undefined)
        headers['PayPal-Request-Id'] = await payPalRequestId(
          `${method}:${path}`,
          request.idempotencyKey,
        )
      headers.Authorization = `Bearer ${await accessToken()}`
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
      if (!response.ok) throw new PayPalHttpError(response.status)
      if (response.status === 204) return undefined as T
      return (await response.json()) as T
    },
  }
}
