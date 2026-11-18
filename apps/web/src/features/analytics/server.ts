import { normalizeSiteHost } from '@product-res/config'
import type { Database } from '@product-res/db'
import { userAttribution } from '@product-res/db'
import type { QueueProducer } from '@product-res/platform'
import {
  FIRST_TOUCH_COOKIE,
  parseFirstTouch,
  readCookie,
  type ServerAnalyticsEvent,
} from '@product-res/shared/analytics'
import { log, withRequestId } from '@product-res/shared/log'
import { templateConfig } from '../../server/template-config.ts'

type EventsQueue = Pick<QueueProducer<unknown>, 'send'>

/** 业务已提交后才投递；失败只记日志，付款与注册的真相仍在数据库。 */
export async function enqueueServerAnalytics(
  queue: EventsQueue | undefined,
  analytics: ServerAnalyticsEvent,
) {
  if (!queue || templateConfig.features.analytics === false) return
  try {
    await queue.send(withRequestId({ v: 1, analytics }))
  } catch {
    log.warn('analytics.enqueue_failed', { event: analytics.event })
  }
}

/**
 * 注册时的访问域名，多站部署据此把 sign_up / 付款归到对应 site（docs/analytics.md §4）。
 * 按映射同一规则规范化；Host 可被伪造，jobs 只认映射中登记过的域名，这里只拒绝非域名值。
 */
export function signupHost(headers: Headers | undefined): string | undefined {
  const raw = headers?.get('host')
  if (!raw) return undefined
  const host = normalizeSiteHost(raw)
  return host.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) ? host : undefined
}

/** 注册入口统一经 Better Auth 钩子（邮箱、OTP、魔法链接、OAuth 回调都带同站 Cookie）。 */
export function createSignUpRecorder(options: {
  db: Database
  queue: EventsQueue | undefined
  clientIp?: string | null | undefined
}) {
  return async (user: { readonly id: string }, headers?: Headers) => {
    if (templateConfig.features.analytics === false) return
    // 与浏览器端同一隐私边界：设置 GPC / DNT 的访客不进入分析系统。
    if (headers?.get('sec-gpc') === '1' || headers?.get('dnt') === '1') return
    const touch = parseFirstTouch(readCookie(headers?.get('cookie'), FIRST_TOUCH_COOKIE))
    const host = signupHost(headers)
    if (touch) {
      // 归因写失败不能连带丢掉 sign_up 事件，两者分别兜底。
      try {
        await options.db
          .insert(userAttribution)
          .values({
            userId: user.id,
            source: touch.source,
            medium: touch.medium,
            campaign: touch.campaign,
            term: touch.term,
            content: touch.content,
            referrerHost: touch.referrerHost,
            landingPath: touch.landingPath,
            device: touch.device,
            firstSeenAt: new Date(touch.firstSeenAt),
            signupHost: host ?? null,
          })
          .onConflictDoNothing()
      } catch (error) {
        log.warn('analytics.attribution_failed', { error })
      }
    }
    const userAgent = headers?.get('user-agent')
    await enqueueServerAnalytics(options.queue, {
      event: 'sign_up',
      userId: user.id,
      ...(options.clientIp ? { clientIp: options.clientIp } : {}),
      ...(userAgent ? { userAgent } : {}),
      // 没有首触 Cookie 时不写归因行，sign_up 仍带上访问域名。
      ...(host ? { host } : {}),
    })
  }
}
