/**
 * 埋点字典与首触归因（docs/analytics.md）。前后端共用同一事件名与属性；
 * 这里只放纯函数，发送由 web 的 trackEvent 与 jobs 的服务端投递各自负责。
 */

export const ANALYTICS_EVENTS = [
  'page_view',
  'sign_up',
  'upload',
  'generate_start',
  'generate_success',
  'generate_fail',
  'paywall_view',
  'checkout_start',
  'payment_success',
] as const
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number]

/** 注册与付款以服务端为权威：浏览器可被拦截或伪造，类型上就不允许从客户端上报。 */
export const SERVER_ONLY_EVENTS = ['sign_up', 'payment_success'] as const
export type ServerAnalyticsEventName = (typeof SERVER_ONLY_EVENTS)[number]
export type ClientAnalyticsEvent = Exclude<AnalyticsEvent, ServerAnalyticsEventName>

/** 属性无值时的显式缺省，便于在仪表盘中与「没带这个属性」的历史数据区分。 */
export const ANALYTICS_UNSET = '(none)'

export interface AnalyticsProps {
  source: string
  landing_path: string
  locale: string
  plan: string
  device: string
}

export function analyticsProps(
  input: { [K in keyof AnalyticsProps]?: string | null | undefined } = {},
): AnalyticsProps {
  return {
    source: input.source || ANALYTICS_UNSET,
    landing_path: input.landing_path || ANALYTICS_UNSET,
    locale: input.locale || ANALYTICS_UNSET,
    plan: input.plan || ANALYTICS_UNSET,
    device: input.device || ANALYTICS_UNSET,
  }
}

/** Plausible 内置页面事件名为 pageview；其余事件名原样作为自定义目标。 */
export function plausibleEventName(event: AnalyticsEvent): string {
  return event === 'page_view' ? 'pageview' : event
}

export type AnalyticsDevice = 'mobile' | 'tablet' | 'desktop'

