import { defineTemplateConfig } from '@product-res/config'

/**
 * 模板配置：功能开关与产品形态，改代码、重新部署才生效（docs/02-project-structure.md §3）。
 * 省略的项取 `@product-res/config` 中的默认值；密钥与可在后台修改的运行时设置不放在这里。
 * apps/web 经 `apps/web/src/server/template-config.ts` 读取。
 */
export default defineTemplateConfig({
  app: {
    name: 'product-res',
    url: 'https://product.ezarouter.cc',
    supportEmail: 'hxl15380@gmail.com',
  },
  i18n: { enabled: false, locales: ['en', 'zh'], defaultLocale: 'zh' },
  tenancy: {
    multiTenant: false, // false = 仅个人空间；true = 允许团队 workspace
    maxWorkspacesPerUser: 5,
  },
  auth: {
    emailPassword: true,
    requireEmailVerification: false, // 邮箱密码注册是否必须先验证邮箱才能登录；默认否，领取注册赠送积分时才要求验证
    emailOtp: true, // 邮箱验证码登录（emailOTP 插件）
    magicLink: false, // 魔法链接登录（magicLink 插件）
    oauth: [],
    twoFactor: false,
    turnstile: false,
  },
  billing: {
    enabled: true, // 计费依赖积分；关闭计费时同时关闭 AI
    providers: [], // 结账页展示顺序
    currency: 'usd',
    signupBonusCredits: 100, // 用户领取时触发邮箱验证，验证完成后发放
    pastDueGraceDays: 7, // past_due 期间保留权益的天数
    subscriptionCreditGraceHours: 24, // 订阅积分批次在周期末之后的额外有效期
    overage: {
      // 实际消耗超出预扣时平台承担的上限，超出部分从余额补扣 / 记欠费
      maxRatio: 0.2, // 单次最多承担预扣额的 20%
      maxCredits: 50, // 单次最多承担 50 积分
      dailyBudgetPerWorkspace: 200, // 每个空间每天最多承担 200 积分
    },
    refundWindowDays: 30, // 可申请退款的付款时间范围；退款需人工审核，默认不主动退
  },
  credits: { enabled: true },
  marketing: { enabled: false },
  ai: {
    text: {
      enabled: true,
      thinking: { default: 'off', userToggle: false },
      reasoning: { display: false },
      failedReplyRefund: 'no-visible-output',
    },
    image: false,
    video: false,
    mediaProviders: ['fal', 'workers-ai'], // 只启用需要的媒体服务商；Workers AI 使用 AI 绑定，无外部密钥
    // 新建模型时的默认计费方式，后台可逐个模型修改：'per_call' 按次 | 'token' 按 token | 'per_unit' 按张/秒
    defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_call' },
  },
  features: { publicApi: false, blog: false, docs: false, waitlist: false, newsletter: false },
})
