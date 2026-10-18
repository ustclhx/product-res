---
name: quick-start
description: 从本模板创建新 SaaS 项目，收集功能选项并完成生成器自检、本地数据库、管理员和首次 AI 验收。用于新项目启动。
---

# 项目启动

将用户选择转换为现有 `pnpm create-project` 参数，并分别交付生成自检、本地运行与真实 AI 的结果。
所有路径相对含 `package.json`、`template.config.ts` 的项目根。先读 `AGENTS.md`、
`docs/create-project.md`、`docs/02-project-structure.md` §3；执行 `pnpm create-project --help`，
以当前 `scripts/create-project.mjs` 的参数和校验为准。此流程只初始化本地项目；云资源和部署另走部署技能。

## 1. 收集与校验选择

先整理已有信息，再交互补齐以下选择；把完整参数表反馈给用户后执行非交互生成。

| 选择 | 对应参数与当前取值 |
|---|---|
| 名称、域名、输出目录 | `--name`：小写字母开头 kebab-case，最多 40 字符；`--domain`：HTTPS 主机名，无端口/路径/凭据；`--output`：模板外尚不存在的目录，默认 `../<name>` |
| 部署目标 | `--target cloudflare\|selfhost`，默认 cloudflare；旧 `--target <path>` 已改为 `--output` |
| selfhost 镜像命名 | `--image-namespace ghcr.io/<owner>/<project>`：小写、不含 tag；替换默认 configure-owner |
| 计费、积分、营销、多语言 | `--billing-enabled`、`--credits-enabled`、`--marketing`、`--i18n`，均为 true/false，默认 true |
| 默认语言、支持邮箱 | `--locale en\|zh`，默认 en；`--support-email`，默认 support@域名 |
| AI 与媒体服务商 | `--ai text,image,video`；`--media-providers fal,workers-ai`，默认全开 |
| 可选公开功能 | `--features publicApi,blog,docs,waitlist,newsletter`，默认仅 blog |
| 支付渠道、OAuth | `--billing stripe,paypal`、`--oauth google,github`，默认全开 |
| Turnstile、团队空间 | `--turnstile true\|false` 默认 true；`--multi-tenant true\|false` 默认 false |

所有列表都可传 `''` 关闭全部。关系校验：billing 依赖 credits；AI 依赖 billing 与 credits，
关闭 billing 必须 `--ai ''`；只清空 `--billing ''` 会隐藏支付渠道，但计费模块仍开启，仍需 seed。
credits 可单独保留用于赠送。关闭营销后 `/` 转到 `/app`，公开营销路由不生成；
关闭 i18n 后只编译默认语言，路径无语言前缀，其他语言前缀返回 404。
selfhost 媒体选择 Node 已支持的 fal；workers-ai 是 Cloudflare 绑定能力，不当作 Node 可用 Provider。

完成条件：名称/目录合法，所有开关已明确，组合满足依赖关系；缺少决定项目形态的信息时先收集。

## 2. 非交互生成与离线自检

例如以下 Cloudflare 文本项目（按用户选择替换公开值）：

```sh
pnpm create-project --name acme --domain acme.example --target cloudflare --output ../acme \
  --locale zh --support-email support@acme.example \
  --billing-enabled true --credits-enabled true --marketing true --i18n true \
  --ai text --media-providers '' --features blog,waitlist \
  --billing stripe --oauth '' --turnstile false --multi-tenant true
```

