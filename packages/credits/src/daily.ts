import {
  creditDailyClaim,
  type DailyCreditSettingKey,
  type Database,
  isValidDailyCreditSetting,
  member,
  organization,
  type SettingValues,
  setting,
  settingDefaults,
  user,
} from '@product-res/db'
import {
  AppError,
  isSignupEmailBlacklisted,
  normalizeSignupEmail,
  parseSignupBonusDomainBlacklist,
  SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY,
} from '@product-res/shared'
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { grant } from './index.ts'

export type DailyCreditsResult =
  | {
      status: 'granted'
      grantId: string
      credits: number
      daysThisMonth: number
      maxDaysPerMonth: number
      expiresAt: string
      day: string
    }
  | { status: 'disabled' | 'already_claimed' | 'monthly_limit' | 'blacklisted' | 'unverified' }

const dailyKeys = [
  'credits.dailyAmount',
  'credits.dailyMaxDaysPerMonth',
  'credits.dailyExpiryDays',
  'credits.dailyRequireVerifiedEmail',
] as const

/** 数据库负责身份及额度；调用方只传开关，不接受会话中的邮箱或验证状态。 */
export async function grantDailyCredits(input: {
  db: Database
  userId: string
  enabled: boolean
  now?: Date
}): Promise<DailyCreditsResult> {
  if (!input.enabled) return { status: 'disabled' }
  const { db, userId } = input
  const now = input.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid daily credits time')
  const day = now.toISOString().slice(0, 10)
  const monthStart = `${day.slice(0, 7)}-01`
  const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10)
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10)
  return db.transaction(async (tx): Promise<DailyCreditsResult> => {
    // 与删号一致的锁顺序：owner → daily-email → credits。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${userId}`}, 0))`)
    const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('share')
    if (!account) throw new AppError('USER_NOT_FOUND', 'Account unavailable', { status: 404 })
    if (account.banned)
      throw new AppError('ACCOUNT_UNAVAILABLE', 'Account unavailable', { status: 403 })
    const [personal] = await tx
      .select({ id: organization.id })
      .from(organization)
      .innerJoin(member, eq(member.organizationId, organization.id))
      .where(
        and(
          eq(organization.id, userId),
          eq(organization.isPersonal, true),
          isNull(organization.deletedAt),
          eq(member.userId, userId),
          eq(member.role, 'owner'),
        ),
      )
    if (!personal)
      throw new AppError('PERSONAL_WORKSPACE_REQUIRED', 'Personal workspace unavailable', {
        status: 403,
      })
    const persisted = await tx
      // 避免 jsonb 列解码器把驱动已解码的 JSON 字符串再次解析成布尔/数值。
      .select({ key: setting.key, value: sql<unknown>`${setting.value}` })
      .from(setting)
      .where(inArray(setting.key, [...dailyKeys, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY]))
    const values = new Map(persisted.map((row) => [row.key, row.value]))
    const read = <K extends DailyCreditSettingKey>(key: K): SettingValues[K] => {
      const value = values.has(key) ? values.get(key) : settingDefaults[key]
      if (!isValidDailyCreditSetting(key, value)) throw new Error('Invalid daily credits setting')
      return value
    }
    const amount = read('credits.dailyAmount')
    const maxDays = read('credits.dailyMaxDaysPerMonth')
    const expiryDays = read('credits.dailyExpiryDays')
    const requireVerified = read('credits.dailyRequireVerifiedEmail')
    if (requireVerified && !account.emailVerified) return { status: 'unverified' }
    const domains = parseSignupBonusDomainBlacklist(
      values.has(SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY)
        ? values.get(SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY)
        : [],
    )
    if (isSignupEmailBlacklisted(account.email, domains)) return { status: 'blacklisted' }
    const normalized = normalizeSignupEmail(account.email)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
    const emailHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    // 同一邮箱跨账号、跨日期请求也串行，月末最后一次额度不会被并发穿透。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`daily-email:${emailHash}`}, 0))`,
    )
    const [claimed] = await tx
      .select({ id: creditDailyClaim.id })
      .from(creditDailyClaim)
      .where(
        and(
          eq(creditDailyClaim.day, day),
          or(eq(creditDailyClaim.userId, userId), eq(creditDailyClaim.emailHash, emailHash)),
        ),
      )
      .limit(1)
    if (claimed) return { status: 'already_claimed' }
    const [monthly] = await tx
      .select({ days: sql<number>`count(distinct ${creditDailyClaim.day})::int` })
      .from(creditDailyClaim)
      .where(
        and(
          or(eq(creditDailyClaim.userId, userId), eq(creditDailyClaim.emailHash, emailHash)),
          gte(creditDailyClaim.day, monthStart),
          lt(creditDailyClaim.day, monthEnd),
        ),
      )
    const days = monthly?.days ?? 0
    if (days >= maxDays) return { status: 'monthly_limit' }
    const expiresAt = new Date(now.getTime() + expiryDays * 86_400_000)
    const batch = await grant(
      db,
      {
        workspaceId: personal.id,
        source: 'daily',
        sourceRef: `${userId}:${day}`,
        amount,
        paymentId: null,
        expiresAt,
      },
      tx,
    )
    await tx.insert(creditDailyClaim).values({ userId, emailHash, day, grantId: batch.id })
    // 随成功领取惰性清理，只保留本月和上月的邮箱防刷记录。
    await tx
      .delete(creditDailyClaim)
      .where(
        and(
          eq(creditDailyClaim.emailHash, emailHash),
          lt(creditDailyClaim.day, previousMonthStart),
        ),
      )
    return {
      status: 'granted',
      grantId: batch.id,
      credits: amount,
      daysThisMonth: days + 1,
      maxDaysPerMonth: maxDays,
      expiresAt: expiresAt.toISOString(),
      day,
    }
  })
}
