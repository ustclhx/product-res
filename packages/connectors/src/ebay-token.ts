import { ConnectorError, httpRequest, parseJson } from '@product-res/datasources'

export const EBAY_API = 'https://api.ebay.com'
/** 应用令牌（client credentials）的公共 scope；Browse、Taxonomy 与 Notification getPublicKey 共用 */
export const EBAY_APP_SCOPE = 'https://api.ebay.com/oauth/api_scope'

export interface EbayAppToken {
  readonly value: string
  /** 毫秒时间戳 */
  readonly expiresAt: number
}

/**
 * 申请 eBay 应用令牌（client credentials grant）。调用方自行缓存：
 * Browse 连接器与账号删除通知验签（add-ebay-account-deletion D2）各自缓存到过期前 5 分钟。
 */
export async function requestEbayAppToken(
  fetchImpl: typeof fetch,
  credentials: { clientId: string | undefined; clientSecret: string | undefined },
  now: number,
): Promise<EbayAppToken> {
  const { clientId, clientSecret } = credentials
  if (!clientId || !clientSecret) throw new ConnectorError('auth', 'EBAY_CREDENTIALS_MISSING')
  const res = await httpRequest(fetchImpl, {
    method: 'POST',
    url: `${EBAY_API}/identity/v1/oauth2/token`,
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_APP_SCOPE)}`,
  })
  const body = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
  if (!body.access_token) throw new ConnectorError('auth', 'EBAY_TOKEN_MISSING')
  return { value: body.access_token, expiresAt: now + (body.expires_in ?? 7200) * 1000 }
}

/** 令牌在过期前 5 分钟视为失效 */
export function ebayTokenFresh(
  token: EbayAppToken | undefined,
  now: number,
): token is EbayAppToken {
  return token !== undefined && token.expiresAt - 5 * 60_000 > now
}
