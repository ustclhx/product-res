import { templateConfig } from '../../server/template-config.ts'
import type { ShareResolution } from './types.ts'

/** 使用 UTC 毫秒计算完整天数，避免夏令时改变实际有效时长。 */
export function shareCardExpiresAt(
  resolution: Pick<ShareResolution<unknown>, 'sharedAt' | 'expiresAt'>,
  ttlDays: number | null = templateConfig.shareCards.defaultTtlDays,
): Date | null {
  if (resolution.expiresAt !== undefined) return resolution.expiresAt
  return ttlDays === null ? null : new Date(resolution.sharedAt.getTime() + ttlDays * 86_400_000)
}

export function isShareCardExpired(expiresAt: Date | null, now = new Date()): boolean {
  // 非法日期的 NaN 比较同样视为到期，不能意外变为永久有效。
  return expiresAt !== null && !(expiresAt.getTime() > now.getTime())
}
