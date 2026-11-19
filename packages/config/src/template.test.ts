import { describe, expect, expectTypeOf, it } from 'vitest'
import { plausibleSite } from './analytics.ts'
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
    expect(config.credits.dailyEnabled).toBe(false)
    expect(config.shareCards.defaultTtlDays).toBe(90)
    expect(config.marketing.enabled).toBe(true)
    // 模板不提供背书数值与产品示例：未配置时这两个区块不渲染
    expect(config.marketing.stats).toEqual({ items: [], source: null })
    expect(config.marketing.steps).toEqual([])
    expect(config.marketing.products).toEqual([])
    expect(config.marketing.aiEntry).toEqual({ enabled: false, href: '/app' })
    expect(config.i18n.enabled).toBe(true)
    expect(config.features.analytics).toBe('plausible')
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

  it('lets projects change the shared default expiry or disable it', () => {
    expect(defineTemplateConfig({ app, shareCards: { defaultTtlDays: 30 } }).shareCards).toEqual({
      defaultTtlDays: 30,
    })
    expect(defineTemplateConfig({ app, shareCards: { defaultTtlDays: null } }).shareCards).toEqual({
      defaultTtlDays: null,
    })
  })

  it('rejects default share expiry values that are not positive integers or null', () => {
    for (const defaultTtlDays of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => defineTemplateConfig({ app, shareCards: { defaultTtlDays } })).toThrow(
        /shareCards.defaultTtlDays must be a positive integer or null/,
      )
    }
  })

  it('marketing.performance defaults to the previous behaviour, merges partially and rejects bad values', () => {
    expect(defineTemplateConfig({ app }).marketing.performance).toEqual({
      hydration: 'eager',
      criticalCss: 'full',
      homeScriptGzipBudget: null,
    })
    expect(
      defineTemplateConfig({ app, marketing: { performance: { hydration: 'after-paint' } } })
        .marketing.performance,
    ).toEqual({ hydration: 'after-paint', criticalCss: 'full', homeScriptGzipBudget: null })
    expect(() =>
      defineTemplateConfig({
        app,
        marketing: { performance: { hydration: 'lazy' as 'eager' } },
      }),
    ).toThrow(/performance.hydration/)
    expect(() =>
      defineTemplateConfig({
        app,
        marketing: { performance: { criticalCss: 'none' as 'full' } },
      }),
    ).toThrow(/performance.criticalCss/)
    for (const homeScriptGzipBudget of [0, -1, 1.5, Number.NaN])
      expect(() =>
        defineTemplateConfig({ app, marketing: { performance: { homeScriptGzipBudget } } }),
      ).toThrow(/homeScriptGzipBudget/)
  })

  it('merges marketing blocks and rejects malformed stats', () => {
    const config = defineTemplateConfig({
      app,
      marketing: {
        stats: { items: [{ value: '1,000+', label: { en: 'Users', zh: '用户' } }] },
        aiEntry: { enabled: true },
      },
    })
    expect(config.marketing.enabled).toBe(true)
    expect(config.marketing.stats).toEqual({
      items: [{ value: '1,000+', label: { en: 'Users', zh: '用户' } }],
      source: null,
    })
    expect(config.marketing.aiEntry).toEqual({ enabled: true, href: '/app' })

    const stat = { value: '1', label: 'Users' }
    expect(() =>
      defineTemplateConfig({ app, marketing: { stats: { items: Array(5).fill(stat) } } }),
    ).toThrow(/at most 4/)
    expect(() =>
      defineTemplateConfig({ app, marketing: { stats: { items: [{ ...stat, value: ' ' }] } } }),
    ).toThrow(/stats.items\[0\].value must not be empty/)
    // 多语言数值逐语言校验
    expect(() =>
      defineTemplateConfig({
        app,
        marketing: { stats: { items: [{ value: { en: '1', zh: '' }, label: 'Users' }] } },
      }),
    ).toThrow(/stats.items\[0\].value/)
    const product = {
      title: 'Atlas',
      description: '',
      primary: { label: 'Open', href: '/register' },
      secondaryHref: '#features',
    }
    expect(() =>
      defineTemplateConfig({ app, marketing: { products: [{ ...product, title: '' }] } }),
    ).toThrow(/products\[0\].title/)
    expect(() =>
      defineTemplateConfig({
        app,
        marketing: { products: [{ ...product, primary: { label: 'Open', href: ' ' } }] },
      }),
    ).toThrow(/products\[0\].primary.href/)
    expect(() =>
      defineTemplateConfig({ app, marketing: { steps: [{ title: '', description: 'x' }] } }),
    ).toThrow(/steps\[0\].title/)
    // 多语言文案缺少语言时类型检查报错，绕过类型时运行时同样拒绝
    expect(() =>
      defineTemplateConfig({
        app,
        // @ts-expect-error zh 缺失
        marketing: { stats: { items: [{ value: '1', label: { en: 'Users' } }] } },
      }),
    ).toThrow(/stats.items\[0\].label/)
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
      plausibleDomain: '',
      plausibleHost: '',
      plausibleSites: '',
      clarityProjectId: '',
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

  it('enables daily grants explicitly without changing the credits module default', () => {
    expect(defineTemplateConfig({ app, credits: { dailyEnabled: true } }).credits).toEqual({
      enabled: true,
      dailyEnabled: true,
      // 项目扩展的准入开关保持默认关闭
      requireGrantForAccess: false,
    })
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

  it('defaults the UI to the neutral rounded preset and merges partial ui settings', () => {
    expect(defineTemplateConfig({ app }).ui).toEqual({
      preset: 'neutral',
      shape: 'rounded',
      density: 'default',
      appLayout: 'sidebar',
    })
    const config = defineTemplateConfig({ app, ui: { preset: 'violet', density: 'compact' } })
    expect(config.ui).toEqual({
      preset: 'violet',
      shape: 'rounded',
      density: 'compact',
      appLayout: 'sidebar',
    })
    expect(defineTemplateConfig({ app, ui: { appLayout: 'topbar' } }).ui.appLayout).toBe('topbar')
  })

  it('rejects an unknown UI preset, shape or density at definition time', () => {
    expect(() => defineTemplateConfig({ app, ui: { preset: 'teal' as never } })).toThrow()
    expect(() => defineTemplateConfig({ app, ui: { shape: 'square' as never } })).toThrow()
    expect(() => defineTemplateConfig({ app, ui: { density: 'cozy' as never } })).toThrow()
    expect(() => defineTemplateConfig({ app, ui: { appLayout: 'stacked' as never } })).toThrow()
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
    followUps: { enabled: false, charge: false, count: 3, modelKey: null },
  })
  expect(
    defineTemplateConfig({ app, ai: { text: { followUps: { enabled: true, count: 2 } } } }).ai.text
      .followUps,
  ).toEqual({ enabled: true, charge: false, count: 2, modelKey: null })
  for (const text of [
    { enabled: 'false' },
    { thinking: { default: 'auto' } },
    { reasoning: { display: 1 } },
    { failedReplyRefund: 'none' },
    { followUps: { count: 5 } },
    { followUps: { enabled: 'yes' } },
    { extra: true },
  ]) {
    // 外部配置可能绕过 TypeScript，运行时也必须拒绝非法策略。
    expect(() => defineTemplateConfig({ app, ai: { text: text as never } })).toThrow()
  }
})

describe('plausibleSite', () => {
  const env = { PLAUSIBLE_DOMAIN: 'acme-staging', PLAUSIBLE_HOST: 'https://plausible.example/x' }

  it('按环境变量给出本站脚本与事件地址', () => {
    expect(plausibleSite('plausible', env)).toEqual({
      domain: 'acme-staging',
      origin: 'https://plausible.example',
      scriptUrl: 'https://plausible.example/js/script.manual.js',
      eventUrl: 'https://plausible.example/api/event',
    })
  })

  it('模板关闭、未配置或地址非法时不启用', () => {
    expect(plausibleSite(false, env)).toBeNull()
    expect(plausibleSite('posthog', env)).toBeNull()
    expect(plausibleSite('plausible', {})).toBeNull()
    expect(plausibleSite('plausible', { ...env, PLAUSIBLE_DOMAIN: ' ' })).toBeNull()
    expect(plausibleSite('plausible', { ...env, PLAUSIBLE_HOST: 'not a url' })).toBeNull()
    expect(plausibleSite('plausible', { ...env, PLAUSIBLE_HOST: 'ftp://x.example' })).toBeNull()
  })
})
