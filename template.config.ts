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
  shareCards: { defaultTtlDays: 90 },
  i18n: { enabled: false, locales: ['en', 'zh'], defaultLocale: 'zh' },
  tenancy: {
    multiTenant: true, // false = 仅个人空间；true = 允许团队 workspace（内测开启，add-team-invite-links）
    maxWorkspacesPerUser: 5,
    dataTransfer: false, // 跨空间数据流转（升级 / 复制 / 移动）；正式产品阶段再开启，multiTenant=false 时强制关闭
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
    signupBonusCredits: 0, // 内测不发注册赠送（0 隐藏领取入口）；由管理员在后台发放积分开通账号
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
  credits: {
    enabled: true,
    dailyEnabled: false,
    requireGrantForAccess: true, // 内测：管理员发放积分后才能使用工作台（平台 admin 始终可用）
  },
  marketing: {
    enabled: false,
    // 预渲染营销页的首屏关键路径（docs/02-project-structure.md §3）：
    // after-paint 首帧后再加载水合脚本；used 只内联本页用到的样式；预算为首页客户端脚本 gzip 合计上限（字节）
    performance: { hydration: 'after-paint', criticalCss: 'used', homeScriptGzipBudget: 220000 },
    // 数据背书：只填真实可查的数值与来源，模板不提供示例数字；items 为空时区块不渲染。例如
    // items: [{ value: '12,000+', label: { en: 'Registered users', zh: '注册用户' } }],
    // source: { en: 'Platform data as of 2026-10', zh: '平台统计，截至 2026-10' },
    stats: { items: [], source: null },
    // 「如何开始」流程：按顺序编号，为空时区块不渲染
    steps: [
      {
        title: { en: 'Sign up and create a workspace', zh: '注册并创建空间' },
        description: {
          en: 'Sign in with email or a third-party account to get signup credits and your first workspace.',
          zh: '邮箱或第三方账号登录，自动获得注册积分和第一个工作区。',
        },
      },
      {
        title: { en: 'Pick a tool or upload a document', zh: '选择工具或上传文档' },
        description: {
          en: 'Chat, image generation or long-form reports, as you need them; top up credits whenever you run low.',
          zh: '对话、图片生成、长文报告，按需选用；积分不足时随时补充。',
        },
      },
      {
        title: { en: 'Export results or connect the API', zh: '导出结果或接入 API' },
        description: {
          en: 'Export reports as PDF, or use an API key to bring the same capabilities into your own system.',
          zh: '报告导出 PDF，或用 API 密钥把同样的能力接进你的系统。',
        },
      },
    ],
    // 编号产品矩阵：按顺序编号；image 省略时显示占位框（16:10 截图放 apps/web/public 后填 src）
    products: [
      {
        title: { en: 'Document assistant', zh: '文档助手' },
        description: {
          en: 'Upload a document and ask questions; answers cite the sections they come from.',
          zh: '上传文档后直接提问，回答标出引用的章节。',
        },
        primary: { label: { en: 'Start asking', zh: '开始提问' }, href: '/register' },
        secondaryHref: '#features',
      },
      {
        title: { en: 'Image generation', zh: '图片生成' },
        description: {
          en: 'Describe a picture in words and generate artwork in several sizes and styles.',
          zh: '用文字描述生成配图，支持多种尺寸与风格。',
        },
        primary: { label: { en: 'Generate images', zh: '生成图片' }, href: '/register' },
        secondaryHref: '#features',
      },
      {
        title: { en: 'Long-form reports', zh: '长文报告' },
        description: {
          en: 'Turn source material into a chaptered report with a table of contents, ready to export as PDF.',
          zh: '把资料整理成分章报告，自动目录，可导出 PDF。',
        },
        primary: { label: { en: 'Create a report', zh: '生成报告' }, href: '/register' },
        secondaryHref: '#features',
      },
    ],
    // 右下角悬浮 AI 入口：点击跳转 href（未登录先到登录页），不内嵌对话
    aiEntry: { enabled: true, href: '/app' },
  },
  // 界面主题：preset 'neutral' | 'blue' | 'violet' | 'green'；shape 'sharp' | 'rounded' | 'pill'；
  // density 'default'（36px 控件）| 'compact'（28px）。品牌色写在 apps/web/src/styles/brand.css
  // appLayout：App 区布局，'sidebar' 工作台侧边栏 | 'topbar' 原有顶部布局
  ui: { preset: 'neutral', shape: 'rounded', density: 'default', appLayout: 'sidebar' },
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
  features: {
    analytics: 'plausible',
    publicApi: false,
    blog: false,
    docs: false,
    waitlist: false,
    newsletter: false,
    guides: false,
  },
  analytics: { plausibleDomain: 'product-res', plausibleHost: '', plausibleSites: '' },
})
