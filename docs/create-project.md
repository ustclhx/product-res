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
`--analytics plausible|off` 选择产品分析：默认 plausible（新词站），长期词站可 off，写入
`features.analytics`。`--plausible-domain` 是该站 site_id（默认项目名，staging 自动加 `-staging`），
`--plausible-host` 是共用的自建实例 HTTPS 地址；未提供地址时脚本不注入，配置后才启用，见
[埋点文档](analytics.md)。staging 的 APP_URL 默认生成为 `https://staging.<域名>`，不沿用生产域名，
部署前改成实际 staging 地址。
`--features guides` 开启答案优先指南页（`/guides`），副本带三类可修改的示例，默认关闭。
`--turnstile false` 关闭 Turnstile，`--multi-tenant true` 启用团队空间，
`--support-email` 设置支持邮箱。完整参数见帮助命令。

默认生成后运行 frozen-lockfile 安装、typecheck 和 test；自检使用 CI 模式，清除调用者的
数据库连接环境变量，只验证单元测试，不访问模板数据库。`--skip-check` 仅生成，需自行补做
自检。失败时脚本返回非零状态并保留副本方便排查，不将部分自检报告为成功。

生成内容包含改名的包作用域、Worker / Queue / Workflow 名称、站点品牌、
`template.config.ts`、根目录及两个 app 的 `.dev.vars.example` 和 `PROJECT_SETUP.md`。
副本根目录还包含 `.template-base.json`，用于之后采纳模板更新，请将它一起提交到项目仓库。
记录的字段为 `schemaVersion`（当前为 1）、`repository`（去凭据的 HTTPS origin，无 origin 时为 null）、
`commit`（源模板的完整 40 位 SHA）、`version`（HEAD 上最高的合法 `template-v<SemVer>`
版本，未打模板 tag 时为 null）、`clean`（源工作区是否干净）、`params`（展开默认值的
CLI 参数，键排序、列表去重保序，不包含输出目录）和 `migrations`（副本 journal 中的迁移 tag）。
生成器不记录本机源目录、输出目录或 Git 用户信息；参数中的支持邮箱是项目配置的公开联系地址。
源目录不是 Git 仓库时，`repository`、`commit`、`version` 为 null，`clean=false`；
有未提交改动时也标记 `clean=false`，这种来源不能作为可信同步基准。
用已生成副本再次生成时，会重新记录当前源状态，不继承旧记录。
同一源与参数的生成文件列表、内容和权限保持一致；普通文件为 0644、可执行文件和目录为 0755。
Hyperdrive / KV 的部署 ID 重置为零占位值，AI Gateway / R2 账号标识清空，所有环境都需配置新资源；
Rate Limiting 的 RL_AUTH / RL_AI / RL_API / RL_SHARE_CARD 命名空间需独立分配。Queue 名会同步到 jobs 消费者与测试。
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
自托管 secret 通过受限文件与对应 `_FILE` 配置，示例值为空；不使用 CF staging 凭据。
自托管副本不复制 Cloudflare staging/production 发布与 Neon 备份 workflow；Cloudflare 副本保留这些通用发布/备份入口，需配置自身资源与凭据。
OAuth/Turnstile 关闭时副本 Compose 和示例同步移除其要求；原模板文件保持不变。

生成器只交付初始化与运行新项目需要的材料：排除模板路线图、并行波次、一次性验收/交接记录、全部历史 change、Phase 0 探针、Orca 生命周期脚本与模板验收 workflow。业务单测/类型检查依赖的本地夹具、脱敏支付回调录制、OpenSpec 主规格及项目扩展技能保留。Neon staging / production 与 staging 准备 runbook 保留建库、受限角色、资源、密钥和发布/回滚步骤，资源名随项目改写。混合文档以 `template-only` 注释标明仅供模板维护的部分，派生时删除；指向排除资料的链接改为说明文字。新项目自行建立私有验收记录，证据写入 `EVIDENCE_DIR`，默认落在已忽略的 `test-results/evidence/`。

复制排除各级 `.git`、node_modules、`.env` / `.env.*` 和 `.dev.vars*`（保留 example）、
`.wrangler`、dist、`.turbo`、coverage、构建和测试生成目录、进行中的 `openspec/changes`、
探针 results、image-artifacts/image-set/release-bundle 发布产物、selfhost-release 压缩包、Python缓存、日志和证书私钥，以及各级 secrets/、certs/、.data/、job-owners/ 与 selfhost 的 ownership/owners/、
backups/backup-data/、releases/release-state/、state/.state/ 等运行目录。
无扩展名密码与 owner/release 状态不会复制；`.env.example`、`secrets.example` 和运维脚本保留。符号链接不复制，二进制文件原样保留。
脚本不创建远程资源、不写入密钥；上线前按清单和 [基础设施文档](07-infrastructure.md) 配置，
另行验证数据库迁移、集成测试与 staging 端到端流程。