selfhost 团队工具可使用同一入口，设 `--target selfhost --image-namespace ghcr.io/my-org/acme`、
`--billing-enabled false --credits-enabled false --ai '' --marketing false --i18n false`。
默认执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`。
`verifyProject()` 设置 CI、清除含 DATABASE_URL 或 HYPERDRIVE_LOCAL_CONNECTION_STRING 的环境变量，
副本不继承 `.env*` / `.dev.vars*` 真值，因此这里只验单元测试，不连接模板数据库。
若明确使用 `--skip-check`，随后按 `scripts/create-project.mjs` 的 `verifyProject()` 方式补做以上三项。

阅读生成的 `PROJECT_SETUP.md` 与 `.dev.vars.example`；资源 ID 是占位值，账号标识已清空。
生成器已把 `@product-res/*` 改为 `@<项目名>/*`。后续 filter 从副本 manifest 读取，避免使用模板 scope：

```sh
cd ../acme
DB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('packages/db/package.json','utf8')).name")
```

完成条件：三个自检步骤均退出 0；检查品牌/开关/包名符合选择。失败保留副本定位首个错误，
报告该命令与退出码，不把「已生成」当作「自检通过」。需完整矩阵时才运行 `pnpm test:create-project:verify`，
其真实副本、CI 环境与清理模式见 `scripts/create-project.verify.test.mjs`。

## 3. 本地 PG、迁移与配置

生成自检结束后才配置开发真值。按 `docs/07-infrastructure.md` §3/§4 与副本实际配置操作：

```sh
docker compose -f infra/local/docker-compose.yml up -d postgres
docker compose -f infra/local/docker-compose.yml ps postgres
```

先检查已有容器和 5432 端口。生成器连本地容器/数据库名称也会改名；从副本 Compose 与
`apps/{web,jobs}/wrangler.jsonc` 核对，避免复用模板或其他项目数据库。已有服务冲突时使用独立端口/库，
并同步配置。数据卷非空时 initdb 不会重跑；保留已有数据，排查初始化/权限，勿为快速启动删除卷。

使用 migrator 应用已有迁移。`packages/db/drizzle.config.ts` 读取进程的 MIGRATION_DATABASE_URL，
其次 `.env.worktree`，最后本地默认值；应用连接使用 app 角色。凭据仅写被忽略的本地配置或受限环境，
不放命令参数、聊天、日志或提交。使用 Orca 时保留其独立 `.env.worktree` 和端口。

```sh
pnpm --filter "$DB_PACKAGE" db:migrate
```

开发连接核对两个环境变量名：
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 与
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED`。
web 的 `apps/web/vite.config.ts`、jobs 的 `apps/jobs/scripts/dev.mjs` 从 `.env.worktree` 装配；
无该文件时 Wrangler 使用配置的 localConnectionString。迁移与应用必须指向同一个新项目库。

当对应目标文件不存在时复制模板；已存在则只补缺项，保留真值：

```sh
cp -n apps/web/.dev.vars.example apps/web/.dev.vars
cp -n apps/jobs/.dev.vars.example apps/jobs/.dev.vars
cp -n .env.example .env.local
```

设置 BETTER_AUTH_SECRET；本地默认 EMAIL_TRANSPORT=log 不调用邮件服务，完成真实邮箱验证需可达邮件通道。
认证/AI 放相应 app `.dev.vars`；支付五项由根 `.env.local` 管理，dev 脚本只同步支付管理区块，
不加载根文件中的 AI 密钥。APP_URL 在本地 Vite dev 跟随 localhost 端口，OAuth 回调按实际地址配置。
开启 OAuth/Turnstile 时补对应凭据；本地先关闭时沿用第一步明确选项。

billing.enabled=true 时，在 app 数据库连接已通过上述 Hyperdrive 环境变量装配后执行：

```sh
pnpm billing:seed
```

seed 只写套餐示例，不调用支付服务。关闭 billing 时跳过；首次 free.models=[]，不开放 AI，
重跑 seed 保留已有模型授权。完成条件：PG healthy、迁移成功、必要本地配置齐备、按开关完成 seed。
selfhost 目标的此步骤仍使用仓库 `pnpm dev` 的本地 workerd 联调；Node/Compose 目标验收需另按
`deploy/selfhost/README.md` 与 `docs/runbooks/selfhost-deploy.md` 执行，不把 dev 冒烟视作 selfhost 部署成功。

## 4. 外部服务与三层归属

表内仅列键名；按选中功能配置已有集成，不自动申请账号或云资源。
三层互不覆盖：模板形态在 template.config.ts；可热改的设置在数据库及后台；敏感值在 secret。
`packages/db/src/settings.ts` 的 setting 与模型/套餐业务表各自存其配置，API Key 不写入它们。

| 集成 / 获取入口 | 模板层 / 运行时层 | Secret 与非敏感配置放置 |
|---|---|---|
| Auth：本地生成随机值；管理员由用户指定 | auth 开关 / 后台注册设置 | BETTER_AUTH_SECRET、BOOTSTRAP_ADMIN_EMAILS：web `.dev.vars`；后者仅 web，邮箱名单保密 |
| Google Cloud OAuth 凭据、GitHub Developer Settings OAuth App | auth.oauth / 无 | GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET：web `.dev.vars`；登记实际 `/api/auth/callback/<provider>` 回调 |
| Cloudflare Turnstile 站点 | auth.turnstile / 无 | TURNSTILE_SECRET_KEY：web `.dev.vars`；TURNSTILE_SITE_KEY 为公开 vars |
| Stripe 测试模式 API key/Webhook signing secret、PayPal Developer 沙箱 App/Webhook | billing 开关/providers / 后台套餐与积分包 | STRIPE_SECRET_KEY、STRIPE_WEBHOOK_SECRET、PAYPAL_CLIENT_ID、PAYPAL_CLIENT_SECRET、PAYPAL_WEBHOOK_ID：根 `.env.local`；PAYMENT_MODE=test 是环境配置；dev 同步到 app |
| Resend API Keys、已验证发件域名 | 邮件功能 / 邮件模板 | RESEND_API_KEY：jobs `.dev.vars`；EMAIL_TRANSPORT=resend、EMAIL_FROM、EMAIL_REPLY_TO 为非敏感配置；默认 log 无 key |
| 已选文本服务商控制台 API Keys（OpenAI、Anthropic、Google AI、DeepSeek） | ai.text / `/admin/models` 定价、params_schema、`/admin/billing/plans` 授权 | CF 默认密钥保存在 AI Gateway Provider Keys 的 default alias；可选 OPENAI_API_KEY、ANTHROPIC_API_KEY、GOOGLE_API_KEY、DEEPSEEK_API_KEY 放 web `.dev.vars`；Node 默认 direct：openai 兼容入口需 OPENAI_BASE_URL 与 OPENAI_API_KEY；DeepSeek 使用 DEEPSEEK_API_KEY |
| Cloudflare AI Gateway 鉴权 token（AI Gateway Run 权限） | ai.text / 后台模型 | AI_GATEWAY_TOKEN：web `.dev.vars`；AI_GATEWAY_ACCOUNT_ID、AI_GATEWAY_ID、AI_TEXT_EGRESS 为非敏感 vars；CF 默认 gateway，Node 默认 direct |
| fal.ai Keys；回调 HMAC 本地生成 | ai.image/video、ai.mediaProviders / 后台媒体模型 | FAL_KEY、MEDIA_WEBHOOK_SECRET：使用它们的 web/jobs `.dev.vars` |
| Cloudflare Workers AI | ai.mediaProviders / 后台媒体模型 | web/jobs AI 绑定；无需 Provider key，本地禁用远程绑定，不能离线验收真实推理 |
| Cloudflare R2 桶与受限 S3 token | AI/文件能力 / 空间存储配额 | R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY：使用它们的 app `.dev.vars`；R2_ACCOUNT_ID、R2_FILES_BUCKET 为 vars，FILES 为绑定，文本项目也保留清理用桶；selfhost 使用R2时按 [deploy-selfhost §3](../deploy-selfhost/SKILL.md#3-获授权后初始化与配置) 加载外部S3 overlay |
| selfhost 已有 PG/Valkey、S3 与 SMTP 服务凭据 | 目标/功能开关 / 同上 | 服务器受限 secret 文件与允许的 `_FILE`（以 `packages/config/src/node-schema.ts` 为准）：DATABASE_URL、VALKEY_URL、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY、SMTP_PASSWORD 等；endpoint/bucket、SMTP_HOST/PORT/TLS_MODE 是环境配置；按 [deploy-selfhost](../deploy-selfhost/SKILL.md) §1–§5核对bundle装配、`compose.s3.yaml`、复用主机、独立凭据副本与健康预算 |
| Sentry 项目 Client Keys 与上传 token | 无 / 无 | SENTRY_DSN：web/jobs secret；SENTRY_ENVIRONMENT 是 vars；SENTRY_AUTH_TOKEN/ORG/PROJECT 仅 CI source map 上传 |
| Cloudflare 部署 token、数据库 migrator 凭据 | 无 / 无 | CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、STAGING_MIGRATION_DATABASE_URL：GitHub staging environment；本地 migrator 用 MIGRATION_DATABASE_URL，不写业务运行时设置 |

线上 Cloudflare 使用对应 Worker 的 Wrangler secrets；本地文件不会自动上传。
selfhost 使用 `deploy/selfhost/secrets.example`、受限文件和当前允许的 `_FILE`，不要凭空为每个键拼 `_FILE`。
直连仅支持文档中的 OpenAI 兼容入口与 DeepSeek 特例；其他原生文本 Provider 仍走 Gateway，
不能仅因 Node 默认 direct 就跳过其 Gateway 配置。
完整键/绑定以 `PROJECT_SETUP.md`、`docs/07-infrastructure.md` §4、`packages/config/src/node-schema.ts`、
`docs/06-ai.md` 的 Gateway 与密钥说明为准。只报告已配置/缺失的键名与功能，不展示真值。

## 5. 管理员、dev 与首次 AI

1. 在 web 本地 `.dev.vars` 填 BOOTSTRAP_ADMIN_EMAILS（逗号分隔，忽略大小写与两侧空白）。
   启动 `pnpm dev`，记录自己进程的 PID/会话；从输出取得 web/jobs 地址，默认端口 3000/8788。
2. 访问首页或 `/app`，注册、登录并确认个人空间。检查 `GET /api/health` 的 HTTP 状态与 db.status；
   营销页降级可展示不代表数据库健康。选择的营销/i18n 开关应符合页面行为。
3. 名单内账号必须已验证且未封禁。Google 返回已验证邮箱可提升；邮箱密码账号先在账号设置完成验证，
   再访问后台，已有账号可重新登录检查提升。只有能访问 `/admin` 且存在 admin.user.bootstrap 审计才算管理员验收；
   log 邮件或缺少验证通道时记录未验收，不直接修改角色绕过。移除名单不会自动撤销既有管理员。
4. AI 已关闭时明确跳过调用。开启时在 `/admin/models` 建实际 Provider/model ID、价格与 params_schema，
   然后在 `/admin/billing/plans` 为生效套餐（新用户通常 free）授权模型 key 或 `*`。
   核对用户有足够可用积分，可按已启用产品流程领取验证后的赠送积分或在后台发放。
   模型存在、积分存在都不能替代套餐授权。
5. 仅在用户授权真实调用且所选 Provider、出口、凭据齐备时，在 `/app/<空间slug>/chat` 发送一次短提示。
   确认返回可见回复、消息持久化，用量页面出现本次积分消费且预扣已结算。媒体开启时可另验
   `/app/<空间slug>/media/new` 的任务终态、文件与积分结算；这会调用服务商并消耗额度。
   配置依据 `docs/06-ai.md`、`docs/05-billing.md`，不为自检修改 free 默认策略。

凭据缺失、模型未授权、余额不足分别指出对应入口；将首次 AI 标为未验收，避免重复失败请求。
本地 Workers AI 无远程模拟，缺真实环境时保留未验收。
完成后仅停止自己启动的进程，保留用户项目；临时演示副本则按约定清理。

## 交付与故障定位

输出目录、选择摘要、每项实际命令/退出码和证据；把「生成/安装/typecheck/unit」与
「PG/迁移/登录/管理员/AI」分列为通过、跳过或未验收。外部验收未做时说明缺口。

- 生成拒绝：核对 --output、名称/域名与开关关系，不覆盖已有目录。
- frozen-lockfile 失败：核对 Node >=22 与根 packageManager 的 pnpm 版本，保留第一条失败，不修改锁文件绕过。
- filter 无包：从副本 manifest 重读 scope；数据库不可达：核对 PG healthy、端口、库名与 app/migrator 权限。
- OAuth/Turnstile 或邮件失败：核对选中功能及实际回调/发件域名；AI 403 核对套餐授权，余额错误核对积分，
  上游鉴权错误核对实际出口的 key/Gateway token，均按上述配置入口修正。

维护时编辑 `.agents/skills/quick-start/SKILL.md`，复制到 `.claude/skills/quick-start/SKILL.md`，用 `cmp` 检查逐字节一致。
