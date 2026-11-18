import { z } from 'zod'

/**
 * 模板配置（`template.config.ts`）：功能开关与产品形态，改代码、重新部署才生效。
 * 除 `app` 外每一项都有默认值（取自 docs/02-project-structure.md §3 草案），
 * 非法取值（未知的登录方式、计费方式等）在类型检查阶段报错。
 */

export type OAuthProvider = 'google' | 'github'
export type PaymentProvider = 'stripe' | 'paypal'
/** 'per_call' 按次 | 'token' 按 token | 'per_unit' 按张/秒 */
export type PricingMode = 'per_call' | 'token' | 'per_unit'
export type AiModality = 'text' | 'image' | 'video'
export type MediaProviderId = 'fal' | 'workers-ai'

export type DefaultLocale = 'en' | 'zh'

/**
 * 营销区块的多语言文案：单语言项目可直接写字符串；多语言时按 `i18n.locales` 逐个填写，
 * 缺少某个语言会在类型检查阶段报错（openspec add-ui-design-system tasks 8.5）。
 */
export type LocalizedText<L extends string = string> = string | Readonly<Record<L, string>>

/** 数据背书的一项：数值原样展示（如 `12,000+` / `1.2 万+`），模板不提供任何默认数值 */
export interface MarketingStat<L extends string = string> {
  readonly value: LocalizedText<L>
  readonly label: LocalizedText<L>
}

/** 「三步流程」的一步；序号按数组顺序生成 */
export interface MarketingStep<L extends string = string> {
  readonly title: LocalizedText<L>
  readonly description: LocalizedText<L>
}

/** 编号产品矩阵的一项；编号按数组顺序生成（01、02…） */
export interface MarketingProduct<L extends string = string> {
  readonly title: LocalizedText<L>
  readonly description: LocalizedText<L>
  /** 16:10 产品截图；省略时显示占位框 */
  readonly image?: { readonly src: string; readonly alt: LocalizedText<L> }
  /** 主按钮 */
  readonly primary: { readonly label: LocalizedText<L>; readonly href: string }
  /** 次级链接，文字固定为「了解更多」 */
  readonly secondaryHref: string
}

/**
 * 预渲染营销页的首屏关键路径（apps/web 构建后处理，只改写预渲染 HTML）：
 * - hydration：eager 照常输出 modulepreload 与水合入口；after-paint 去掉 modulepreload，首次内容绘制后再加载入口
 * - criticalCss：full 内联整份样式表；used 只内联该页用到的规则，完整样式表在首次内容绘制后加载
 * - homeScriptGzipBudget：首页客户端静态闭包 gzip 合计上限（字节），null 不检查
 */
export interface MarketingPerformance {
  readonly hydration: 'eager' | 'after-paint'
  readonly criticalCss: 'full' | 'used'
  readonly homeScriptGzipBudget: number | null
}

/** 主题预设名单（packages/ui/src/styles/presets/*.css）；@product-res/web 的测试断言它与 @product-res/ui 的 UI_PRESETS 一致 */
export const uiPresets = ['neutral', 'blue', 'violet', 'green'] as const
export const uiShapes = ['sharp', 'rounded', 'pill'] as const
export const uiDensities = ['default', 'compact'] as const
/** App 区布局：sidebar 工作台侧边栏（模板默认）| topbar 原有顶部布局 */
export const uiAppLayouts = ['sidebar', 'topbar'] as const

/** `ui` 段在运行时校验：template.config.ts 写了未知预设时构建期即报错，而不是静默回退 */
export const uiConfigSchema = z.strictObject({
  preset: z.enum(uiPresets).default('neutral'),
  shape: z.enum(uiShapes).default('rounded'),
  /** 控件尺寸阶梯：default 36px，compact 28px */
  density: z.enum(uiDensities).default('default'),
  /** App 区布局：sidebar 工作台侧边栏 | topbar 原有顶部布局（已有衍生项目可设为 topbar 保持原样） */
  appLayout: z.enum(uiAppLayouts).default('sidebar'),
})

export type UiPreset = (typeof uiPresets)[number]
/** 组件圆角形状 */
export type UiShape = (typeof uiShapes)[number]
/** 控件尺寸阶梯：default 36px，compact 28px */
export type UiDensity = (typeof uiDensities)[number]
/** App 区布局 */
export type UiAppLayout = (typeof uiAppLayouts)[number]

