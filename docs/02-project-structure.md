# 02 · 项目结构与约定

## 1. Monorepo 目录

```
product-res/
├─ apps/
│  ├─ web/                        # TanStack Start，部署为 Worker
│  │  ├─ src/
│  │  │  ├─ routes/               # 文件路由
│  │  │  │  ├─ (marketing)/       # 首页、定价、博客、法律页（尽量预渲染）
│  │  │  │  ├─ (auth)/            # 登录、注册、找回密码、邀请接受
│  │  │  │  ├─ app/               # 登录后的应用区（/app/$slug/...，个人空间也有 slug）
│  │  │  │  ├─ admin/             # 平台管理后台
│  │  │  │  └─ api/               # HTTP 接口：auth、webhooks、ai、public v1
│  │  │  ├─ components/           # 页面级组件
│  │  │  ├─ features/             # 按功能组织的 UI + server functions
│  │  │  │  ├─ billing/  ai/  workspace/  settings/  admin/ ...
│  │  │  ├─ server/               # 仅服务端：上下文、中间件、鉴权守卫
│  │  │  ├─ lib/                  # 前端工具
│  │  │  └─ styles/
│  │  ├─ content/                 # MDX：博客、文档、法律页
│  │  ├─ messages/                # Paraglide 文案，按功能拆分：<locale>/<feature>.json
│  │  ├─ .dev.vars.example       # 本地认证模板；支付配置使用根目录 .env.example
│  │  └─ wrangler.jsonc
│  └─ jobs/                       # 纯 Worker：Workflows / Queue 消费者 / Cron
│     ├─ src/
│     │  ├─ workflows/ai-media.ts
│     │  ├─ queues/email.ts  events.ts
│     │  ├─ cron/credits-expire.ts  subscription-grants.ts  holds-sweep.ts  reconcile.ts  cleanup.ts
│     │  └─ index.ts              # 导出 fetch/queue/scheduled + Workflow 类
│     └─ wrangler.jsonc
├─ packages/
│  ├─ config/                     # template.config.ts 类型与默认值、env schema
│  ├─ db/                         # Drizzle schema、迁移、createDb()、scoped 查询
│  ├─ platform/                   # 目标中立能力契约、显式 cloudflare/node 入口
│  ├─ auth/                       # Better Auth 实例工厂与插件配置
│  ├─ billing/                    # PaymentProvider 接口 + stripe/ paypal/ 实现
│  ├─ credits/                    # 积分：grant / hold / capture / release / expire
│  ├─ entitlements/               # 套餐权益判断 can()
│  ├─ ai/                         # 文本模型注册、MediaProvider 接口 + fal/ 实现
│  ├─ storage/                    # R2 封装、预签名上传、SSRF 安全下载
│  ├─ email/                      # React Email 模板 + 发送接口
│  ├─ ui/                         # 共享组件与设计 token（Fluid/Radix），规范见 design-system.md
│  ├─ evals/                      # 提示词评测命令行（pnpm eval:prompts）与示例套件，仅根目录依赖
│  └─ shared/                     # 通用类型、错误、id 生成、时间工具
├─ evals/                         # 项目自有的提示词评测套件 evals/<suite>/（模板不交付文件）
├─ infra/
│  ├─ postgres/                   # VPS 上的 docker-compose（PG + cloudflared + WAL-G）
│  └─ local/                      # 本地开发 docker-compose
├─ docs/
├─ .template-base.json          # 生成副本的模板提交、版本、参数与已包含迁移；需提交
├─ .env.example                 # 本地支付配置模板（只含键与占位符）
├─ .env.local                   # 本地真值，已 gitignore
├─ biome.json  package.json  pnpm-workspace.yaml  turbo.json
└─ CLAUDE.md / AGENTS.md          # AI 编码助手约定
```

**依赖方向**由 `pnpm check:deps`（`scripts/check-deps.mjs`）检查 manifest 与源码：

