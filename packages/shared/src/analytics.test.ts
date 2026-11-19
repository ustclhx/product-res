import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_UNSET,
  analyticsDevice,
  analyticsPath,
  analyticsProps,
  analyticsUrl,
  captureFirstTouch,
  encodeFirstTouch,
  parseFirstTouch,
  parseServerAnalyticsMessage,
  plausibleEventName,
  readCookie,
} from './analytics.ts'

const now = new Date('2026-10-31T00:00:00.000Z')

describe('首触归因', () => {
  it('ChatGPT 流量靠 UTM 与落地路径识别，不依赖 referrer', () => {
    const touch = captureFirstTouch({
      url: new URL('https://acme.example/guides/x?utm_source=ChatGPT&utm_medium=geo&token=secret'),
      referrer: '',
      now,
    })
    expect(touch).toMatchObject({
      source: 'chatgpt',
      medium: 'geo',
      referrerHost: null,
      landingPath: '/guides/x',
    })
    expect(JSON.stringify(touch)).not.toContain('secret')
  })

  it('无 UTM 时取外站主机名，站内或无 referrer 记为 direct，且不保存完整 referrer', () => {
    const url = new URL('https://acme.example/')
    const external = captureFirstTouch({ url, referrer: 'https://www.google.com/search?q=a', now })
    expect(external).toMatchObject({ source: 'www.google.com', referrerHost: 'www.google.com' })
    expect(JSON.stringify(external)).not.toContain('q=a')
    expect(captureFirstTouch({ url, referrer: 'https://acme.example/x', now }).source).toBe(
      'direct',
    )
    expect(captureFirstTouch({ url, now }).source).toBe('direct')
  })

  it('Cookie 可往返，篡改内容被清理或拒绝', () => {
    const touch = captureFirstTouch({ url: new URL('https://acme.example/?utm_source=x'), now })
    expect(parseFirstTouch(encodeFirstTouch(touch))).toEqual(touch)
    for (const bad of [
      null,
      '',
      '%',
      'not-json',
      encodeURIComponent('[]'),
      encodeURIComponent(JSON.stringify({ ...touch, landingPath: 'https://evil.example' })),
      encodeURIComponent(JSON.stringify({ ...touch, firstSeenAt: 'nope' })),
      encodeURIComponent(JSON.stringify({ ...touch, firstSeenAt: '+275760-09-13T00:00:00.000Z' })),
      encodeURIComponent(JSON.stringify({ ...touch, source: 42 })),
      'a'.repeat(4096),
    ])
      expect(parseFirstTouch(bad)).toBeNull()
    const cleaned = parseFirstTouch(
      encodeURIComponent(JSON.stringify({ ...touch, source: `a\u0000b${'c'.repeat(500)}` })),
    )
    expect(cleaned?.source).toMatch(/^abc+$/)
    expect(cleaned?.source.length).toBe(120)
  })

  it('读取指定 Cookie', () => {
    expect(readCookie('a=1; product_res_ft=x%20y; b=2', 'product_res_ft')).toBe('x%20y')
    expect(readCookie('a=1', 'product_res_ft')).toBeNull()
    expect(readCookie(null, 'product_res_ft')).toBeNull()
  })
})

describe('事件属性与路径', () => {
  it('缺省属性显式填充', () => {
    expect(analyticsProps({ locale: 'zh' })).toEqual({
      source: ANALYTICS_UNSET,
      landing_path: ANALYTICS_UNSET,
      locale: 'zh',
      plan: ANALYTICS_UNSET,
      device: ANALYTICS_UNSET,
    })
  })

  it('page_view 映射 Plausible 内置事件', () => {
    expect(plausibleEventName('page_view')).toBe('pageview')
    expect(plausibleEventName('checkout_start')).toBe('checkout_start')
  })

  it('空间 slug 与资源 ID 不进入分析路径', () => {
    const id = '0192f3a0-1111-7222-8333-444455556666'
    expect(analyticsPath(`/app/acme/tasks/${id}`)).toBe('/app/:slug/tasks/:id')
    expect(analyticsPath('/zh/app/acme/chat')).toBe('/zh/app/:slug/chat')
    expect(analyticsPath('/app')).toBe('/app')
    expect(analyticsPath('/pricing')).toBe('/pricing')
  })

  it('URL 只保留 UTM，令牌等查询参数被丢弃', () => {
    expect(
      analyticsUrl(new URL('https://a.example/reset-password?token=t&utm_source=x&q=secret')),
    ).toBe('https://a.example/reset-password?utm_source=x')
  })

  it('按 UA 区分设备', () => {
    expect(analyticsDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('mobile')
    expect(analyticsDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('mobile')
    expect(analyticsDevice('Mozilla/5.0 (Linux; Android 14; SM-X910) Safari')).toBe('tablet')
    expect(analyticsDevice('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet')
    expect(analyticsDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('desktop')
    expect(analyticsDevice(null)).toBeUndefined()
  })
})

describe('服务端事件消息', () => {
  it('只接受字典内的服务端事件', () => {
    expect(
      parseServerAnalyticsMessage({
        v: 1,
        requestId: 'req-1',
        analytics: { event: 'payment_success', provider: 'stripe', providerPaymentId: 'pi_1' },
      }),
    ).toEqual({
      requestId: 'req-1',
      analytics: { event: 'payment_success', provider: 'stripe', providerPaymentId: 'pi_1' },
    })
    expect(
      parseServerAnalyticsMessage({ v: 1, analytics: { event: 'sign_up', userId: 'u1' } }),
    ).toEqual({ analytics: { event: 'sign_up', userId: 'u1' } })
    // 多站部署的注册域名随消息传递；旧消息没有该字段时保持原样。
    expect(
      parseServerAnalyticsMessage({
        v: 1,
        analytics: { event: 'sign_up', userId: 'u1', host: 'arcanumber.com' },
      }),
    ).toEqual({ analytics: { event: 'sign_up', userId: 'u1', host: 'arcanumber.com' } })
    for (const bad of [
      null,
      { v: 1, deliveryId: 'x' },
      { v: 1, operations: [] },
      { v: 2, analytics: { event: 'sign_up', userId: 'u1' } },
      { v: 1, analytics: { event: 'checkout_start' } },
      { v: 1, analytics: { event: 'payment_success', provider: 'stripe' } },
    ])
      expect(parseServerAnalyticsMessage(bad)).toBeNull()
  })
})