export const textConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  thinking: z
    .strictObject({
      default: z.enum(['off', 'on']).default('off'),
      userToggle: z.boolean().default(false),
    })
    .prefault({}),
  reasoning: z.strictObject({ display: z.boolean().default(false) }).prefault({}),
  failedReplyRefund: z.enum(['no-visible-output', 'all']).default('no-visible-output'),
  /**
   * 每轮回复后生成的后续推荐问题（add-subject-chat design 决策 5）：默认关闭，每条回复最多生成一次。
   * charge 为 false 时由平台承担；为 true 时先预扣、按实际 token 用量扣积分，且只对按 token 计价的
   * 模型生成（按次计价的模型会让每次追问收一次完整单轮费用，直接跳过）。
   * modelKey 为空时用回复所用的模型；建议配置一个便宜的、按 token 计价的模型 key。
   */
  followUps: z
    .strictObject({
      enabled: z.boolean().default(false),
      charge: z.boolean().default(false),
      count: z.number().int().min(2).max(3).default(3),
      modelKey: z.string().min(1).max(200).nullable().default(null),
    })
    .prefault({}),
})

export type TextConfig = z.infer<typeof textConfigSchema>

/** 解析后的完整配置：所有选项都有值。 */
export interface TemplateConfig<L extends string = string> {
  readonly app: {
    readonly name: string
    readonly url: string
    readonly supportEmail: string
  }
  readonly i18n: {
    readonly enabled: boolean
    readonly locales: readonly L[]
    readonly defaultLocale: L
  }
  readonly tenancy: {
    /** false = 仅个人空间；true = 允许团队 workspace */
    readonly multiTenant: boolean
    readonly maxWorkspacesPerUser: number
    /**
     * 跨空间数据流转（个人空间升级、复制 / 移动，openspec/changes/add-workspace-data-transfer）。
     * 依赖团队空间，multiTenant=false 时解析结果强制为 false。
     */
    readonly dataTransfer: boolean
  }
  readonly auth: {
    readonly emailPassword: boolean
    /**
     * 邮箱密码注册是否必须先验证邮箱才能登录。默认否：注册不发验证邮件，
     * 由用户在账号设置或领取注册赠送积分时主动发起验证（docs/04-auth-and-tenancy.md §1）
     */
    readonly requireEmailVerification: boolean
    /** 邮箱验证码登录（emailOTP 插件） */
    readonly emailOtp: boolean
    /** 魔法链接登录（magicLink 插件） */
    readonly magicLink: boolean
    readonly oauth: readonly OAuthProvider[]
    readonly twoFactor: boolean
    readonly turnstile: boolean
  }
  readonly billing: {
    readonly enabled: boolean
    /** 结账页展示顺序 */
    readonly providers: readonly PaymentProvider[]
    /** ISO 4217 小写货币代码 */
    readonly currency: Lowercase<string>
    /** 邮箱验证后发放 */
    readonly signupBonusCredits: number
    /** past_due 期间保留权益的天数 */
    readonly pastDueGraceDays: number
    /** 订阅积分批次在周期末之后的额外有效期 */
    readonly subscriptionCreditGraceHours: number
    /** 实际消耗超出预扣时平台承担的上限，超出部分从余额补扣 / 记欠费 */
    readonly overage: {
      /** 单次最多承担预扣额的比例 */
      readonly maxRatio: number
      /** 单次最多承担的积分 */
      readonly maxCredits: number
      /** 每个空间每天最多承担的积分 */
      readonly dailyBudgetPerWorkspace: number
    }
    /** 可申请退款的付款时间范围；退款需人工审核，默认不主动退 */
    readonly refundWindowDays: number
  }
  readonly credits: {
    readonly enabled: boolean
    /** 空间需有管理员发放的积分（或用户为平台 admin）才能使用工作台；用于内测准入，积分关闭时不生效 */
    readonly requireGrantForAccess: boolean
    /** 真实登录用户访问 App 时领取每日积分，默认关闭。 */
    readonly dailyEnabled: boolean
  }
  readonly shareCards: {
    /** 分享默认有效天数；null 表示永不过期。 */
    readonly defaultTtlDays: number | null
  }
  readonly marketing: {
    readonly enabled: boolean
    /**
     * 数据背书区块（用户数、评分等）：数值与来源由项目填写，`items` 为空时整个区块不渲染。
     * 最多 4 项；`source` 为数据来源说明（如统计口径与日期），显示在数值下方。
     */
    readonly stats: {
      readonly items: readonly MarketingStat<L>[]
      readonly source: LocalizedText<L> | null
    }
    /** 首页「如何开始」流程（通常 3 步），为空时区块不渲染 */
    readonly steps: readonly MarketingStep<L>[]
    /** 首页编号产品矩阵，为空时区块不渲染 */
    readonly products: readonly MarketingProduct<L>[]
    /** 营销页右下角的悬浮 AI 入口：链接到 href（默认 /app，登录后进入空间），不内嵌对话 */
    readonly aiEntry: { readonly enabled: boolean; readonly href: string }
    /** 预渲染营销页的首屏关键路径（openspec add-marketing-critical-path）；默认与改动前一致 */
    readonly performance: MarketingPerformance
  }
  /** 界面主题（openspec add-ui-design-system design D2/D3）；项目品牌色放 apps/web/src/styles/brand.css */
  readonly ui: {
    /** 主题预设：强调色、圆角与焦点环；根布局在服务端写到 <html data-preset> */
    readonly preset: UiPreset
    readonly shape: UiShape
    readonly density: UiDensity
    /** App 区布局：sidebar 工作台侧边栏（默认）| topbar 原有顶部布局 */
    readonly appLayout: UiAppLayout
  }
  readonly ai: {
    readonly text: TextConfig
    readonly image: boolean
    readonly video: boolean
    /** 启用的媒体服务商；凭据与绑定仍由运行环境提供 */
    readonly mediaProviders: readonly MediaProviderId[]
    /** 新建模型时的默认计费方式，后台可逐个模型修改 */
    readonly defaultPricingMode: { readonly [M in AiModality]: PricingMode }
  }
  readonly features: {
    /**
     * 产品漏斗的唯一真相源，单选避免多套并行（docs/analytics.md）。
     * plausible：无 Cookie 统计，配置 PLAUSIBLE_DOMAIN / PLAUSIBLE_HOST 后才注入，长期词站可设 false；
     * posthog：用户同意且未设置 DNT 时加载。
     */
    readonly analytics: 'plausible' | 'posthog' | false
    /** API Key 调用 /api/v1 */
    readonly publicApi: boolean
    readonly blog: boolean
    readonly docs: boolean
    readonly waitlist: boolean
    readonly newsletter: boolean
    /** 答案优先指南页（/guides），关闭时路由 404、内容不进入构建产物 */
    readonly guides: boolean
  }
  /** 这些值会发送到浏览器，只能填写公开的站点 token / 项目 key。 */
  readonly analytics: {
    readonly cloudflareToken: string
    readonly posthogKey: string
    readonly posthogHost: string
    /**
     * 只用于 selfhost 构建期预渲染（该目标的 HTML 在镜像内生成，读不到运行时环境）；
     * Cloudflare 与所有动态页面都以环境变量 PLAUSIBLE_DOMAIN / PLAUSIBLE_HOST 为准。
     */
    readonly plausibleDomain: string
    readonly plausibleHost: string
    /**
     * 同上，只用于 selfhost 预渲染：访问域名到 site 的映射 `host=site,host=site`，默认空串即单站。
     * 一个部署服务多个域名时配置，动态页面以环境变量 PLAUSIBLE_SITES 为准（docs/analytics.md §4）。
     */
    readonly plausibleSites: string
    /** Clarity 热力图项目 ID，留空即关闭（默认）；会录制会话，不作为转化真相源，启用前更新隐私政策 */
    readonly clarityProjectId: string
  }
}

