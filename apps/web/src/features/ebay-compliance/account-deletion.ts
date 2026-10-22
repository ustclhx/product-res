import {
  EBAY_ACCOUNT_DELETION_PATH,
  EBAY_ACCOUNT_DELETION_TOPIC,
  type EbayPublicKey,
  type EbayPublicKeyStore,
  ebayChallengeResponse,
  isValidEbayVerificationToken,
  parseEbaySignatureHeader,
  verifyEbaySignature,
} from '@product-res/connectors'
import { ConnectorError } from '@product-res/datasources'
import type { EbayAccountDeletionInput, EbayAccountDeletionResult } from '@product-res/follow'
import { log } from '@product-res/shared/log'

/**
 * eBay Marketplace Account Deletion 通知端点（openspec/changes/add-ebay-account-deletion）。
 * 顺序：challenge / 验签 → 去重 → 事务删除（deleteUserData 内）→ 204。没有异步副作用。
 * 日志只写用户名哈希、计数与 notificationId，不写用户名、userId、eiasToken 与正文。
 */

export interface EbayAccountDeletionDeps {
  /** APP_URL；endpoint = origin + 固定路径，必须与 eBay 后台填写的地址逐字一致 */
  readonly appUrl: string
  readonly secret: (name: string) => string | undefined
  readonly publicKeys: EbayPublicKeyStore
  readonly deleteUserData: (input: EbayAccountDeletionInput) => Promise<EbayAccountDeletionResult>
}

const MAX_BODY_BYTES = 64 * 1024

export function ebayAccountDeletionEndpoint(appUrl: string) {
  return `${new URL(appUrl).origin}${EBAY_ACCOUNT_DELETION_PATH}`
}

const empty = (status: number) => new Response(null, { status })

/** 只记录错误类型与机器码；数据库错误消息可能带出参数值 */
function errorSummary(error: unknown) {
  if (error instanceof ConnectorError) return { errorKind: error.kind, errorCode: error.code }
  const code = (error as { code?: unknown } | null)?.code
  return {
    errorName: error instanceof Error ? error.name : 'unknown',
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  }
}

export async function handleEbayChallenge(request: Request, deps: EbayAccountDeletionDeps) {
  const token = deps.secret('EBAY_VERIFICATION_TOKEN')
  if (!isValidEbayVerificationToken(token)) {
    log.warn('ebay.account_deletion.unconfigured', { method: 'GET' })
    return new Response('eBay notifications unavailable', { status: 503 })
  }
  const code = new URL(request.url).searchParams.get('challenge_code')
  if (!code) return new Response('Missing challenge_code', { status: 400 })
  const challengeResponse = await ebayChallengeResponse(
    code,
    token,
    ebayAccountDeletionEndpoint(deps.appUrl),
  )
  // 用 JSON 序列化生成正文（官方提醒手写字符串可能带 BOM 导致校验失败）
  return Response.json({ challengeResponse }, { status: 200 })
}

interface NotificationBody {
  metadata?: { topic?: unknown }
  notification?: {
    notificationId?: unknown
    eventDate?: unknown
    publishAttemptCount?: unknown
    data?: { username?: unknown; userId?: unknown }
  }
}

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null)

export async function handleEbayNotification(request: Request, deps: EbayAccountDeletionDeps) {
  if (!isValidEbayVerificationToken(deps.secret('EBAY_VERIFICATION_TOKEN'))) {
    log.warn('ebay.account_deletion.unconfigured', { method: 'POST' })
    return new Response('eBay notifications unavailable', { status: 503 })
  }
  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES)
    return new Response('Payload too large', { status: 413 })

  // 1. 验签：头缺失、无法解析、kid 不存在或签名不匹配 → 412（官方 SDK 约定）
  const signature = parseEbaySignatureHeader(request.headers.get('x-ebay-signature'))
  if (!signature) {
    log.warn('ebay.account_deletion.signature_rejected', { reason: 'header' })
    return empty(412)
  }
  let publicKey: EbayPublicKey
  try {
    publicKey = await deps.publicKeys.get(signature.kid)
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'EBAY_PUBLIC_KEY_NOT_FOUND') {
      log.warn('ebay.account_deletion.signature_rejected', { reason: 'unknown-key' })
      return empty(412)
    }
    // 凭据缺失 / eBay 不可达：不确认，eBay 会重发
    log.error('ebay.account_deletion.public_key_failed', errorSummary(error))
    return new Response('eBay public key unavailable', { status: 503 })
  }
  if (!(await verifyEbaySignature({ rawBody, signature, publicKey }))) {
    log.warn('ebay.account_deletion.signature_rejected', { reason: 'mismatch' })
    return empty(412)
  }

  let body: NotificationBody
  try {
    body = JSON.parse(rawBody) as NotificationBody
  } catch {
    return new Response('Invalid payload', { status: 400 })
  }
  // 只订阅账号删除主题；其他主题确认即可
  if (body.metadata?.topic !== EBAY_ACCOUNT_DELETION_TOPIC) return empty(204)
  const n = body.notification
  const notificationId = str(n?.notificationId)
  if (!notificationId) return new Response('Missing notificationId', { status: 400 })
  const attempt = typeof n?.publishAttemptCount === 'number' ? n.publishAttemptCount : null

  // 2–3. 去重与事务删除；失败返回 500，由 eBay 重发
  let result: EbayAccountDeletionResult
  try {
    result = await deps.deleteUserData({
      notificationId,
      username: str(n?.data?.username),
      userId: str(n?.data?.userId),
      eventDate: str(n?.eventDate),
      publishAttemptCount: attempt,
    })
  } catch (error) {
    log.error('ebay.account_deletion.failed', {
      notificationId,
      publishAttemptCount: attempt,
      ...errorSummary(error),
    })
    return new Response('Deletion failed', { status: 500 })
  }
  log.info(
    result.status === 'duplicate'
      ? 'ebay.account_deletion.duplicate'
      : 'ebay.account_deletion.processed',
    {
      notificationId,
      userHash: result.userHash,
      publishAttemptCount: attempt,
      counts: result.counts,
    },
  )
  return empty(204)
}
