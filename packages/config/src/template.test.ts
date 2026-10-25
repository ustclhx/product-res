import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  defineTemplateConfig,
  type MediaProviderId,
  type PaymentProvider,
  type PricingMode,
  type TemplateConfig,
  templateConfigDefaults,
} from './template.ts'

const app = {
  name: 'product-res',
  url: 'https://product.ezarouter.cc',
  supportEmail: 'hxl15380@gmail.com',
}

describe('defineTemplateConfig', () => {
  it('fills every omitted option with the documented default', () => {
    const config = defineTemplateConfig({ app })
    expect(config).toEqual({ app, ...templateConfigDefaults })
    expect(config.billing.enabled).toBe(true)
    expect(config.credits.enabled).toBe(true)
    expect(config.marketing.enabled).toBe(true)
    expect(config.i18n.enabled).toBe(true)
    expect(config.features.analytics).toBe(false)
    expect(config.analytics.cloudflareToken).toBe('')
    expect(config.analytics.posthogKey).toBe('')
    expect(config.billing.overage).toEqual({
      maxRatio: 0.2,
      maxCredits: 50,
      dailyBudgetPerWorkspace: 200,
    })
  })

  it('forces dataTransfer off when multiTenant is disabled', () => {
    expect(defineTemplateConfig({ app }).tenancy.dataTransfer).toBe(false)
    expect(
      defineTemplateConfig({ app, tenancy: { multiTenant: false, dataTransfer: true } }).tenancy,
    ).toEqual({ multiTenant: false, maxWorkspacesPerUser: 5, dataTransfer: false })
    expect(
      defineTemplateConfig({ app, tenancy: { multiTenant: true, dataTransfer: true } }).tenancy
        .dataTransfer,
    ).toBe(true)
    expect(defineTemplateConfig({ app, tenancy: { multiTenant: true } }).tenancy.dataTransfer).toBe(
      false,
    )
  })

  it('merges nested sections field by field', () => {
    const config = defineTemplateConfig({
      app,
      billing: { overage: { maxCredits: 10 } },
      ai: { video: false, defaultPricingMode: { video: 'per_unit' } },
      features: { analytics: 'posthog' },
      analytics: { posthogKey: 'public-project-key' },
    })
    expect(config.billing.overage).toEqual({
      maxRatio: 0.2,
      maxCredits: 10,
      dailyBudgetPerWorkspace: 200,
    })
    expect(config.billing.refundWindowDays).toBe(30)
    expect(config.analytics).toEqual({
      cloudflareToken: '',
      posthogKey: 'public-project-key',
      posthogHost: 'https://us.i.posthog.com',
    })
    expect(config.ai).toEqual({
      text: templateConfigDefaults.ai.text,
      image: true,
      video: false,
      mediaProviders: ['fal', 'workers-ai'],
      defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_unit' },
    })
  })

  it('does not require email verification by default', () => {
    expect(defineTemplateConfig({ app }).auth.requireEmailVerification).toBe(false)
    const strict = defineTemplateConfig({ app, auth: { requireEmailVerification: true } })
    expect(strict.auth).toMatchObject({ requireEmailVerification: true, emailPassword: true })
  })

  it('replaces arrays instead of merging them', () => {
    const config = defineTemplateConfig({
      app,
      auth: { oauth: ['github'] },
      ai: { mediaProviders: [] },
    })
    expect(config.ai.mediaProviders).toEqual([])
    expect(config.auth.oauth).toEqual(['github'])
    expect(config.auth.emailPassword).toBe(true)
  })

  it('defaults defaultLocale to the first locale', () => {
    const config = defineTemplateConfig({ app, i18n: { locales: ['ja', 'en'] } })
    expect(config.i18n).toEqual({ enabled: true, locales: ['ja', 'en'], defaultLocale: 'ja' })
    expectTypeOf(config.i18n.defaultLocale).toEqualTypeOf<'ja' | 'en'>()
  })

  it('rejects an empty locale list at runtime', () => {
    expect(() => defineTemplateConfig({ app, i18n: { locales: [] } })).toThrow(RangeError)
  })

  it('accepts all modules disabled while retaining their existing parameters', () => {
    const config = defineTemplateConfig({
      app,
      billing: { enabled: false },
      credits: { enabled: false },
      marketing: { enabled: false },
      i18n: { enabled: false, locales: ['ja', 'en'], defaultLocale: 'ja' },
      ai: { text: { enabled: false }, image: false, video: false },
    })
    expect(config.billing).toEqual({ ...templateConfigDefaults.billing, enabled: false })
    expect(config.credits.enabled).toBe(false)
    expect(config.marketing.enabled).toBe(false)
    expect(config.i18n).toEqual({ enabled: false, locales: ['ja', 'en'], defaultLocale: 'ja' })
    expect(config.auth).toEqual(templateConfigDefaults.auth)
  })

  it('accepts credits without billing when AI is disabled', () => {
    const config = defineTemplateConfig({
      app,
      billing: { enabled: false },
      ai: { text: { enabled: false }, image: false, video: false },
    })
    expect(config.credits.enabled).toBe(true)
  })

  it('rejects billing without credits', () => {
    expect(() =>
      defineTemplateConfig({
        app,
        credits: { enabled: false },
        ai: { text: { enabled: false }, image: false, video: false },
      }),
    ).toThrow('billing.enabled requires credits.enabled')
  })

  it.each(['text', 'image', 'video'] as const)('rejects %s AI without billing', (modality) => {
    expect(() =>
      defineTemplateConfig({
        app,
        billing: { enabled: false },
        ai: {
          text: { enabled: modality === 'text' },
          image: modality === 'image',
          video: modality === 'video',
        },
      }),
    ).toThrow('AI requires billing.enabled and credits.enabled')
  })

  it('does not share nested objects with the defaults', () => {
    const config = defineTemplateConfig({ app })
    expect(config.billing.overage).not.toBe(templateConfigDefaults.billing.overage)
  })
})