type Section<K extends keyof TemplateConfig> = TemplateConfig[K]

/** `defineTemplateConfig` 的输入：`app` 必填，其余各项均可省略，嵌套对象可只写部分字段。 */
export interface TemplateConfigInput<L extends string = DefaultLocale> {
  app: Section<'app'>
  i18n?: {
    enabled?: boolean
    locales?: readonly L[]
    /** 必须是 `locales` 之一；省略时取 `locales[0]` */
    defaultLocale?: NoInfer<L>
  }
  tenancy?: Partial<Section<'tenancy'>>
  auth?: Partial<Section<'auth'>>
  billing?: Partial<Omit<Section<'billing'>, 'overage'>> & {
    overage?: Partial<Section<'billing'>['overage']>
  }
  credits?: Partial<Section<'credits'>>
  shareCards?: Partial<Section<'shareCards'>>
  marketing?: {
    enabled?: boolean
    stats?: {
      items?: readonly MarketingStat<NoInfer<L>>[]
      source?: LocalizedText<NoInfer<L>> | null
    }
    steps?: readonly MarketingStep<NoInfer<L>>[]
    products?: readonly MarketingProduct<NoInfer<L>>[]
    aiEntry?: Partial<TemplateConfig['marketing']['aiEntry']>
    performance?: Partial<MarketingPerformance>
  }
  ui?: Partial<Section<'ui'>>
  ai?: Partial<Omit<Section<'ai'>, 'defaultPricingMode' | 'text'>> & {
    text?: z.input<typeof textConfigSchema>
    defaultPricingMode?: Partial<Section<'ai'>['defaultPricingMode']>
  }
  features?: Partial<Section<'features'>>
  analytics?: Partial<Section<'analytics'>>
}