export function analyticsDevice(userAgent: string | null | undefined): AnalyticsDevice | undefined {
  if (!userAgent) return undefined
  if (/ipad|tablet|(android(?!.*mobile))/i.test(userAgent)) return 'tablet'
  if (/mobi|iphone|ipod|android/i.test(userAgent)) return 'mobile'
  return 'desktop'
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PATH = 200

/** 空间 slug 与资源 ID 不进入分析系统；保留路由形状，漏斗仍可按页面聚合。 */
export function analyticsPath(pathname: string): string {
  const segments = pathname
    .split('/')
    .map((segment) => (UUID_SEGMENT.test(segment) ? ':id' : segment))
  const app = segments.indexOf('app')
  // 语言前缀最多一段，/app/<slug>/... 的 slug 才是租户标识。
  if ((app === 1 || app === 2) && segments[app + 1]) segments[app + 1] = ':slug'
  return (segments.join('/') || '/').slice(0, MAX_PATH)
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

/** Plausible 从 URL 读取 UTM；其余查询参数可能含令牌或搜索内容，一律不发送。 */
export function analyticsUrl(url: URL): string {
  const kept = new URLSearchParams()
  for (const key of UTM_KEYS) {
    const value = url.searchParams.get(key)
    if (value) kept.set(key, value)
  }
  const query = kept.toString()
  return `${url.origin}${analyticsPath(url.pathname)}${query ? `?${query}` : ''}`
}

export const FIRST_TOUCH_COOKIE = 'product_res_ft'
export const FIRST_TOUCH_MAX_AGE_SECONDS = 180 * 24 * 60 * 60

export interface FirstTouch {
  source: string
  medium: string | null
  campaign: string | null
  term: string | null
  content: string | null
  referrerHost: string | null
  landingPath: string
  device: string | null
  firstSeenAt: string
}

const MAX_VALUE = 120
// Cookie 内容来自浏览器，服务端落库前同样经过这里；只留可显示字符并限长。
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要移除控制字符。
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text ? text.slice(0, MAX_VALUE) : null
}

function refererHost(referrer: string | null | undefined, ownHost: string): string | null {
  if (!referrer || !URL.canParse(referrer)) return null
  const { hostname, protocol } = new URL(referrer)
  if (protocol !== 'https:' && protocol !== 'http:') return null
  return hostname === ownHost ? null : clean(hostname)
}

/**
 * 只取来源主机名，不保存完整 referrer。来源优先取 UTM：ChatGPT 等 GEO 流量常常不带 referrer，
 * 必须靠 utm_source=chatgpt 与落地路径识别（需求 §3.1.4）。
 */
export function captureFirstTouch(input: {
  url: URL
  referrer?: string | null
  userAgent?: string | null
  now?: Date
}): FirstTouch {
  const { searchParams, pathname, hostname } = input.url
  const referrerHost = refererHost(input.referrer, hostname)
  return {
    source: clean(searchParams.get('utm_source'))?.toLowerCase() ?? referrerHost ?? 'direct',
    medium: clean(searchParams.get('utm_medium')),
    campaign: clean(searchParams.get('utm_campaign')),
    term: clean(searchParams.get('utm_term')),
    content: clean(searchParams.get('utm_content')),
    referrerHost,
    landingPath: analyticsPath(pathname),
    device: analyticsDevice(input.userAgent) ?? null,
    firstSeenAt: (input.now ?? new Date()).toISOString(),
  }
}

export function encodeFirstTouch(touch: FirstTouch): string {
  return encodeURIComponent(JSON.stringify(touch))
}

/** 不信任 Cookie：结构不对或路径不是站内路径时视为没有归因，绝不让注册失败。 */
export function parseFirstTouch(encoded: string | null | undefined): FirstTouch | null {
  if (!encoded || encoded.length > 2048) return null
  let value: unknown
  try {
    value = JSON.parse(decodeURIComponent(encoded))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const source = clean(input.source)
  const landingPath = clean(input.landingPath)
  const firstSeenAt = typeof input.firstSeenAt === 'string' ? new Date(input.firstSeenAt) : null
  if (
    !source ||
    !landingPath?.startsWith('/') ||
    !firstSeenAt ||
    !Number.isFinite(firstSeenAt.getTime()) ||
    // 超出四位年份的日期能通过 Date 解析，却会被 Postgres 拒绝。
    !/^\d{4}-/.test(firstSeenAt.toISOString())
  )
    return null
  return {
    source,
    medium: clean(input.medium),
    campaign: clean(input.campaign),
    term: clean(input.term),
    content: clean(input.content),
    referrerHost: clean(input.referrerHost),
    landingPath,
    device: clean(input.device),
    firstSeenAt: firstSeenAt.toISOString(),
  }
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim()
  }
  return null
}

/** 只有身份标识过队列；归因、套餐等在消费者处从数据库读取，消息里不复制业务数据。 */
export type ServerAnalyticsEvent =
  | {
      event: 'sign_up'
      userId: string
      /** Plausible 用 IP + UA 计算匿名访客，带上后服务端事件能与同一访客的页面浏览串联。 */
      clientIp?: string
      userAgent?: string
      /** 注册请求的访问域名（已规范化），多站部署据此选择 site；单站不需要 */
      host?: string
    }
  | { event: 'payment_success'; provider: string; providerPaymentId: string }

export interface ServerAnalyticsMessage {
  v: 1
  analytics: ServerAnalyticsEvent
  requestId?: string
}

export function parseServerAnalyticsMessage(value: unknown): {
  analytics: ServerAnalyticsEvent
  requestId?: string
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.v !== 1 || !message.analytics || typeof message.analytics !== 'object') return null
  const input = message.analytics as Record<string, unknown>
  const requestId =
    typeof message.requestId === 'string' && /^[\w-]{1,64}$/.test(message.requestId)
      ? { requestId: message.requestId }
      : {}
  if (input.event === 'sign_up' && typeof input.userId === 'string' && input.userId) {
    return {
      analytics: {
        event: 'sign_up',
        userId: input.userId,
        ...(typeof input.clientIp === 'string' && input.clientIp
          ? { clientIp: input.clientIp.slice(0, 64) }
          : {}),
        ...(typeof input.userAgent === 'string' && input.userAgent
          ? { userAgent: input.userAgent.slice(0, 512) }
          : {}),
        ...(typeof input.host === 'string' && input.host ? { host: input.host.slice(0, 253) } : {}),
      },
      ...requestId,
    }
  }
  if (
    input.event === 'payment_success' &&
    typeof input.provider === 'string' &&
    input.provider &&
    typeof input.providerPaymentId === 'string' &&
    input.providerPaymentId
  )
    return {
      analytics: {
        event: 'payment_success',
        provider: input.provider,
        providerPaymentId: input.providerPaymentId,
      },
      ...requestId,
    }
  return null
}
