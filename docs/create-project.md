# 从模板创建项目

在已安装 Node >=22 与本仓库 pnpm 版本的环境中，运行根目录 create-project 脚本。
无参数会询问项目名称、域名、目标目录、默认语言与功能开关。名称采用小写 kebab-case，
域名采用 HTTPS 主机名，语言支持 en、zh。部署目标 `--target cloudflare|selfhost` 默认
为 cloudflare；输出目录 `--output` 默认是当前目录的同级项目目录
（`../<项目名称>`），必须是模板目录之外尚不存在的目录。

非交互示例（完整生成与自检）：

```sh
pnpm create-project --name acme --domain acme.example --target cloudflare --output ../acme --locale zh \
  --ai text --features blog,waitlist --billing stripe --oauth google
```

**Breaking 参数迁移**：旧 `--target ../acme` 改为 `--output ../acme`。旧路径或非法部署目标
会明确失败并提示新用法，不会创建副本。

selfhost 非交互示例（团队工具全关组合）：

```sh
pnpm create-project --name acme --domain acme.example --target selfhost --output ../acme \
  --image-namespace ghcr.io/my-org/acme --ai '' --billing-enabled false \
  --credits-enabled false --marketing false --i18n false --locale zh
```

`--billing-enabled`、`--credits-enabled`、`--marketing`、`--i18n` 接受 true/false，默认 true，
分别写入模板的 billing.enabled、credits.enabled、marketing.enabled、i18n.enabled。
`--billing` 仍为支付 Provider 列表，空列表与关闭模块分别处理。
启用 billing 要求启用 credits；关闭 billing 时必须 `--ai ''`（现有 AI 额度依赖套餐）。
可以保留 credits 开启并关闭 billing，用于赠送积分；生成清单不要求支付 secret 或 billing seed。
开关写入模板，副本继续使用同一套业务源码。关闭营销后，`/` 转向 `/app`：未登录进入
登录页，已登录进入活跃或个人空间；定价、博客、文档、法律页、增长页面、公开增长 API、
robots 与 sitemap 不加入路由，营销页不预渲染，也不生成营销 OG 图。
关闭 i18n 后只编译 `--locale` 所选语言，所有路径无语言前缀，语言控件隐藏；
账号语言、Cookie 与 Accept-Language 不改变显示语言，`/en/...`、`/zh/...` 返回 404。
已有未接入 Paraglide 的固定文案仍按原页面显示；关闭开关不额外翻译这些文案。
生成器修改 ai.text.enabled 时保留其 thinking、reasoning、failedReplyRefund 等设置。

默认开启文本、图片、视频、Stripe、PayPal、Google、GitHub 与 Turnstile，
可选功能仅开启 blog。列表传空字符串可全部关闭；交互时输入 `-` 可关闭列表。
`--turnstile false` 关闭 Turnstile，`--multi-tenant true` 启用团队空间，
`--support-email` 设置支持邮箱。完整参数见帮助命令。

默认生成后运行 frozen-lockfile 安装、typecheck 和 test；自检使用 CI 模式，清除调用者的
数据库连接环境变量，只验证单元测试，不访问模板数据库。`--skip-check` 仅生成，需自行补做
自检。失败时脚本返回非零状态并保留副本方便排查，不将部分自检报告为成功。

生成内容包含改名的包作用域、Worker / Queue / Workflow 名称、站点品牌、
`template.config.ts`、根目录及两个 app 的 `.dev.vars.example` 和 `PROJECT_SETUP.md`。
Hyperdrive / KV 的部署 ID 重置为零占位值，AI Gateway / R2 账号标识清空，所有环境都需配置新资源；
Rate Limiting 的 RL_AUTH / RL_AI / RL_API 命名空间需独立分配。Queue 名会同步到 jobs 消费者与测试。
FILES 桶按项目改名，R2_FILES_BUCKET 与绑定保持一致；文本模式也保留文件清理 Cron 所需的 FILES 桶。
清单按 AI、支付、OAuth 与 Turnstile 开关列出资源与密钥；关闭图片和视频时移除 Workflow 绑定，
清单不包含媒体服务商、Workflow 与媒体 R2 S3 密钥。
密钥模板只包含空值，APP_URL 使用公开默认地址，来自固定的变量名清单；脚本不读取本地真值生成模板。

PROJECT_SETUP.md 分别列出 Worker 配置与 GitHub staging environment secrets。
SENTRY_DSN 需要分别写入 web / jobs，SENTRY_ENVIRONMENT 设为 staging、production 或临时验收专用 smoke；
CI 的 SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT 仅用于 source map 上传。
APP_VERSION 与 Sentry release 使用同一个完整提交 SHA，CI 已负责注入；手动部署参考
[Sentry runbook](runbooks/sentry.md)。线上 secrets 需要通过 Wrangler 分别写入两个 Worker，
本地 .dev.vars 不会随部署上传。将 .github/workflows/deploy-staging.yml 中的 STAGING_URL
占位地址改为新环境实际可访问的 URL，并核对 staging APP_URL、邮件发件配置与数据库迁移凭据。