/** 除 `app` 外的默认值，与 docs/02-project-structure.md §3 草案一致。 */
export const templateConfigDefaults = {
  i18n: { enabled: true, locales: ['en', 'zh'], defaultLocale: 'en' },
  tenancy: { multiTenant: false, maxWorkspacesPerUser: 5, dataTransfer: false },
  auth: {
    emailPassword: true,
    requireEmailVerification: false,
    emailOtp: true,
    magicLink: false,
    oauth: ['google', 'github'],
    twoFactor: false,
    turnstile: true,
  },
  billing: {
    enabled: true,
    providers: ['stripe', 'paypal'],
    currency: 'usd',
    signupBonusCredits: 100,
    pastDueGraceDays: 7,
    subscriptionCreditGraceHours: 24,
    overage: { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 },
    refundWindowDays: 30,
  },
  credits: { enabled: true, dailyEnabled: false, requireGrantForAccess: false },
  shareCards: { defaultTtlDays: 90 },
  marketing: {
    enabled: true,
    stats: { items: [], source: null },
    steps: [],
    products: [],
    aiEntry: { enabled: false, href: '/app' },
    performance: { hydration: 'eager', criticalCss: 'full', homeScriptGzipBudget: null },
  },
  ui: { preset: 'neutral', shape: 'rounded', density: 'default', appLayout: 'sidebar' },
  ai: {
    text: {
      enabled: true,
      thinking: { default: 'off', userToggle: false },
      reasoning: { display: false },
      failedReplyRefund: 'no-visible-output',
      followUps: { enabled: false, charge: false, count: 3, modelKey: null },
    },
    image: true,
    video: true,
    mediaProviders: ['fal', 'workers-ai'],
    defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_call' },
  },
  features: {
    analytics: 'plausible',
    publicApi: false,
    blog: true,
    docs: false,
    waitlist: false,
    newsletter: false,
    guides: false,
  },
  analytics: {
    cloudflareToken: '',
    posthogKey: '',
    posthogHost: 'https://us.i.posthog.com',
    plausibleDomain: '',
    plausibleHost: '',
    plausibleSites: '',
    clarityProjectId: '',
  },
} as const satisfies Omit<TemplateConfig<DefaultLocale>, 'app'>

// 流转只发生在个人空间与团队空间之间，没有团队空间时开关无意义，静默关闭而不是报错，
// 便于只切换 multiTenant 就能整体回退。
function resolveTenancy(tenancy: Section<'tenancy'>): Section<'tenancy'> {
  return { ...tenancy, dataTransfer: tenancy.multiTenant && tenancy.dataTransfer }
}

/** 每种语言下文案都非空（字符串形式视为所有语言共用） */
function filled(text: LocalizedText, locales: readonly string[]): boolean {
  if (typeof text === 'string') return text.trim() !== ''
  const record: Readonly<Record<string, string | undefined>> = text
  return locales.every((locale) => (record[locale] ?? '').trim() !== '')
}

/** 营销区块的展示文案与链接不能为空：空串会渲染出空格子或无效按钮 */
function validateMarketing(marketing: TemplateConfig['marketing'], locales: readonly string[]) {
  const fail = (path: string) => {
    throw new RangeError(`template config: marketing.${path} must not be empty`)
  }
  marketing.stats.items.forEach((item, i) => {
    if (!filled(item.value, locales)) fail(`stats.items[${i}].value`)
    if (!filled(item.label, locales)) fail(`stats.items[${i}].label`)
  })
  marketing.steps.forEach((step, i) => {
    if (!filled(step.title, locales)) fail(`steps[${i}].title`)
  })
  marketing.products.forEach((product, i) => {
    if (!filled(product.title, locales)) fail(`products[${i}].title`)
    if (!filled(product.primary.label, locales)) fail(`products[${i}].primary.label`)
    if (!product.primary.href.trim()) fail(`products[${i}].primary.href`)
    if (!product.secondaryHref.trim()) fail(`products[${i}].secondaryHref`)
  })
}