describe('defineTemplateConfig types', () => {
  it('resolves every option to a non-optional value', () => {
    const config = defineTemplateConfig({ app })
    expectTypeOf(config).toEqualTypeOf<TemplateConfig<'en' | 'zh'>>()
    expectTypeOf(config.billing.overage.maxRatio).toEqualTypeOf<number>()
    expectTypeOf(config.ai.defaultPricingMode.video).toEqualTypeOf<PricingMode>()
    expectTypeOf(config.ai.mediaProviders).toEqualTypeOf<readonly MediaProviderId[]>()
    expectTypeOf(config.billing.providers).toEqualTypeOf<readonly PaymentProvider[]>()
  })

  it('rejects invalid values at type-check time', () => {
    // 每个 @ts-expect-error 都要求下一行确实有类型错误，否则 typecheck 失败
    const invalid = () => [
      // @ts-expect-error 未定义的计费方式
      defineTemplateConfig({ app, ai: { defaultPricingMode: { video: 'per_minute' } } }),
      // @ts-expect-error 未支持的媒体服务商
      defineTemplateConfig({ app, ai: { mediaProviders: ['replicate'] } }),
      // @ts-expect-error 未知的 OAuth 登录方式
      defineTemplateConfig({ app, auth: { oauth: ['google', 'facebook'] } }),
      // @ts-expect-error 未知的支付方式
      defineTemplateConfig({ app, billing: { providers: ['alipay'] } }),
      // @ts-expect-error 未知的配置项
      defineTemplateConfig({ app, billing: { overage: { maxPercent: 10 } } }),
      // @ts-expect-error 未支持的产品分析服务
      defineTemplateConfig({ app, features: { analytics: 'unknown' } }),
      // @ts-expect-error 类型错误的取值
      defineTemplateConfig({ app, tenancy: { multiTenant: 'yes' } }),
      // @ts-expect-error defaultLocale 不在 locales 中
      defineTemplateConfig({ app, i18n: { locales: ['en', 'zh'], defaultLocale: 'fr' } }),
      // @ts-expect-error 省略 locales 时 defaultLocale 只能是默认语言之一
      defineTemplateConfig({ app, i18n: { defaultLocale: 'fr' } }),
      // @ts-expect-error app 必填
      defineTemplateConfig({}),
    ]
    expectTypeOf(invalid).toBeFunction()
  })
})

it('merges text policy defaults and rejects invalid text policy values', () => {
  const config = defineTemplateConfig({
    app,
    ai: { text: { enabled: false, thinking: { userToggle: true } } },
  })
  expect(config.ai.text).toEqual({
    enabled: false,
    thinking: { default: 'off', userToggle: true },
    reasoning: { display: false },
    failedReplyRefund: 'no-visible-output',
  })
  for (const text of [
    { enabled: 'false' },
    { thinking: { default: 'auto' } },
    { reasoning: { display: 1 } },
    { failedReplyRefund: 'none' },
    { extra: true },
  ]) {
    // 外部配置可能绕过 TypeScript，运行时也必须拒绝非法策略。
    expect(() => defineTemplateConfig({ app, ai: { text: text as never } })).toThrow()
  }
})