- `apps/*` 可依赖 `packages/*`；packages 不依赖 apps。
- `shared` 不依赖其他内部包；`config` 仅可依赖 shared；`db` 仅可依赖 shared/config。
- `platform` 仅可依赖 shared/config/db；config/db 不反向依赖 platform。业务包与 apps 可依赖 platform，业务包之间允许互相依赖，检查器没有规定它们的总顺序。
- `@product-res/evals` 只允许根 `package.json` 依赖：任何 app 或 package 的 manifest 与源码（含测试）都不得依赖或引用它，评测工具不进入 Worker 与自托管运行时。说明见 [AI §3「提示词版本与评测」](06-ai.md#提示词版本与评测add-prompt-evals)。
- React 仅允许用于 `ui`。`email` 用 React Email 在服务端渲染邮件，可依赖 React / React DOM / React Email（`react-email`、`@react-email/*`），但不依赖 ui；其他包依赖 React Email 同样视为依赖 React。
- 交互原语、动效与图标库（`radix-ui`、`motion`、`lucide-react`、`class-variance-authority` 等）只允许 `ui` 依赖，`@radix-ui/*` 拆分包全局禁止；apps 只经 `@product-res/ui` 使用组件。页面颜色与尺寸取设计 token，由 `pnpm check:ui` 检查。分层、token 三层（基线 → 预设 → 项目 `brand.css`）、模板与衍生项目的文件归属见 [设计规范](design-system.md)。

**平台导入边界**：业务通过 platform 中立入口访问平台能力。检查器解析 apps/packages 下的源码（含 test/probe/e2e，排除依赖和构建产物），识别静态 import、export from、动态 import、require 和 type import。`cloudflare:workers` / `cloudflare:workflows` 仅允许在 `packages/platform/src/cloudflare/**`；显式 app composition entry 只允许 `cloudflare:workers`。目标测试夹具按文件与模块名明确登记，`cloudflare:test` 只向这些夹具开放，不按目录或 `.test.ts` 后缀豁免。

入口与测试夹具清单位于 [`scripts/check-deps.rules.json`](../scripts/check-deps.rules.json)。A 4.6 已删除 `transition` 及其检查器豁免逻辑，业务导入不再有过渡额度。CF 环境校验与 Sentry 装配位于 web 的 `server/cloudflare/`，作为明确的 composition 辅助入口登记；绑定声明与仅含目标类型的夹具也逐文件登记（空模块列表不授权平台导入）。新增目标入口或测试夹具时只登记确切路径与所需模块，不扩大业务例外。CF/Node 适配器子入口（含相对路径）也仅向对应目标目录、明确入口和目标夹具开放；跨包相对导入同样执行基础包依赖方向检查。

平台能力的具体 API、CF 装配和 B 交接见 [平台能力与交接](platform-capabilities.md)。

## 2. 为什么拆 `apps/jobs`

- Workflow 类必须由某个 Worker 导出；与 TanStack Start 的入口混在一起会增加耦合。已实测：web 经 `script_name` 绑定 jobs 中定义的 Workflow，创建实例、查询状态、`sendEvent` 均可用（Phase 0 任务 4.5、7.2）。
- 后台任务的 CPU / 依赖 / 发布节奏与 Web 不同，拆开后互不影响包体与稳定性。
- `apps/web` 通过 Workflow 绑定（`script_name: jobs`）启动工作流、通过 Queue 投递消息；需要同步调用时用 Service Binding。

## 3. 配置体系

三层配置，**各管各的内容、互不覆盖**（同一个配置项只属于其中一层，不存在「高优先级层覆盖低优先级层」）：

| 层 | 位置 | 内容 | 修改方式 |
|---|---|---|---|
| 密钥 | 线上 Wrangler secrets；本地支付 `.env.local`、认证 app `.dev.vars` | API Key、Webhook secret、Auth secret | 本地按模板填写；线上 `wrangler secret put` |
| 运行时设置 | 数据库 `setting` 表（KV 缓存） | 可在后台修改的项：模型定价、公告、注册开关 | 管理后台 |
| 模板配置 | `template.config.ts`（代码） | 功能开关与产品形态 | 改代码、重新部署 |

本地支付统一使用仓库根目录 `.env.example` / `.env.local`；Web、Jobs 与 billing seed/sync 共用 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`，进程环境优先。本地 dev 入口只把这五项同步到对应 app 已忽略的 `.dev.vars` 管理区块，保留认证配置；其他认证/未来 AI 密钥不由这套支付入口加载。`.env.worktree` 继续负责 Orca 数据库与端口，不写支付密钥。线上不读取本机 `.env.local`，仍需分别配置 Worker secrets。步骤与本地预览构建边界见 [07 §4](./07-infrastructure.md#4-环境变量与绑定清单)。

归属原则：泄露有风险的放密钥；需要不发版就能改的放运行时设置；决定代码路径和产品形态的（是否多租户、启用哪些登录方式）放模板配置。运行时设置在代码里必须有默认值，`setting` 表中缺失时回退到默认值，而不是去读另外两层。

整体模块开关也属于模板配置：`billing.enabled`、`credits.enabled`、
`marketing.enabled`、`i18n.enabled` 默认均为 `true`。支付 provider 列表为空只隐藏支付渠道，
不等于关闭计费模块。计费依赖积分；AI 使用已有套餐授权与积分，因此启用 AI 时必须同时
启用计费和积分。团队工具可关闭计费、积分和所有 AI，保留认证、空间、邮件、运维事件与
成功 heartbeat，无需支付密钥或 `billing:seed`。关闭开关不删除历史账本。
关闭营销后首页转向 `/app`，公开营销路由与预渲染关闭；关闭 i18n 后只编译默认语言，
不注册语言前缀入口，不读取语言偏好，也不展示语言切换。完整组合以真实副本 Node 构建及
空卷 Compose 登录/空间/heartbeat 验证，步骤见 [创建项目](create-project.md)。

营销首页区块的内容也在 `marketing` 段（openspec add-ui-design-system 8.5）：`stats` 为数据背书的数值与来源，
`items` 为空时区块不渲染，模板不提供示例数字；`steps` 为「如何开始」流程（为空不渲染）；`products` 为编号产品矩阵（按顺序编号，`image` 省略时显示占位框）；
`aiEntry` 为右下角悬浮 AI 入口（`href` 默认 `/app`，关闭文本 AI 时一并隐藏）。文案按 `i18n.locales` 逐语言填写，
缺语言在类型检查时报错，空值在构建期报错；区块眉标与标题等固定文案在 `apps/web/messages/<locale>/marketing-blocks.json`。

`marketing.performance` 控制预渲染营销页的首屏关键路径（openspec add-marketing-critical-path；只作用于 Cloudflare 构建
`pnpm build` 的预渲染 HTML，Worker 动态渲染页与自托管构建不变）。`@product-res/config` 默认值与此前行为一致，模板示例全部开启：

| 字段 | 取值 | 作用 |
|---|---|---|
| `hydration` | `'eager'`（默认）/ `'after-paint'` | `after-paint` 去掉 modulepreload，水合入口在首次内容绘制后才下载；首帧更早，可交互稍晚 |
| `criticalCss` | `'full'`（默认）/ `'used'` | `used` 每页只内联本页 DOM 用到的规则（另保留全部 `@font-face`、`.dark`、`:has()`、`::before`/`::after` 以外的伪元素规则，以及条件与本页 `<html>` 属性相符的 `:root[...]`/`:lang()` 规则），完整样式表首帧后加载；项目可在 `apps/web/scripts/critical-css.project.mjs` 追加保留规则 |
| `homeScriptGzipBudget` | `null`（默认）/ 字节数 | 首页客户端静态闭包 gzip 合计上限，超出时 `pnpm build` 失败；同时把首页闭包中的 zod schema 从警告升为失败 |

构建后处理（`apps/web/scripts/inline-critical-css.mjs` + `marketing-html.mjs`）逐页比对改写前后 head 中的 title、meta、
canonical、alternate、图标与 JSON-LD，不一致即构建失败。开启 `used` 后用
`node apps/web/scripts/check-critical-css.mjs <preview 地址>` 核对「只有关键样式」与「完整样式」的截图逐像素一致（只拦截页面 `<noscript>` 中列出的延后样式表，项目自行插入的样式表两次都加载）
（需先 `pnpm --filter @<scope>/web build` 并 `vite preview`）。客户端加载 `template.config.ts` 时由构建期解析好的 JSON 代替，
zod 与配置校验不进入浏览器；首页水合闭包（静态闭包加上水合入口立即 `import()` 的路由树分包）中出现 zod schema 实现时，
首页包检查在设置了 `homeScriptGzipBudget` 时判失败，未设置时只警告，并按 sourcemap 列出引用 zod 的源文件。
路由树分包随每个页面的水合加载，因此：路由 `validateSearch` 用 `apps/web/src/features/routing/search.ts` 而不是 zod；
server function 的 schema 写在 `.validator()` / `.inputValidator()` 调用内（客户端编译时整段删除）；模块顶层的 zod 链式调用
在客户端构建中视为无副作用（`apps/web/scripts/client-pure-schemas.ts`），未被引用即摇掉，但参数里调用了 schema 变量方法
（如 `secret.optional()`）时需用 `/* @__PURE__ */ (() => z.object({...}))()` 包裹。`criticalCss: 'used'` 时另输出 `<noscript>` 引入完整样式表，关闭 JS 的访客样式完整。

`template.config.ts` 草案：

```ts
export default defineTemplateConfig({
  app: { name: 'product-res', url: 'https://product.ezarouter.cc', supportEmail: 'hxl15380@gmail.com' },
  i18n: { locales: ['en', 'zh'], defaultLocale: 'en' },
  tenancy: {
    multiTenant: false,          // false = 仅个人空间；true = 允许团队 workspace
    maxWorkspacesPerUser: 5,
    dataTransfer: false,         // 跨空间数据流转；multiTenant=false 时强制关闭
  },
  auth: {
    emailPassword: true,
    requireEmailVerification: false, // 邮箱密码注册是否必须先验证邮箱才能登录；默认否，领取注册赠送积分时才要求验证
    emailOtp: true,              // 邮箱验证码登录（emailOTP 插件）
    magicLink: false,            // 魔法链接登录（magicLink 插件）
    oauth: ['google', 'github'],
    twoFactor: false,
    turnstile: true,
  },
  billing: {
    providers: ['stripe', 'paypal'],   // 结账页展示顺序
    currency: 'usd',
    signupBonusCredits: 100,           // 用户领取时触发邮箱验证，验证完成后发放
    pastDueGraceDays: 7,               // past_due 期间保留权益的天数
    subscriptionCreditGraceHours: 24,  // 订阅积分批次在周期末之后的额外有效期
    overage: {                         // 实际消耗超出预扣时平台承担的上限，超出部分从余额补扣 / 记欠费
      maxRatio: 0.2,                   // 单次最多承担预扣额的 20%
      maxCredits: 50,                  // 单次最多承担 50 积分
      dailyBudgetPerWorkspace: 200,    // 每个空间每天最多承担 200 积分
    },
    refundWindowDays: 30,              // 可申请退款的付款时间范围；退款需人工审核，默认不主动退
  },
  ai: {
    text: { enabled: true, thinking: { default: 'off', userToggle: false }, reasoning: { display: false }, failedReplyRefund: 'no-visible-output' },
    image: true, video: true,
    // 新建模型时的默认计费方式，后台可逐个模型修改：'per_call' 按次 | 'token' 按 token | 'per_unit' 按张/秒
    defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_call' },
  },
  features: {
    publicApi: false,            // API Key 调用 /api/v1
    blog: true, docs: false, waitlist: false,
  },
  // 界面主题：预设 neutral | blue | violet | green（只换强调色与焦点环）、圆角形状与控件密度；
  // 品牌 token 不写在这里，放项目自有的 apps/web/src/styles/brand.css；
  // appLayout：App 区布局，sidebar 工作台侧边栏（默认）| topbar 原有顶部布局
  ui: { preset: 'neutral', shape: 'rounded', density: 'default', appLayout: 'sidebar' },
})
```

`ui.shape` 目前只影响已接入 Fluid 的组件（按钮、选择器、弹窗）：`rounded` 跟随 `--radius`，
`pill` / `sharp` 使用固定圆角；卡片、输入框等其余组件仍按 `--radius` 渲染，随组件接入（tasks 4.x）逐步统一。

环境变量用 Zod 在启动时校验（`packages/config/env.ts`），缺失即报错，避免线上才发现。

## 4. 编码约定

模板版本与逐版本升级动作见 [升级说明](upgrades/README.md)：`template-v*` 是模板发布，
`v*` 是演示站及衍生项目自身的生产发布，会触发生产部署。

- **ID**：主键统一用 UUIDv7（时间有序，利于索引），列类型为 PG 原生 `uuid`（16 字节，比 `text` 存储的 36 字符更省空间、索引更小）。Better Auth 通过 `advanced.database.generateId` 生成 UUIDv7，其表的 id 与外键列也改为 `uuid`（Better Auth CLI 生成的 Drizzle schema 默认是 `text`，在 `packages/db/src/schema/{auth,tenancy}.ts` 中手动调整；已验证 better-auth 1.7.7 的核心、organization、admin 等插件在 `uuid` 列上可用，无需例外，见 `packages/auth/test/auth.test.ts`）。对外暴露的 ID 与内部一致，不另设公开 ID。
- **时间**：数据库一律 `timestamptz`，服务端只处理 UTC；展示层用 `Intl.DateTimeFormat` + 用户时区。
- **金额**：整数最小货币单位（cents）+ `currency` 字段；**积分**：整数。
- **租户过滤**：业务查询必须经过 `scoped(db, workspaceId)` 帮助函数，禁止在 feature 代码里手写 `where workspace_id = ...`。
- **服务端入口**：Server Function / API route 统一走中间件链：`withSession → withWorkspace → withEntitlement → handler`。
- **错误**：业务错误用带 `code` 的 `AppError`，API 返回 `{ error: { code, message } }`，前端按 code 做 i18n。
- **外部调用**：一律经过对应 package 的接口（PaymentProvider / MediaProvider / EmailSender），不在 feature 代码里直接用第三方 SDK。
- **Webhook**：一律「验签 → 去重 → 事务处理 → 异步副作用」四步。
- **迁移**：只通过 drizzle-kit 生成的 SQL 迁移变更 schema，迁移文件纳入版本控制。
  - drizzle-orm（0.45.3 实测）只执行 journal 中 `when` 大于库中最后一条已应用迁移 `created_at` 的迁移；`when` 更早的新迁移会被**静默跳过**，不报错，也不留记录。
  - 已发布的迁移不再修改，修复改用新迁移；迁移不得依赖固定的 idx 或文件名序号。
  - 衍生项目中，自有迁移沿用 drizzle-kit 默认命名；模板同步移植的迁移命名为 `<idx>_tpl_<原名>`，追加在序列末尾，`when` 晚于已有的全部迁移，原 tag 登记在 `.template-base.json` 的 `migrations` 中。
  - 先扩展后收缩：每个版本的 schema 必须让上一版本的代码仍可运行。删除、重命名、改类型、加约束等收缩变更至少晚一个版本发布，语句带 `-- template-contract: <原因>` 注释，升级说明声明 `requiresDeployed`，详见 [升级说明](upgrades/README.md)。