/** 合并用户配置与默认值；数组整体替换，不与默认值合并。 */
export function defineTemplateConfig<const L extends string = DefaultLocale>(
  input: TemplateConfigInput<L>,
): TemplateConfig<L> {
  const d = templateConfigDefaults
  // 未提供 locales 时 L 取默认值 DefaultLocale，因此默认 locales 的类型与 L 一致
  const locales = input.i18n?.locales ?? (d.i18n.locales as readonly string[] as readonly L[])
  const defaultLocale = input.i18n?.defaultLocale ?? locales[0]
  if (defaultLocale === undefined) {
    throw new RangeError('template config: i18n.locales must not be empty')
  }
  if (!locales.includes(defaultLocale)) {
    throw new RangeError('template config: i18n.defaultLocale must be one of i18n.locales')
  }

  const config: TemplateConfig<L> = {
    app: { ...input.app },
    i18n: { enabled: input.i18n?.enabled ?? d.i18n.enabled, locales, defaultLocale },
    tenancy: resolveTenancy({ ...d.tenancy, ...input.tenancy }),
    auth: { ...d.auth, ...input.auth },
    billing: {
      ...d.billing,
      ...input.billing,
      overage: { ...d.billing.overage, ...input.billing?.overage },
    },
    credits: { ...d.credits, ...input.credits },
    shareCards: { ...d.shareCards, ...input.shareCards },
    marketing: {
      enabled: input.marketing?.enabled ?? d.marketing.enabled,
      stats: { ...d.marketing.stats, ...input.marketing?.stats },
      steps: input.marketing?.steps ?? d.marketing.steps,
      products: input.marketing?.products ?? d.marketing.products,
      aiEntry: { ...d.marketing.aiEntry, ...input.marketing?.aiEntry },
      performance: { ...d.marketing.performance, ...input.marketing?.performance },
    },
    ui: uiConfigSchema.parse({ ...d.ui, ...input.ui }),
    ai: {
      ...d.ai,
      ...input.ai,
      text: textConfigSchema.parse(input.ai?.text ?? {}),
      defaultPricingMode: { ...d.ai.defaultPricingMode, ...input.ai?.defaultPricingMode },
    },
    features: { ...d.features, ...input.features },
    analytics: { ...d.analytics, ...input.analytics },
  }

  const ttlDays = config.shareCards.defaultTtlDays
  if (ttlDays !== null && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
    throw new RangeError(
      'template config: shareCards.defaultTtlDays must be a positive integer or null',
    )
  }

  // 背书条桌面端按 4 列排布；数值为空串时会渲染出空格子
  if (config.marketing.stats.items.length > 4) {
    throw new RangeError('template config: marketing.stats.items allows at most 4 entries')
  }
  validateMarketing(config.marketing, config.i18n.locales)
  const performance = config.marketing.performance
  if (!['eager', 'after-paint'].includes(performance.hydration))
    throw new RangeError(
      "template config: marketing.performance.hydration must be 'eager' or 'after-paint'",
    )
  if (!['full', 'used'].includes(performance.criticalCss))
    throw new RangeError(
      "template config: marketing.performance.criticalCss must be 'full' or 'used'",
    )
  const budget = performance.homeScriptGzipBudget
  if (budget !== null && !(Number.isInteger(budget) && budget > 0))
    throw new RangeError(
      'template config: marketing.performance.homeScriptGzipBudget must be a positive integer or null',
    )

  if (config.billing.enabled && !config.credits.enabled) {
    throw new RangeError('template config: billing.enabled requires credits.enabled')
  }
  // AI 沿用套餐授权和积分结算；关闭计费时不能以隐式额度绕过这两个前置条件。
  if (config.ai.text.enabled || config.ai.image || config.ai.video) {
    if (!config.billing.enabled || !config.credits.enabled) {
      throw new RangeError('template config: AI requires billing.enabled and credits.enabled')
    }
  }

  return config
}