测试使用 Node 内置 test runner，在临时目录验证改名、真值排除、功能清单和路径边界，
无论成功或失败均清理测试目录；不向源树注入测试密钥。

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

上线前按 [成本基线](runbooks/production-neon.md#4-项目设置与预算) 配置：Neon 0.25–1 CU、production reduced Cron、扫描路径 WAF 规则，且不做高频健康轮询。

## 采纳模板更新

同步脚本以目标版本的模板为准，不运行项目里的旧副本。先克隆目标版本，再对项目执行同步：

```bash
git clone --branch template-v0.3.0 "$(node -p "require('./.template-base.json').repository")" /tmp/template
node /tmp/template/scripts/template-sync.mjs sync --project . --to template-v0.3.0
```

- `--to` 指定版本 tag、分支或提交，缺省为最高版本的 `template-v*` 发布；没有模板发布时退回模板默认分支，并在报告中注明。未指定 `--to` 时报告在目标后标明「默认」；目标提交没有发布 tag 时报告标明「目标未发布」，基准记录的 `version` 写 null。
- `--template` 覆盖 `.template-base.json` 中的仓库地址，可以是本地路径。
- `--skip-migration <模板迁移 tag>` 可重复：项目有意删除了某些表时，跳过依赖它们的模板迁移。跳过的迁移不移植，但登记为已处理，以后不会再出现；请自行确认项目代码不依赖它。
- `--verify-db <URL>` 指向一个空的隔离库：先执行项目已有迁移，再执行移植的迁移，确认增量路径会执行全部移植迁移。未提供时报告标为跳过。
- `--confirm-deployed <版本号>` 可重复，声明该模板版本已部署且线上健康，用于越过升级说明的 `requiresDeployed` 边界。
- `--skip-verify` 只供同步工具自身的测试使用：仍完成合并与迁移移植，但不更新基准记录，并以非 0 退出。

开始前，同步会检查：基准记录有效且 `clean=true`、工作区干净（含未跟踪文件）、模板可克隆、基准与目标提交都存在。任一项失败都会直接退出，不创建分支，也不改文件。基准与目标相同时报告「已是最新」并以 0 退出。缺少记录时，先做基准推断。

同步过程：

1. 用基准提交和目标提交各自的生成器，按记录的参数各生成一份副本；两份副本之间的差异就是改名后的模板变更。
2. 在新分支 `template-sync/<目标短 SHA>` 上逐个文件做三方合并，当前分支不动。迁移目录、`.template-base.json`、`PROJECT_SETUP.md` 和 `pnpm-lock.yaml` 不参与合并。模板删除的文件不会从项目中删除，只在报告中列出。
3. 模板新增的迁移追加到项目迁移序列末尾，见 [迁移约定](02-project-structure.md#4-编码约定)。模板改动或删除了已发布的迁移时，同步停止。
4. 任一 `package.json` 有变化时，先 `pnpm install --no-frozen-lockfile` 重新解析锁文件，再用 `--frozen-lockfile` 确认；随后检查 `drizzle-kit generate` 无变化，再运行 `pnpm typecheck` 和 `pnpm test`。
5. 全部通过后，在同步分支上提交基准记录的更新。工具不会推送，也不会合并。

报告默认写到 `<项目 git 目录>/template-sync/<目标短 SHA>.md`，不进入仓库，路径会打印在终端。报告包含：

- 冲突文件及原因；
- 模板已删除、项目中保留的文件（标明项目是否改过）；
- 已应用的变更；
- 移植的迁移（原 tag → 新 tag）与已跳过的迁移；
- 按版本顺序排列的升级概要、说明链接，以及按基准参数过滤后的「必须执行的动作」待办；
- 说明中的迁移清单与实际处理的迁移（包括主动跳过的迁移）不一致、或缺少升级说明时的警告；
- 锁文件中版本变化的包；
- 各项验证结果；
- `PROJECT_SETUP.md` 的变化：只列出，不写入项目。

**冲突处理**：冲突文件保留冲突标记，留在同步分支的工作区，不提交；这时跳过依赖安装、迁移移植和验证，基准记录不变。「项目已删除、模板修改了的文件」也算冲突，项目一侧保持原样，由使用者决定保留还是删除。模板删除的文件不算冲突：确认项目不再使用后自行删除并提交，仍在使用的今后由项目自己维护。模板只改了已发布迁移的整行注释时不会停止同步，报告单列这些迁移。逐个解决并提交后，在同步分支上用相同的 `--to` 再运行一次：工具识别出当前就是该同步分支，跳过文件合并，继续迁移移植、验证和基准更新。验证失败时也一样，修复、提交后重跑即可，已移植的迁移会沿用，不重复追加。

**按版本分段同步**：同步读取目标树中的 [升级说明](upgrades/README.md)，依版本顺序汇总，后续对旧说明的勘误也会生效。动作的适用条件来自基准记录的 `params`：列表参数表示包含该值，多个条件必须全部满足。基准位于两个版本之间时，第一份说明会提示「部分动作可能已随基准完成，需逐项核对」。

如果目标区间内的升级说明声明了 `requiresDeployed: N`，工具会先将目标截断到 N，并提示先部署 N，再继续同步。例如从 0.2.0 升至 0.4.0，而 0.4.0 要求先部署 0.3.0：

```bash
node /tmp/template/scripts/template-sync.mjs sync --project . --to template-v0.4.0
# 审阅并采纳同步分支，完成 0.3.0 部署，确认线上健康后再运行：
node /tmp/template/scripts/template-sync.mjs sync --project . --to template-v0.4.0 --confirm-deployed 0.3.0
```

`--confirm-deployed` 是使用者的部署声明，工具不会替你部署或检查线上环境；有多个边界时逐段完成并重复传入已部署版本。

**已有项目没有基准记录**：用 `infer-base` 从项目首个提交的树还原生成参数，并在模板 main 的首父提交历史中逐一生成候选副本。默认时间窗为项目首个提交前后各 3 天，可指定日期范围：

```bash
node /tmp/template/scripts/template-sync.mjs infer-base --project . --since 2026-10-16 --until 2026-10-20
# 无法还原的参数按提示补齐，例如：
node /tmp/template/scripts/template-sync.mjs infer-base --project . --param media-providers=fal,workers-ai
# 审阅候选和参数后，明确指定候选完整 SHA 才会写入：
node /tmp/template/scripts/template-sync.mjs infer-base --project . --write <候选完整SHA>
```

推断默认使用脚本所在的模板仓库，`--template <URL|路径>` 可覆盖来源；`--param key=value` 可重复。cloudflare 项目找不到镜像 namespace 时沿用生成器默认值 `ghcr.io/configure-owner/<项目名称>`，来源标为生成器默认。输出包含参数及来源、分数最低的前 5 个候选（SHA、日期、标题、差异行数和差异最大的 5 个文件）。评分只统计生成副本中存在的路径，项目独有文件单独列出，`.template-base.json` 不计分。候选超过 `--threshold <行数>`（默认 50）时拒绝写入；没有 `--write` 时仅展示结果。写出的记录包含候选发布版本和生成副本的迁移 tag，工具不提交到 Git，请审阅后自行提交。

## Agent Skills

项目内提供 10 个技能，Codex 使用 `.agents/skills/`，Claude 使用 `.claude/skills/`。
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
| [template-sync](../.agents/skills/template-sync/SKILL.md) | 衍生项目采纳模板更新：版本区间与升级说明预检、本地分支三方合并、迁移移植与验证、基准推断、UI 截图对比 |
| [ui-design](../.agents/skills/ui-design/SKILL.md) | 是否需要设计稿的判断、衍生项目视觉方向（brand.css / 多站点）、Design 画布状态矩阵与确认、离线副本与 OpenSpec 记录 |

示例：`$quick-start 创建 acme，目标 selfhost，默认中文，关闭计费和 AI`；
`/deploy-cloudflare --env staging --domain app.example.com --admin-email <管理员邮箱>`；
`$new-page 新增 app 通知列表`。管理员真实邮箱与 key 只填受限配置，不进入提交或公开报告。

部署技能默认只读预检与本地 dry-run；列出具体动作清单并确认后才创建资源、
写配置/secret、迁移或发布。模板共享 staging 继续只由 main 自动发布。
quick-start 的生成/安装/typecheck/unit 与本地/外部验收分开报告：
缺凭据的 AI、邮件、支付和部署保持待验收，dry-run 不代表部署成功。

