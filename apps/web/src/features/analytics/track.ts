import { resolvePlausibleSite } from '@product-res/config'
import {
  analyticsDevice,
  analyticsProps,
  analyticsUrl,
  type ClientAnalyticsEvent,
  captureFirstTouch,
  encodeFirstTouch,
  FIRST_TOUCH_COOKIE,
  FIRST_TOUCH_MAX_AGE_SECONDS,
  parseFirstTouch,
  plausibleEventName,
  readCookie,
} from '@product-res/shared/analytics'
import { getLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from '../i18n/app-area.ts'
import { mayCapture } from './client.ts'
import { type MultiSiteConfig, PLAUSIBLE_CONFIG_ID } from './head.ts'

interface PlausibleQueue {
  (event: string, options: { u: string; props: Record<string, string> }): void
  q?: unknown[]
}
type AnalyticsWindow = Window & {
  plausible?: PlausibleQueue
  posthog?: { capture(event: string, properties: Record<string, unknown>): void }
}

const MAX_QUEUED = 100
const NOT_TRACKED = /^\/(?:admin|api)(?:\/|$)/

/** 无 Cookie 统计也尊重 DNT / GPC；后台与接口路径从不上报。 */
function trackingAllowed(): boolean {
  if (typeof window === 'undefined' || NOT_TRACKED.test(window.location.pathname)) return false
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
  const dnt = nav.doNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack
  return !(dnt === '1' || dnt === 'yes' || nav.globalPrivacyControl === true)
}

function providerAllowed(): boolean {
  const { analytics } = templateConfig.features
  if (analytics === false) return false
  return analytics === 'posthog' ? mayCapture(templateConfig) : true
}

function firstTouchCookie() {
  return readCookie(document.cookie, FIRST_TOUCH_COOKIE)
}

/** 只写一次：已有 Cookie 时不覆盖，后续来访不会改变首触来源。 */
export function ensureFirstTouch() {
  if (!trackingAllowed() || !providerAllowed() || firstTouchCookie()) return
  const touch = captureFirstTouch({
    url: new URL(window.location.href),
    referrer: document.referrer,
    userAgent: navigator.userAgent,
  })
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  // biome-ignore lint/suspicious/noDocumentCookie: 首触需在注册请求中随 Cookie 到达服务端，且公开页可能是静态预渲染。
  document.cookie = `${FIRST_TOUCH_COOKIE}=${encodeFirstTouch(touch)}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
}

const CLARITY_SCRIPT_ID = 'product-res-clarity'
const PLAUSIBLE_SCRIPT_ID = 'product-res-plausible-script'

/** 读取多站内联配置；单站页面没有该元素，内容异常时同样按单站处理（不会自行插入脚本）。 */
function multiSiteConfig(): MultiSiteConfig | null {
  const text = document.getElementById(PLAUSIBLE_CONFIG_ID)?.textContent
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<MultiSiteConfig>
    if (
      !value.sites ||
      typeof value.sites !== 'object' ||
      typeof value.fallback !== 'string' ||
      typeof value.scriptUrl !== 'string'
    )
      return null
    return value as MultiSiteConfig
  } catch {
    return null
  }
}

/**
 * manual 脚本只在加载时读取 data-domain，按次调用改不了 site：多站时按当前访问域名选出 site，
 * 再插入一次脚本；在此之前的事件留在 window.plausible.q，脚本加载后按序补发。
 */
function loadPlausible(scriptUrl: string, domain: string) {
  if (document.getElementById(PLAUSIBLE_SCRIPT_ID)) return
  const script = document.createElement('script')
  script.id = PLAUSIBLE_SCRIPT_ID
  script.defer = true
  script.src = scriptUrl
  script.setAttribute('data-domain', domain)
  document.head.appendChild(script)
}

/**
 * 可选热力图：默认关闭，只看公开页面，且不进入任何事件字典（不作为转化真相源）。
 * 由客户端注入才能判断 DNT / GPC。脚本加载后会持续录制，站内导航进入应用区时整页刷新卸载它，
 * 这一步只影响主动开启 Clarity 的站点。
 */
export function startClarity(pathname: string) {
  const id = templateConfig.analytics.clarityProjectId.trim()
  if (!id || !/^[a-z0-9]+$/i.test(id)) return
  const loaded = Boolean(document.getElementById(CLARITY_SCRIPT_ID))
  if (isAppAreaPath(pathname)) {
    if (loaded) window.location.reload()
    return
  }
  if (loaded || !trackingAllowed()) return
  const script = document.createElement('script')
  script.id = CLARITY_SCRIPT_ID
  script.async = true
  script.src = `https://www.clarity.ms/tag/${id}`
  document.head.appendChild(script)
}

/**
 * 统一埋点入口。注册与付款事件由服务端上报，类型上不接受；
 * 脚本未注入（未配置或本环境关闭）时静默跳过。
 */
export function trackEvent(event: ClientAnalyticsEvent, input: { plan?: string } = {}) {
  if (!trackingAllowed() || !providerAllowed()) return
  const touch = parseFirstTouch(firstTouchCookie())
  const props = analyticsProps({
    source: touch?.source,
    landing_path: touch?.landingPath,
    locale: getLocale(),
    plan: input.plan,
    device: analyticsDevice(navigator.userAgent),
  })
  const target = window as AnalyticsWindow
  if (templateConfig.features.analytics === 'posthog') {
    // 页面浏览由 startPostHog 负责，避免重复计数。
    if (event !== 'page_view') target.posthog?.capture(event, { ...props })
    return
  }
  const multi = multiSiteConfig()
  if (multi) {
    const domain = resolvePlausibleSite(multi.sites, multi.fallback, window.location.hostname)
    if (!domain) {
      // 未登记且无兜底的访问域名（如 workers.dev 预览）不统计：不插入脚本，清空队列也不再排队。
      if (target.plausible?.q) target.plausible.q.length = 0
      return
    }
    loadPlausible(multi.scriptUrl, domain)
  }
  // 不能以 DOM 中的脚本标签判断是否启用：hydration 与导航时 head 会重新插入标签，
  // 此时页面 effect 已先执行。一律先进队列，脚本加载后按序回放；未配置的站点队列无人消费，限长丢弃。
  const plausible: PlausibleQueue =
    target.plausible ??
    Object.assign(
      (...args: unknown[]) => {
        plausible.q = plausible.q ?? []
        if (plausible.q.length < MAX_QUEUED) plausible.q.push(args)
      },
      { q: [] as unknown[] },
    )
  target.plausible = plausible
  plausible(plausibleEventName(event), {
    u: analyticsUrl(new URL(window.location.href)),
    props: { ...props },
  })
}
