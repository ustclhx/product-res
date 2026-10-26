# product-res

product-res 是基于本模板的 AI SaaS，生产域名为 [product.ezarouter.cc](https://product.ezarouter.cc)。
目前处于内测阶段，由管理员发放积分开通使用。下文各节描述的是模板提供的能力。

基于 TanStack Start、Postgres 与 Cloudflare 的 SaaS 模板：认证与空间、订阅与积分、AI 文本/图片/视频、
后台管理和营销站点开箱即用，同一套业务代码可部署到 Cloudflare Workers，也可自托管为 Node/Docker Compose。
架构与领域文档见 [文档目录](docs/README.md)。Node >=22，pnpm 版本以根 `package.json` 为准。

## 功能

| 领域 | 能力 |
|---|---|
| 账号与认证 | 邮箱密码、邮箱验证码、可选魔法链接与两步验证；Google / GitHub OAuth；Turnstile 防刷；首个管理员按邮箱名单自动提升；账号删除（30 天保留期）与删除前退款提醒 |
| 空间与多租户 | 个人空间默认开启，可选团队空间（成员、角色、邀请）；所有业务数据按空间隔离（`scoped()`） |
| 订阅与支付 | Stripe 与 PayPal：月付/年付订阅、换套餐、期末取消与恢复、积分包；Webhook 验签、去重与重放；test/live 模式切换；退款申请 → 管理员审核（全额或部分）→ 平台退款 |
| 积分 | 订阅/积分包/注册赠送/后台补发多种批次；先到期先消费；AI 调用预扣—结算（hold → capture/release）与超额容忍；部分退款按比例收回、已消费不追溯；账本与余额对账不变式 |
| AI 文本对话 | 流式对话、停止与关页后的可靠结算、用量检查点；按 token / 按次计费；可配置 thinking 与 reasoning 展示；可见正文前自动重试、DeepSeek 前缀续写；无可见输出的失败不收费 |
| AI 图片/视频 | fal.ai 与 Workers AI；异步任务（Workflow）、回调验签与轮询兜底、硬超时；输出转存 R2 与安全下载；失败全退、只扣一次 |
| 模型与套餐 | 后台模型注册（Provider、参数 schema、定价）；按套餐授权模型；后台套餐与价格同步到支付平台 |
| 后台管理 | 用户搜索/封禁/模拟登录、积分补发与收回、回调事件列表与重放、退款审核、运行时设置、每日指标看板；所有写操作带审计日志 |
| 营销与增长 | 首页、定价、博客、文档、法律页；多语言（en/zh）与 SEO（sitemap、robots、OG 图、预渲染）；候补名单、邮件订阅、站内通知 |
| 开放 API | API Key 调用 `/api/v1`（文本补全、媒体任务），默认关闭 |
| 可观测与运维 | 结构化日志与请求 ID、Sentry（含 source map）、`/api/health`（数据库与版本 SHA）、受控故障注入验收套件（仅 staging） |
| 自托管 | 双架构 GHCR 镜像与同 SHA release bundle；一键初始化空白主机、部署/回滚、Caddy/外部代理/cloudflared 接入；WAL-G 备份、保留策略、指定时间点恢复与第二目标副本 |
| 项目生成 | `pnpm create-project` 改名生成新项目，按目标与功能开关裁剪；内置 Agent Skills 引导启动与扩展 |

功能开关集中在 [`template.config.ts`](template.config.ts)；可在后台热改的设置存数据库；密钥只放 secrets。三层互不覆盖。

## 依赖的外部服务与基础设施

按所选部署目标与功能开关启用，未启用的功能不需要对应账号或密钥。

**Cloudflare 部署（默认）**

| 服务 | 用途 | 必需性 |
|---|---|---|
| Cloudflare Workers | web 与 jobs 两个 Worker | 必需 |
| Hyperdrive + Postgres（如 Neon） | 业务数据库连接池 | 必需 |
| Workers KV | 缓存（模型注册表、OAuth token 等） | 必需 |
| Queues | 邮件与事件异步处理 | 必需 |
| Rate Limiting | 认证 / AI / API 限流 | 必需 |
| R2 | 用户文件与 AI 产出存储（S3 API 签发预签名 URL） | 必需（文件清理亦使用） |
| Workflows | AI 媒体任务编排 | 开启图片/视频时 |
| AI Gateway | 文本模型统一出口、BYOK 密钥与用量日志 | 开启文本 AI 时（DeepSeek 可直连） |
| Workers AI | 图片生成（无外部密钥） | 选用 Workers AI 时 |
| Turnstile | 注册/登录人机验证 | 默认开启，可关闭 |

**自托管部署**：一台 Linux 主机（参考 2 vCPU / 4 GiB）+ Docker Compose，镜像内含 Postgres 17、Valkey、Caddy、
可选 SeaweedFS 对象存储与 WAL-G 备份；需要域名（自动签发证书）、S3 兼容存储（外部或自带）与 SMTP 服务。

**第三方服务（两种部署共用，按功能启用）**

| 服务 | 用途 |
|---|---|
| Stripe / PayPal | 订阅、积分包与退款（各自 test/sandbox 与 live） |
| 文本模型服务商：OpenAI、Anthropic、Google AI、DeepSeek 等 | AI 对话 |
| fal.ai | 图片/视频生成 |
| Resend 或 SMTP | 认证与通知邮件（默认 log 通道不外发） |
| Google / GitHub OAuth App | 第三方登录 |
| Sentry | 错误追踪与 source map |
| GitHub Actions + GHCR | CI、staging 自动发布、自托管镜像发布 |

完整的 secret、变量与绑定清单见 [基础设施文档 §4](docs/07-infrastructure.md#4-环境变量与绑定清单)，
新项目生成后另有按所选功能列出的 `PROJECT_SETUP.md`。

## 创建新项目

以下是从模板到本地跑通的最短流程，细节见 [创建项目](docs/create-project.md)。

**1. 生成项目**（在模板根目录）

```sh
pnpm install --frozen-lockfile
pnpm create-project                      # 交互式，或使用下面的非交互参数
pnpm create-project --name acme --domain acme.example --target cloudflare --output ../acme \
  --locale zh --ai text,image --billing stripe --oauth google
```

`--target selfhost` 生成自托管项目（需加 `--image-namespace ghcr.io/<你的账号>/acme`）；
`--billing-enabled false`、`--marketing false`、`--i18n false` 等可关闭对应模块，完整参数见 `pnpm create-project --help`。
生成器会改名包作用域与资源名、写入 `template.config.ts` 和 `PROJECT_SETUP.md`，并自动运行依赖安装、类型检查与单元测试。

**2. 本地数据库**（进入新项目目录）

```sh
cd ../acme
docker compose -f infra/local/docker-compose.yml up -d postgres
pnpm --filter <项目作用域>/db db:migrate
```

**3. 本地配置**

```sh
cp -n apps/web/.dev.vars.example apps/web/.dev.vars
cp -n apps/jobs/.dev.vars.example apps/jobs/.dev.vars
cp -n .env.example .env.local
```

至少填写 `BETTER_AUTH_SECRET` 与 `BOOTSTRAP_ADMIN_EMAILS`（你的管理员邮箱，web `.dev.vars`）；
支付测试密钥写根 `.env.local`；按需补 OAuth、AI、fal、R2 等密钥（见 `PROJECT_SETUP.md`）。
开启计费时写入示例套餐：`pnpm billing:seed`。

**4. 启动并验证**

```sh
pnpm dev        # web 默认 http://localhost:3000，jobs 默认 8788
```

注册管理员邮箱账号并完成邮箱验证后可进入 `/admin`。开启 AI 时在 `/admin/models` 配置模型与定价，
再到 `/admin/billing/plans` 为套餐授权模型，然后在 `/app/<空间>/chat` 发起首次对话。
`GET /api/health` 返回数据库状态与版本。

**5. 部署**

- Cloudflare：按 `PROJECT_SETUP.md` 创建资源并配置 Wrangler secrets 与 GitHub environment secrets，
  main 分支 CI 通过后自动发布 staging；见 [基础设施文档](docs/07-infrastructure.md)。
- 自托管：发布 GHCR 镜像后在空白主机执行初始化与部署脚本；见 [自托管说明](deploy/selfhost/README.md)。

也可以让 AI 代劳：在项目根运行 `/quick-start`（Claude）或 `$quick-start`（Codex），它会询问选项并完成上述步骤。

## Agent Skills

项目内提供 8 个技能，Codex 使用 `.agents/skills/`，Claude 使用 `.claude/skills/`：

- `quick-start`：项目选项、真实生成自检、本地数据库、管理员与首次 AI 调用。
- `deploy-cloudflare` / `deploy-selfhost`：资源与配置预检、部署、版本健康与恢复入口。
- `new-page` / `new-module` / `new-static-page`：按模板约定扩展后台、应用、业务与多语言静态内容。
- `add-ai-model`：后台模型配置与必要的 Provider 扩展。
- `security-scan`：确定性本地扫描与变更安全审查。

在项目根输入 `$quick-start`（Codex）或 `/quick-start`（Claude），或直接要求 agent 阅读技能文件执行。
[完整清单与示例](docs/create-project.md#agent-skills) 包含所有技能链接及两处目录同步规则。
部署默认只读预检与 dry-run；具体写入清单确认后才操作，缺外部凭据的环节明确标记待验收。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 本地启动 web 与 jobs |
| `pnpm check` / `pnpm typecheck` / `pnpm test` | 代码规范、类型检查、测试 |
| `pnpm check:deps` | 包依赖方向检查 |
| `pnpm check:singletons` | 关键依赖唯一实例检查 |
| `pnpm build` / `pnpm build:node` | Cloudflare 构建 / 自托管 Node 构建 |
| `pnpm billing:seed` / `pnpm billing:sync` | 写入示例套餐 / 同步价格到支付平台 |
| `pnpm create-project --help` | 新项目生成参数 |
| `pnpm test:create-project` | 临时目录中的生成器边界测试 |
