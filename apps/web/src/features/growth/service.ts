import { normalizeSignupEmail } from '@product-res/billing'
import type { TemplateConfig } from '@product-res/config'
import {
  type Database,
  dbSettingStore,
  getSetting,
  newsletterSubscriber,
  waitlist,
} from '@product-res/db'
import { EMAIL_QUEUE_MESSAGE_VERSION, type EmailQueueMessage } from '@product-res/email/queue'
import { type Capability, type QueueProducer, requireCapability } from '@product-res/platform'
import { AppError, newId } from '@product-res/shared'
import { getLogContext, log } from '@product-res/shared/log'
import { and, eq, inArray } from 'drizzle-orm'
import { userLocaleByEmail } from '../../server/auth-email.ts'
import type { AdminActionScope } from '../admin/action.ts'
import { signGrowthToken, verifyGrowthToken } from './tokens.ts'

export interface GrowthContext {
  db: Database
  config: TemplateConfig
  secret: string
  appUrl: string
  queue: Capability<Pick<QueueProducer<EmailQueueMessage>, 'send'>>
}

export function requireGrowthFeature(config: TemplateConfig, feature: 'waitlist' | 'newsletter') {
  if (!config.features[feature]) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
}

async function base(ctx: GrowthContext, to: string, idempotencyKey: string) {
  const requestId = getLogContext()?.requestId
  return {
    v: EMAIL_QUEUE_MESSAGE_VERSION as typeof EMAIL_QUEUE_MESSAGE_VERSION,
    to,
    locale: (await userLocaleByEmail(ctx.db)(to)) ?? ctx.config.i18n.defaultLocale,
    appName: ctx.config.app.name,
    idempotencyKey,
    ...(requestId ? { requestId } : {}),
  }
}

export async function joinWaitlist(ctx: GrowthContext, email: string) {
  requireGrowthFeature(ctx.config, 'waitlist')
  await ctx.db
    .insert(waitlist)
    .values({ email: normalizeSignupEmail(email) })
    .onConflictDoNothing({ target: waitlist.email })
}

/** 事务内保存邀请与审计；事务提交后再投递邮件，失败可原凭据重发。 */
export async function prepareWaitlistInvitations(scope: AdminActionScope, ids: string[]) {
  const rows = await scope.tx.select().from(waitlist).where(inArray(waitlist.id, ids)).for('update')
  const invitations = []
  for (const row of rows) {
    const reusable = row.invitationExpiresAt && row.invitationExpiresAt > new Date()
    const nonce = reusable ? row.invitationNonce : newId()
    const expiresAt = reusable ? row.invitationExpiresAt : new Date(Date.now() + 7 * 86400_000)
    const [saved] = await scope.tx
      .update(waitlist)
      .set({ invitationNonce: nonce, invitationExpiresAt: expiresAt, invitedAt: new Date() })
      .where(eq(waitlist.id, row.id))
      .returning()
    if (saved) invitations.push(saved)
  }
  await scope.audit({
    action: 'waitlist.invited',
    targetType: 'waitlist',
    meta: { ids: invitations.map((row) => row.id) },
  })
  return invitations
}

export async function sendWaitlistInvitations(
  ctx: GrowthContext,
  rows: Awaited<ReturnType<typeof prepareWaitlistInvitations>>,
) {
  requireGrowthFeature(ctx.config, 'waitlist')
  const queue = requireCapability(ctx.queue, 'Email queue')
  for (const row of rows) {
    if (!row.invitationNonce || !row.invitationExpiresAt) throw new Error('Invitation not prepared')
    const token = await signGrowthToken(ctx.secret, {
      purpose: 'waitlist',
      id: row.id,
      nonce: row.invitationNonce,
      expires: row.invitationExpiresAt.getTime(),
    })
    const url = new URL('/api/waitlist/invitation', ctx.appUrl)
    url.searchParams.set('token', token)
    await queue.send({
      ...(await base(ctx, row.email, `waitlist:${row.id}:${row.invitationNonce}`)),
      template: 'waitlist-invitation',
      props: { url: url.href },
    })
  }
  log.info('waitlist.invitations_queued', { count: rows.length })
}