selfhost 副本复用 `deploy/selfhost/compose.yaml`、配置示例及仓库已有发布/运维材料。
`--image-namespace` 为不含标签的 OCI namespace，默认 `ghcr.io/configure-owner/<项目名称>`，
本版参数校验与现有 GHCR 发布器一致，只接受小写 `ghcr.io/<owner>/<project>`。
必须替换 configure-owner；镜像为 `<namespace>/<service>:<完整40位SHA>`，
`.env.example` 的 `IMAGE_NAMESPACE` 和 `selfhost-publish.yml` 的 namespace 输入默认值同步更新，
trust/publish 的运行时输入表达式保持一致。`selfhost-images.yml` 只读构建与 smoke，
正式发布只使用内置 GITHUB_TOKEN，无需 CF 或服务器凭据。
自己的功能配置必须在 CI 重新构建，不能直接使用模板仓库镜像。
生成副本可继续作为源创建下一项目，namespace 会按下一项目参数重新写入。

`PROJECT_SETUP.md` 的 selfhost 清单包含受限 secret 文件、PG TLS、专用 ingress、
Compose、同 SHA release、health/jobs/heartbeat、兼容回滚、ownership 与双目标备份恢复步骤。
生成器继承 owner 已提供的交付文件；当前部署/回滚入口为 `deploy/selfhost/deploy.sh`，
初始化为 `init-server.sh`，release 打包/校验为 `release/bundle.py`，外部代理为
`compose.proxy.yaml`；配套 Python/防火墙文件一并继承。参考
[部署](runbooks/selfhost-deploy.md)、[初始化](runbooks/selfhost-init.md)、
[release](runbooks/selfhost-release.md) 和 [代理](runbooks/selfhost-proxy.md) runbook。
恢复/drill 材料尚未交付，首次真实 registry 发布与 B/D ownership 签收仍待协调者确认。缺失文件
在清单中标为待交付，不将生成成功当成实际部署或恢复验收通过。
自托管 secret 通过受限文件与对应 `_FILE` 配置，示例值为空；不使用 CF staging 凭据。
自托管副本不复制自动 CF staging 发布 workflow；Cloudflare 副本继续保留原发布路径。
OAuth/Turnstile 关闭时副本 Compose 和示例同步移除其要求；原模板文件保持不变。

复制排除各级 `.git`、node_modules、`.env` / `.env.*` 和 `.dev.vars*`（保留 example）、
`.wrangler`、dist、`.turbo`、coverage、构建和测试生成目录、进行中的 `openspec/changes`、
探针 results、image-artifacts/image-set/release-bundle 发布产物、selfhost-release 压缩包、Python缓存、日志和证书私钥，以及各级 secrets/、certs/、.data/、job-owners/ 与 selfhost 的 ownership/owners/、
backups/backup-data/、releases/release-state/、state/.state/ 等运行目录。
无扩展名密码与 owner/release 状态不会复制；`.env.example`、`secrets.example` 和运维脚本保留。符号链接不复制，二进制文件原样保留。
脚本不创建远程资源、不写入密钥；上线前按清单和 [基础设施文档](07-infrastructure.md) 配置，
另行验证数据库迁移、集成测试与 staging 端到端流程。

测试使用 Node 内置 test runner，在临时目录验证改名、真值排除、功能清单和路径边界，
无论成功或失败均清理测试目录；不向源树注入测试密钥。

完整副本验证使用 `pnpm test:create-project:verify`：从真实工作树生成 CF 默认、selfhost 默认、
selfhost 全关计费/积分/营销/i18n/AI 三个临时项目，逐文件确认模板原名称与排除目录不存在，
安装依赖并运行 typecheck、单元测试与 Node build，同时验证副本再次生成。结束后清理临时目录。
独立只读 `selfhost-features.yml` 从真实源生成全关副本、构建镜像并在空卷 Compose 启动，
实际验证 SSR/静态资源、登录/空间、关闭入口、成功 heartbeat 与完整 SHA。
该命令单独运行，避免日常边界测试重复安装完整依赖。

