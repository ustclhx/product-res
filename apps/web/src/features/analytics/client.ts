import type { TemplateConfig } from '@product-res/config'

export const ANALYTICS_CONSENT_KEY = 'saas.analytics.consent'
export const ANALYTICS_CONSENT_EVENT = 'saas:analytics-consent'

/** 供站点自己的同意 UI 调用；本接入点不默认展示弹窗。 */
export function grantAnalyticsConsent() {
  localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted')
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT))
}

export function revokeAnalyticsConsent() {
  localStorage.removeItem(ANALYTICS_CONSENT_KEY)
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT))
}

interface PostHog {
  init(key: string, options: Record<string, unknown>): void
  capture(event: string, properties: Record<string, unknown>): void
  opt_in_capturing(options: { captureEventName: false }): void
  opt_out_capturing(): void
}

type PostHogWindow = Window & { posthog?: PostHog }
let initializedSdk: PostHog | undefined

function mayCapture(config: TemplateConfig): boolean {
  const pathname = window.location.pathname
  if (
    config.features.analytics !== 'posthog' ||
    !config.analytics.posthogKey.trim() ||
    !config.analytics.posthogHost.trim()
  )
    return false
  if (['/admin', '/api'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)))
    return false
  const dnt = navigator.doNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack
  if (dnt === '1' || dnt === 'yes') return false
  try {
    return localStorage.getItem(ANALYTICS_CONSENT_KEY) === 'granted'
  } catch {
    // 浏览器禁用存储时无法确认同意状态，保持关闭。
    return false
  }
}

/** 路由切换时重新挂载；关闭自动采集，避免从应用区跳到后台后继续发送事件。 */
export function startPostHog(config: TemplateConfig): () => void {
  let active = true
  let script: HTMLScriptElement | undefined
  const sdk = () => (window as PostHogWindow).posthog
  const capture = () => {
    if (!active || !mayCapture(config)) {
      sdk()?.opt_out_capturing()
      return
    }
    const posthog = sdk()
    if (!posthog) return
    if (posthog !== initializedSdk) {
      initializedSdk = posthog
      posthog.init(config.analytics.posthogKey, {
        api_host: config.analytics.posthogHost,
        respect_dnt: true,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        disable_surveys: true,
        advanced_disable_feature_flags: true,
        person_profiles: 'identified_only',
        // 异步加载、发送队列与 SPA 导航之间仍需重新检查同意状态和当前路径。
        before_send: (event: unknown) => (mayCapture(config) ? event : null),
      })
    }
    posthog.opt_in_capturing({ captureEventName: false })
    posthog.capture('$pageview', {
      $current_url: window.location.origin + window.location.pathname,
    })
  }
  const update = () => {
    if (!mayCapture(config) || sdk()) return capture()
    if (script) return
    let host: URL
    try {
      host = new URL(config.analytics.posthogHost)
    } catch {
      return
    }
    if (host.protocol !== 'https:' && host.protocol !== 'http:') return
    script = document.createElement('script')
    script.async = true
    // PostHog Cloud 的 SDK 使用独立 assets 域名，自托管仍使用配置的 host。
    script.src = `${host.href.replace(/\/$/, '').replace('.i.posthog.com', '-assets.i.posthog.com')}/static/array.js`
    script.onload = capture
    script.onerror = () => {
      script?.remove()
      script = undefined
    }
    document.head.appendChild(script)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === ANALYTICS_CONSENT_KEY || event.key === null) update()
  }
  window.addEventListener(ANALYTICS_CONSENT_EVENT, update)
  window.addEventListener('storage', onStorage)
  update()
  return () => {
    active = false
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, update)
    window.removeEventListener('storage', onStorage)
    if (script) {
      script.onload = null
      script.remove()
    }
    sdk()?.opt_out_capturing()
  }
}