/** 注入到创建用户前的 hook，覆盖邮箱密码、OTP、魔法链接与 OAuth 的新账号。 */
export async function assertSignupAdmission(
  ctx: Pick<GrowthContext, 'db' | 'config' | 'secret'>,
  email: string,
  headers?: Headers,
) {
  if (await getSetting({ store: dbSettingStore(ctx.db) }, 'auth.signupEnabled')) return
  const token =
    headers?.get('x-waitlist-invitation') ??
    headers
      ?.get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('waitlist-invitation='))
      ?.slice('waitlist-invitation='.length)
  if (ctx.config.features.waitlist && token) {
    const payload = await verifyGrowthToken(ctx.secret, token, 'waitlist')
    if (payload) {
      const [row] = await ctx.db
        .select()
        .from(waitlist)
        .where(
          and(
            eq(waitlist.id, payload.id),
            eq(waitlist.email, normalizeSignupEmail(email)),
            eq(waitlist.invitationNonce, payload.nonce),
          ),
        )
      if (row?.invitationExpiresAt && row.invitationExpiresAt > new Date()) return
    }
  }
  throw new AppError('SIGNUP_DISABLED', 'Registration is closed', { status: 403 })
}

export async function subscribeNewsletter(ctx: GrowthContext, email: string) {
  requireGrowthFeature(ctx.config, 'newsletter')
  // 邮件能力未装配时不创建待确认订阅，也不重置旧订阅凭据。
  const queue = requireCapability(ctx.queue, 'Email queue')
  const row = await ctx.db.transaction(async (tx) => {
    const normalized = normalizeSignupEmail(email)
    await tx
      .insert(newsletterSubscriber)
      .values({ email: normalized })
      .onConflictDoNothing({ target: newsletterSubscriber.email })
    const [found] = await tx
      .select()
      .from(newsletterSubscriber)
      .where(eq(newsletterSubscriber.email, normalized))
      .for('update')
    if (!found) throw new Error('Subscriber missing')
    if (found.status !== 'unsubscribed') return found
    const [updated] = await tx
      .update(newsletterSubscriber)
      .set({ status: 'pending', confirmToken: newId(), confirmedAt: null, unsubscribedAt: null })
      .where(eq(newsletterSubscriber.id, found.id))
      .returning()
    if (!updated) throw new Error('Subscriber missing')
    return updated
  })
  if (row.status === 'confirmed') return
  const token = await signGrowthToken(ctx.secret, {
    purpose: 'confirm',
    id: row.id,
    nonce: row.confirmToken,
    expires: Date.now() + 86400_000,
  })
  const url = new URL('/api/newsletter/confirm', ctx.appUrl)
  url.searchParams.set('token', token)
  await queue.send({
    ...(await base(ctx, row.email, `newsletter-confirm:${row.id}:${row.confirmToken}`)),
    template: 'newsletter-confirmation',
    props: { url: url.href },
  })
}

export async function updateNewsletterStatus(
  ctx: GrowthContext,
  token: string,
  purpose: 'confirm' | 'unsubscribe',
) {
  requireGrowthFeature(ctx.config, 'newsletter')
  const payload = await verifyGrowthToken(ctx.secret, token, purpose)
  if (!payload) throw new AppError('INVALID_TOKEN', 'Invalid or expired link', { status: 400 })
  const conditions = and(
    eq(newsletterSubscriber.id, payload.id),
    eq(newsletterSubscriber.confirmToken, payload.nonce),
    ...(purpose === 'confirm'
      ? [inArray(newsletterSubscriber.status, ['pending', 'confirmed'])]
      : []),
  )
  const [row] = await ctx.db
    .update(newsletterSubscriber)
    .set(
      purpose === 'confirm'
        ? { status: 'confirmed', confirmedAt: new Date() }
        : { status: 'unsubscribed', unsubscribedAt: new Date() },
    )
    .where(conditions)
    .returning({ id: newsletterSubscriber.id })
  if (!row) throw new AppError('INVALID_TOKEN', 'Invalid or expired link', { status: 400 })
}

/** 群发导出只允许已确认邮箱；首版群发由运营方管理，不在此实现编辑器或排期。 */
export async function newsletterSendingList(ctx: GrowthContext) {
  requireGrowthFeature(ctx.config, 'newsletter')
  return ctx.db
    .select({ id: newsletterSubscriber.id, email: newsletterSubscriber.email })
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.status, 'confirmed'))
}

export async function newsletterUnsubscribeUrl(ctx: GrowthContext, id: string) {
  requireGrowthFeature(ctx.config, 'newsletter')
  const [row] = await ctx.db
    .select()
    .from(newsletterSubscriber)
    .where(and(eq(newsletterSubscriber.id, id), eq(newsletterSubscriber.status, 'confirmed')))
  if (!row) throw new AppError('NOT_FOUND', 'Subscriber unavailable', { status: 404 })
  const token = await signGrowthToken(ctx.secret, {
    purpose: 'unsubscribe',
    id,
    nonce: row.confirmToken,
    expires: null,
  })
  const url = new URL('/api/newsletter/unsubscribe', ctx.appUrl)
  url.searchParams.set('token', token)
  return url.href
}
