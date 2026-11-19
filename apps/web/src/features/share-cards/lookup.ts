import type { Database } from '@product-res/db'
import type { KeyValueStore, RateLimiter } from '@product-res/platform'
import { shareCardRevokedKey } from '@product-res/storage'
import { isShareCardExpired, shareCardExpiresAt } from './expiry.ts'
import { getShareCard } from './registry.ts'
import type { RegisteredShareCard, ShareResolution } from './types.ts'

export interface ShareLookupDeps {
  readonly db: Database
  readonly cache: Pick<KeyValueStore, 'get'>
  readonly rateLimiter: RateLimiter
  /** 目标入口给出的可信来源 IP；缺失时共用一个限流桶。 */
  readonly clientIp: string | null
  readonly now?: Date
}

export type ShareLookup =
  | {
      readonly status: 'ok'
      readonly card: RegisteredShareCard<unknown>
      readonly token: string
      readonly resolution: ShareResolution<unknown>
      readonly expiresAt: Date | null
    }
  | { readonly status: 'not-found' | 'expired' | 'rate-limited' }

/** 令牌长度上限：KV 键不超过 512 字节，项目自定义的令牌格式也不得越过它。 */
export const MAX_SHARE_TOKEN_LENGTH = 256

/** 查找第一段：只读内存与 KV，不消耗限流配额、不调用 resolve。 */
export type SharePrecheck =
  | { readonly status: 'ok'; readonly card: RegisteredShareCard<unknown>; readonly token: string }
  | { readonly status: 'not-found' }

/**
 * 注册表与 `sharePage` 开关（内存）→ 令牌长度上限与格式 → KV 撤销标记。卡片图片路由在这一段之后
 * 先查 Cache API 与 R2，未命中才进入 {@link resolveShare}；分享页与元数据直接接续两段。
 */
export async function precheckShare(
  deps: Pick<ShareLookupDeps, 'cache'>,
  input: { type: string; token: string; page: boolean },
): Promise<SharePrecheck> {
  const card = getShareCard(input.type)
  if (!card || (input.page && !card.sharePage)) return { status: 'not-found' }
  if (input.token.length > MAX_SHARE_TOKEN_LENGTH) return { status: 'not-found' }
  // 项目自定义的正则可能带 g / y 标志，复位后再匹配，避免 lastIndex 残留导致结果交替。
  card.tokenPattern.lastIndex = 0
  if (!card.tokenPattern.test(input.token)) return { status: 'not-found' }
  if (await isShareRevoked(deps, input.type, input.token)) return { status: 'not-found' }
  return { status: 'ok', card, token: input.token }
}

/** KV 撤销标记；键无法构造（自定义格式放行了路径分隔或控制字符）时同样视为不可用。 */
export async function isShareRevoked(
  deps: Pick<ShareLookupDeps, 'cache'>,
  type: string,
  token: string,
): Promise<boolean> {
  let revokedKey: string
  try {
    revokedKey = shareCardRevokedKey(type, token)
  } catch {
    return true
  }
  return (await deps.cache.get(revokedKey)) !== null
}

/** 查找第二段：限流 → resolve → 到期。剩余有效期不足 1 秒视为到期，避免以 0 秒缓存返回。 */
export async function resolveShare(
  deps: ShareLookupDeps,
  checked: Extract<SharePrecheck, { status: 'ok' }>,
): Promise<ShareLookup> {
  const { card, token } = checked
  const limited = await deps.rateLimiter.limit(
    'shareCard',
    `share:ip:${deps.clientIp ?? 'unknown'}`,
  )
  if (!limited.success) return { status: 'rate-limited' }
  const resolution = await card.resolve(token, { db: deps.db })
  if (!resolution) return { status: 'not-found' }
  const expiresAt = shareCardExpiresAt(resolution, card.ttlDays)
  const now = deps.now ?? new Date()
  if (isShareCardExpired(expiresAt, now) || remainingSeconds(expiresAt, now) < 1)
    return { status: 'expired' }
  return { status: 'ok', card, token, resolution, expiresAt }
}

/**
 * 分享页与元数据共用的查找顺序（design 第 3、8、9 条）：注册表与 `sharePage` 开关（内存）
 * → 令牌格式 → KV 撤销标记 → 限流 → resolve → 到期。格式不符的请求不读 KV、不消耗限流配额，
 * 撤销的请求不调用 resolve。
 * `page` 为 true 时同时遵守类型的 `sharePage: false`；项目自建页面取元数据时不受该开关影响。
 */
export async function lookupShare(
  deps: ShareLookupDeps,
  input: { type: string; token: string; page: boolean },
): Promise<ShareLookup> {
  const checked = await precheckShare(deps, input)
  return checked.status === 'ok' ? resolveShare(deps, checked) : checked
}

/** 距到期的整秒数；永不过期时为无穷大。 */
export function remainingSeconds(expiresAt: Date | null, now = new Date()): number {
  return expiresAt === null
    ? Number.POSITIVE_INFINITY
    : Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
}
