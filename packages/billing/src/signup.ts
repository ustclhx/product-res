import type { TemplateConfig } from '@product-res/config'
import { CreditsError, grant, lockWorkspaceCredits } from '@product-res/credits'
import { creditGrant, type Database, member, organization, setting, user } from '@product-res/db'
import {
  AppError,
  isSignupEmailBlacklisted,
  normalizeSignupEmail,
  parseSignupBonusDomainBlacklist,
  SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY,
} from '@product-res/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'

export { SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY }

export type SignupBonusResult =
  | { status: 'granted'; credits: number }
  | { status: 'already_claimed' | 'unverified' | 'blacklisted' | 'disabled' }

// 增长名单与删号清理共用同一规范化规则，实现放在 shared，避免 auth 反向依赖 billing。
export { normalizeSignupEmail }

/** No session/cookie email or verified flag is accepted. The database owns eligibility. */
export async function grantSignupBonus(input: {
  db: Database
  userId: string
  config: Pick<TemplateConfig['billing'], 'signupBonusCredits'>
}): Promise<SignupBonusResult> {
  const { db, userId, config } = input
  if (config.signupBonusCredits <= 0) return { status: 'disabled' }
  return db.transaction(async (tx): Promise<SignupBonusResult> => {
    // Same owner lock/order as account deletion: eligibility cannot race deletion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${userId}`}, 0))`)
    const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('share')
    if (!account) throw new AppError('USER_NOT_FOUND', 'Account unavailable', { status: 404 })
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
    if (account.banned)
      throw new AppError('ACCOUNT_UNAVAILABLE', 'Account unavailable', { status: 403 })
    if (!account.emailVerified) return { status: 'unverified' }
    const normalized = normalizeSignupEmail(account.email)
    const [persisted] = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY))
    const domains = persisted ? parseSignupBonusDomainBlacklist(persisted.value) : []
    if (isSignupEmailBlacklisted(account.email, domains)) return { status: 'blacklisted' }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
    const sourceRef = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    await lockWorkspaceCredits(tx, personal.id)
    const [claimed] = await tx
      .select({ id: creditGrant.id })
      .from(creditGrant)
      .where(and(eq(creditGrant.source, 'signup'), eq(creditGrant.sourceRef, sourceRef)))
    if (claimed) return { status: 'already_claimed' }
    try {
      await grant(
        db,
        {
          workspaceId: personal.id,
          source: 'signup',
          sourceRef,
          amount: config.signupBonusCredits,
          paymentId: null,
          expiresAt: null,
        },
        tx,
      )
    } catch (error) {
      // The global key may have been concurrently claimed by another workspace.
      if (error instanceof CreditsError && error.code === 'SOURCE_ALREADY_GRANTED') {
        return { status: 'already_claimed' }
      }
      throw error
    }
    return { status: 'granted', credits: config.signupBonusCredits }
  })
}
