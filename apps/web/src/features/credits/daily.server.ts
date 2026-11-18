import { type DailyCreditsResult, grantDailyCredits } from '@product-res/credits'
import type { Database } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'

export type DailyCreditsCheck = DailyCreditsResult | { status: 'cached' | 'ineligible' }

/** KV 只避免近期重复检查，领取资格与额度始终由积分事务决定。 */
export async function checkDailyCredits({
  db,
  cache,
  user,
  session,
  enabled,
  now = new Date(),
}: {
  db: Database
  cache: KeyValueStore
  user: { id: string; emailVerified: boolean }
  session: { impersonatedBy?: string | null }
  enabled: boolean
  now?: Date
}): Promise<DailyCreditsCheck | null> {
  if (!enabled || session.impersonatedBy) return { status: 'disabled' }
  const key = `daily-credits:${user.id}:${now.toISOString().slice(0, 10)}:${user.emailVerified}`
  try {
    const cached = await cache.get(key)
    if (cached === 'unverified') return { status: 'unverified' }
    if (cached === 'checked') return { status: 'cached' }
  } catch {
    log.warn('credits.daily.cache_read_failed', { userId: user.id })
  }

  let result: DailyCreditsResult | { status: 'ineligible' }
  try {
    result = await grantDailyCredits({ db, userId: user.id, enabled: true, now })
  } catch (error) {
    // 业务拒绝短期缓存；未知故障留给下次真实访问重试，均不阻断 App。
    if (error instanceof AppError) {
      log.warn('credits.daily.ineligible', { userId: user.id, code: error.code })
      result = { status: 'ineligible' }
    } else {
      log.warn('credits.daily.check_failed', { userId: user.id })
      return null
    }
  }
  const checkedForDay =
    result.status === 'granted' ||
    result.status === 'already_claimed' ||
    result.status === 'monthly_limit'
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  try {
    await cache.put(key, result.status === 'unverified' ? 'unverified' : 'checked', {
      expirationTtl: checkedForDay
        ? Math.max(60, Math.ceil((nextDay - now.getTime()) / 1000))
        : 300,
    })
  } catch {
    log.warn('credits.daily.cache_write_failed', { userId: user.id })
  }
  return result
}
