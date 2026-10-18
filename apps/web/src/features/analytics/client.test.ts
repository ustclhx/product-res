import { defineTemplateConfig } from '@product-res/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_CONSENT_KEY,
  grantAnalyticsConsent,
  revokeAnalyticsConsent,
  startPostHog,
} from './client.ts'

const config = defineTemplateConfig({
  app: { name: 'Test', url: 'https://product.ezarouter.cc', supportEmail: 'test@example.com' },
  features: { analytics: 'posthog' },
  analytics: { posthogKey: 'public-key', posthogHost: 'https://eu.i.posthog.com' },
})
let posthog: {
  init: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
  opt_in_capturing: ReturnType<typeof vi.fn>
  opt_out_capturing: ReturnType<typeof vi.fn>
}
let browser: EventTarget & {
  location: { pathname: string; origin: string }
  posthog?: typeof posthog
}
let scripts: HTMLScriptElement[]
let stop: (() => void) | undefined

beforeEach(() => {
  posthog = {
    init: vi.fn(),
    capture: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  }
  scripts = []
  browser = Object.assign(new EventTarget(), {
    location: { pathname: '/', origin: 'https://product.ezarouter.cc' },
  })
  const values = new Map<string, string>()
  vi.stubGlobal('window', browser)
  vi.stubGlobal('navigator', { doNotTrack: null })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('document', {
    createElement: () => ({ remove: vi.fn() }),
    head: { appendChild: (script: HTMLScriptElement) => scripts.push(script) },
  })
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function finishLoading() {
  browser.posthog = posthog
  scripts[0]?.onload?.call(scripts[0], new Event('load'))
}

describe('PostHog 同意与路由边界', () => {
  it('默认关闭，即使已有用户同意也不加载；仅开启但未同意同样不加载', () => {
    grantAnalyticsConsent()
    stop = startPostHog({ ...config, features: { ...config.features, analytics: false } })
    expect(scripts).toHaveLength(0)
    stop()
    revokeAnalyticsConsent()
    stop = startPostHog(config)
    expect(scripts).toHaveLength(0)
  })

  it('同意后异步加载配置的 host 与 key，撤销后停止采集', () => {
    stop = startPostHog(config)
    grantAnalyticsConsent()
    expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('granted')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({
      async: true,
      src: 'https://eu-assets.i.posthog.com/static/array.js',
    })
    finishLoading()
    expect(posthog.init).toHaveBeenCalledWith(
      'public-key',
      expect.objectContaining({ api_host: 'https://eu.i.posthog.com', respect_dnt: true }),
    )
    expect(posthog.capture).toHaveBeenCalledWith('$pageview', {
      $current_url: 'https://product.ezarouter.cc/',
    })
    const beforeSend = posthog.init.mock.calls[0]?.[1].before_send
    expect(beforeSend({ event: '$pageview' })).toEqual({ event: '$pageview' })
    browser.location.pathname = '/admin/users'
    expect(beforeSend({ event: '$pageview' })).toBeNull()
    browser.location.pathname = '/'
    revokeAnalyticsConsent()
    expect(posthog.opt_out_capturing).toHaveBeenCalled()
    expect(beforeSend({ event: '$pageview' })).toBeNull()
    expect(posthog.capture).toHaveBeenCalledTimes(1)
  })

  it('设置 Do Not Track 时，已有同意也不加载', () => {
    grantAnalyticsConsent()
    vi.stubGlobal('navigator', { doNotTrack: '1' })
    stop = startPostHog(config)
    expect(scripts).toHaveLength(0)
  })

  it('应用区导航复用已初始化 SDK，进入后台后过滤后续事件', () => {
    grantAnalyticsConsent()
    stop = startPostHog(config)
    finishLoading()
    stop()
    browser.location.pathname = '/app/personal/chat'
    stop = startPostHog(config)
    expect(posthog.init).toHaveBeenCalledTimes(1)
    expect(posthog.capture).toHaveBeenLastCalledWith('$pageview', {
      $current_url: 'https://product.ezarouter.cc/app/personal/chat',
    })
    browser.location.pathname = '/admin'
    stop()
    stop = undefined
    expect(posthog.init.mock.calls[0]?.[1].before_send({ event: '$pageview' })).toBeNull()
  })

  it('后台与 API 不加载；加载过程中进入后台也不初始化或发送事件', () => {
    grantAnalyticsConsent()
    for (const path of ['/admin', '/admin/users', '/api/health']) {
      browser.location.pathname = path
      stop = startPostHog(config)
      expect(scripts).toHaveLength(0)
      stop()
    }
    browser.location.pathname = '/app/personal/chat'
    stop = startPostHog(config)
    expect(scripts).toHaveLength(1)
    browser.location.pathname = '/admin/users'
    finishLoading()
    expect(posthog.init).not.toHaveBeenCalled()
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('缺少公开 key 或 host 时不加载；自托管使用配置的路径', () => {
    grantAnalyticsConsent()
    for (const analytics of [
      { ...config.analytics, posthogKey: '' },
      { ...config.analytics, posthogHost: '' },
    ]) {
      stop = startPostHog({ ...config, analytics })
      expect(scripts).toHaveLength(0)
      stop()
    }
    stop = startPostHog({
      ...config,
      analytics: { ...config.analytics, posthogHost: 'https://analytics.example.com/proxy/' },
    })
    expect(scripts[0]?.src).toBe('https://analytics.example.com/proxy/static/array.js')
  })
})