新库初始化时，先以 migrator 应用已有迁移，再将新库 app 连接通过进程环境传给
`pnpm billing:seed`（变量名为 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`）。
这条命令只写套餐示例，不调用支付服务；billing.enabled=false 的项目跳过 seed，
AI 关闭且积分模块可按需保留。仅清空支付 Provider 列表时 billing 仍开启，仍需套餐初始化。
首次 seed 的 `free.features.models=[]`，不开放任何 AI 模型。按以下顺序完成首次运行：

1. 为 web 配置可选 `BOOTSTRAP_ADMIN_EMAILS`：线上使用 Worker secret（在 apps/web 执行
   `pnpm exec wrangler secret put BOOTSTRAP_ADMIN_EMAILS --env staging`，通过 stdin 录入）；
   本地填 `apps/web/.dev.vars`。逗号分隔，去除两侧空白并忽略大小写；模板保持空值。
2. 用名单账号登录。邮箱必须已验证且账号未封禁；Google OAuth 返回已验证邮箱时可直接提升，
   邮箱密码账号先在账号设置完成验证，再访问后台。已有账号重新登录也会检查并提升。
3. 在 `/admin/models` 创建模型，然后到 `/admin/billing/plans` 为用户生效套餐（新用户通常为 free）
   多选模型 key 或 `*`（全部模型）并保存。仅新增模型或发积分仍不足以授予调用权限。

套餐页只编辑模型授权，其他权益和价格原样保留；不存在的历史 key 会警告并保留，允许主动移除。
权限在下一次请求生效。重跑 `billing:seed` 保留既有 `features.models`（包括空列表），
其他示例配置仍按 seed 更新。不要为快速验收改模板 free 默认策略。

未配置或空名单会禁用自动提升；移除邮箱不会自动撤销已授予的 admin。
需要撤权时先移除名单，再由运维显式修改数据库中的平台角色（当前后台不提供角色修改入口），否则下一次登录会再次提升。
提升写入 `admin.user.bootstrap` 审计。真实邮箱不要写入代码、文档、PR 或日志。
`BOOTSTRAP_ADMIN_EMAILS` 不放在 wrangler vars 中；现有部署流水线只部署 Worker，
不写入或替换此 secret。staging 配置与部署验收由协调者合并后执行。

Neon staging 使用 TLS 直连与两个 Hyperdrive，不需要 Tunnel / Workers VPC 或自建库备份；
实际部署顺序为迁移 → seed → jobs → web，再登录后台创建模型及配置套餐模型权限。

2026-10-12 临时 `product-res-smoke` 部署验收已通过，临时云资源与本地副本已清理，
脱敏状态、ID 与界面观察见 [6.1 证据](runbooks/evidence/create-project/2026-10-12/acceptance.json)
及 [资源清单](runbooks/evidence/create-project/2026-10-12/resources.md)。
临时 jobs 删除前需先移除其两个 Queue consumer，否则 Cloudflare 会拒绝删除 Worker；
限流 namespace 为 Worker 绑定内的独立整数标识，清理时随临时 Worker 移除绑定。

## Agent Skills

项目内提供 8 个技能，Codex 使用 `.agents/skills/`，Claude 使用 `.claude/skills/`。
在项目根按技能名发起请求，例如 Codex `$quick-start`、Claude `/quick-start`；
也可直接要求 agent 阅读对应 `SKILL.md` 执行。生成副本会一起继承技能并改写包 scope。

| 技能 | 用途 |
| --- | --- |
| [quick-start](../.agents/skills/quick-start/SKILL.md) | 收集项目名、域名、部署目标、功能与语言，非交互生成、自检、本地 PG/管理员与首个 AI 调用 |
| [deploy-cloudflare](../.agents/skills/deploy-cloudflare/SKILL.md) | 新环境资源/绑定/secret 名称预检，迁移、发布、health SHA 与管理员；支持 `--env/--domain/--admin-email` |
| [deploy-selfhost](../.agents/skills/deploy-selfhost/SKILL.md) | 空白主机、GHCR 同 SHA image-set/bundle、部署与 health、兼容回滚和备份恢复入口 |
| [new-page](../.agents/skills/new-page/SKILL.md) | admin/app 路由、类型化 Server Functions、表格/表单、导航和 i18n |
| [new-module](../.agents/skills/new-module/SKILL.md) | 复用现有表与领域模块，租户服务、鉴权入口、运行时设置与积分边界 |
| [new-static-page](../.agents/skills/new-static-page/SKILL.md) | 多语言营销/法务 MDX 或静态路由、SEO、sitemap 与预渲染 |
| [add-ai-model](../.agents/skills/add-ai-model/SKILL.md) | 后台模型编辑器、参数 schema/定价/套餐授权；必要时新增 Provider |
| [security-scan](../.agents/skills/security-scan/SKILL.md) | 工程检查、敏感路径与凭据扫描、鉴权/注入/账本等 diff 审查 |

示例：`$quick-start 创建 acme，目标 selfhost，默认中文，关闭计费和 AI`；
`/deploy-cloudflare --env staging --domain app.example.com --admin-email <管理员邮箱>`；
`$new-page 新增 app 通知列表`。管理员真实邮箱与 key 只填受限配置，不进入提交或公开报告。

部署技能默认只读预检与本地 dry-run；列出具体动作清单并确认后才创建资源、
写配置/secret、迁移或发布。模板共享 staging 继续只由 main 自动发布。
quick-start 的生成/安装/typecheck/unit 与本地/外部验收分开报告：
缺凭据的 AI、邮件、支付和部署保持待验收，dry-run 不代表部署成功。

维护时编辑 `.agents/skills/<name>/SKILL.md` 后复制到 `.claude` 同名路径，
新技能两份逐字节一致，不用符号链接（生成器不复制符号链接）。提交前核对：

```sh
for skill in quick-start deploy-cloudflare deploy-selfhost new-page new-module new-static-page add-ai-model security-scan; do
  cmp ".agents/skills/$skill/SKILL.md" ".claude/skills/$skill/SKILL.md" || exit 1
done
```

现有 OpenSpec 技能保留各 agent 的调用语法差异，不纳入此复制命令。
