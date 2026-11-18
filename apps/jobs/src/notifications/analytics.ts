// biome-ignore-all lint/plugin: 跨空间的付款与归因读取没有单一租户归属。
import { normalizeSiteHost, type PlausibleSite } from '@product-res/config'
import {
  analyticsDelivery,
  type Database,
  member,
  payment,
  plan,
  planPrice,
  user,
  userAttribution,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import {
  type AnalyticsEvent,
  analyticsProps,
  plausibleEventName,
  type ServerAnalyticsEvent,
} from '@product-res/shared/analytics'
import { log } from '@product-res/shared/log'
import { and, asc, eq } from 'drizzle-orm'

/**
 * site 携带映射（sites）与兜底（domain）：单站时没有映射，一律发往兜底 site。
 * appUrl 是兜底事件 URL 的站点地址，必须是本环境的 APP_URL，不能指向他站。
 */
export interface ServerAnalyticsTarget {
  site: PlausibleSite
  appUrl: string
}

interface ResolvedEvent {
  name: AnalyticsEvent
  sourceId: string
  path: string
  props: ReturnType<typeof analyticsProps>
  revenue?: { currency: string; amount: string }
  clientIp?: string
  userAgent?: string
  /** 注册时的访问域名：sign_up 取消息，付款取所有者归因行 */
  host?: string | null
}

/**
 * 多站按注册域名选择 site 与事件 URL；只认映射中登记过的域名（Host 可伪造），
 * 未登记或缺失时退回兜底 site 与 APP_URL，兜底也没有时返回 null，不发送也不占位。
 */
function destination(target: ServerAnalyticsTarget, host: string | null | undefined) {
  const key = host ? normalizeSiteHost(host) : ''
  const mapped = key && target.site.sites ? target.site.sites[key] : undefined
  if (mapped) return { domain: mapped, baseUrl: `https://${key}` }
  return target.site.domain ? { domain: target.site.domain, baseUrl: target.appUrl } : null
}

async function attributionOf(db: Database, userId: string) {
  const [row] = await db
    .select({
      source: userAttribution.source,
      landingPath: userAttribution.landingPath,
      device: userAttribution.device,
      signupHost: userAttribution.signupHost,
      locale: user.locale,
    })
    .from(user)
    .leftJoin(userAttribution, eq(userAttribution.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1)
  return row
}

async function resolve(db: Database, event: ServerAnalyticsEvent): Promise<ResolvedEvent | null> {
  if (event.event === 'sign_up') {
    const row = await attributionOf(db, event.userId)
    if (!row) return null
    return {
      name: 'sign_up',
      sourceId: event.userId,
      path: '/register',
      props: analyticsProps({
        source: row.source ?? undefined,
        landing_path: row.landingPath ?? undefined,
        locale: row.locale ?? undefined,
        device: row.device ?? undefined,
      }),
      ...(event.clientIp ? { clientIp: event.clientIp } : {}),
      ...(event.userAgent ? { userAgent: event.userAgent } : {}),
      host: event.host ?? null,
    }
  }
  const [paid] = await db
    .select({
      workspaceId: payment.workspaceId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      plan: plan.key,
    })
    .from(payment)
    .leftJoin(planPrice, eq(planPrice.id, payment.planPriceId))
    .leftJoin(plan, eq(plan.id, planPrice.planId))
    .where(
      and(
        eq(payment.provider, event.provider as typeof payment.$inferSelect.provider),
        eq(payment.providerPaymentId, event.providerPaymentId),
      ),
    )
    .limit(1)
  // 事务已提交后才入队；查不到或已退款都不算一次成功付款。
  if (paid?.status !== 'succeeded') return null
  // 空间付款归因到所有者：个人空间即付款人本人，团队空间由所有者代表。
  const [owner] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, paid.workspaceId), eq(member.role, 'owner')))
    .orderBy(asc(member.createdAt))
    .limit(1)
  const row = owner ? await attributionOf(db, owner.userId) : undefined
  return {
    name: 'payment_success',
    sourceId: `${event.provider}:${event.providerPaymentId}`,
    path: '/app/billing',
    props: analyticsProps({
      source: row?.source ?? undefined,
      landing_path: row?.landingPath ?? undefined,
      locale: row?.locale ?? undefined,
      plan: paid.plan ?? undefined,
      device: row?.device ?? undefined,
    }),
    revenue: { currency: paid.currency, amount: (paid.amount / 100).toFixed(2) },
    host: row?.signupHost ?? null,
  }
}

/** 发送失败抛出由队列重试；响应头标记被丢弃时只告警，重试同样会被丢弃。 */
async function send(
  target: ServerAnalyticsTarget,
  to: { domain: string; baseUrl: string },
  event: ResolvedEvent,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target.site.eventUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // Plausible 丢弃无 UA 或爬虫 UA 的事件；Webhook 没有用户 UA，用固定的非爬虫标识。
        'user-agent': event.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) SaasServerEvents/1.0',
        ...(event.clientIp ? { 'x-forwarded-for': event.clientIp } : {}),
      },
      body: JSON.stringify({
        name: plausibleEventName(event.name),
        domain: to.domain,
        url: new URL(event.path, to.baseUrl).href,
        props: event.props,
        ...(event.revenue ? { revenue: event.revenue } : {}),
      }),
    })
    if (!response.ok) throw new Error('HTTP failure')
    if (response.headers.get('x-plausible-dropped'))
      log.warn('analytics.event_dropped', { event: event.name })
  } catch {
    // 不透传异常文本，只暴露事件名。
    throw new AppError('ANALYTICS_DELIVERY_FAILED', 'Analytics delivery failed', { status: 503 })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 同一笔付款可能经多个 Webhook 事件并发到达。先用主键占位再发送，失败时释放以便重试；
 * 占位后进程崩溃会少计一次（宁缺勿重，收入不能翻倍），付款真相仍在数据库。
 */
export async function deliverServerAnalytics(
  db: Database,
  target: ServerAnalyticsTarget | null | undefined,
  event: ServerAnalyticsEvent,
  timeoutMs = 5000,
) {
  if (!target) return
  const resolved = await resolve(db, event)
  if (!resolved) return
  const to = destination(target, resolved.host)
  if (!to) return
  const eventKey = `${resolved.name}:${resolved.sourceId}`
  const claimed = await db
    .insert(analyticsDelivery)
    .values({ eventKey })
    .onConflictDoNothing()
    .returning({ eventKey: analyticsDelivery.eventKey })
  if (!claimed.length) return
  try {
    await send(target, to, resolved, timeoutMs)
  } catch (error) {
    await db.delete(analyticsDelivery).where(eq(analyticsDelivery.eventKey, eventKey))
    throw error
  }
  log.info('analytics.delivered', { event: resolved.name })
}
