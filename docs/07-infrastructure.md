# 07 · 基础设施、环境与部署

## 0. 部署准备

Cloudflare 项目创建自身的 Postgres、Hyperdrive、KV、Queues、R2 与域名资源；自托管项目从同 SHA 镜像与 release bundle 初始化空白主机。开发使用隔离本地数据库，上线前完成权限、备份恢复、健康与支付配置验收，资源和凭据以本项目 `PROJECT_SETUP.md` 为准。

## 1. 自建 Postgres（Cloudflare 形态的可选后端，见 §0）

### 部署形态
一台 VPS（地区按具体应用的主要用户选择，模板不限定），Docker Compose 运行：

| 服务 | 说明 |
|---|---|
| `postgres` | Postgres 17，数据卷挂载本地 SSD；只监听 Docker 内网 / localhost |
| `cloudflared` ×2 | Cloudflare Tunnel，把 PG 暴露给 Hyperdrive（不开放公网端口）；同一 Tunnel 运行**两个副本**（Tunnel 原生支持多个连接器），单个进程崩溃或升级时会自动切换到另一个副本，但切换期间数据库访问会卡住约 5–10 秒、少量请求失败（7.5 实测，见 §2「cloudflared 副本切换」）；副本应放在不同故障域，计划内重启逐个进行 |
| `walg` / `pgbackrest` | 基础备份 + WAL 归档到 R2（S3 兼容） |
| （可选）`postgres-exporter` | 指标给 Grafana / 监控平台 |

模板提供 `infra/postgres/docker-compose.yml`、`postgresql.conf` 基础调优、初始化脚本（创建应用用户，最小权限）。

### 数据库账号
| 账号 | 权限 | 用途 |
|---|---|---|
| `app` | 业务表 DML | Hyperdrive 连接使用 |
| `migrator` | DDL | 仅 CI / 迁移使用 |
| `readonly` | SELECT | 数据分析、排查 |

### 备份与恢复（阶段二必须；阶段一不做）



- 每日基础备份 + 持续 WAL 归档到独立的 R2 桶（开启 Bucket Lock 保留规则，防误删）。
- **异地第二副本**：每日基础备份与 `pg_dump` 再同步一份到**非 Cloudflare 账号**下的对象存储（如 Backblaze B2，使用独立凭证）。业务和主备份都在同一个 Cloudflare 账号下，账号被盗、被封或误操作时会一起丢失。
- 保留策略：7 天每日 + 4 周每周（可调）。
- **每月恢复演练**：在临时实例恢复到指定时间点，并跑一次校验脚本（含积分对账不变式）。
- 另做一份每日 `pg_dump` 逻辑备份（跨版本迁移时用）。

### 可用性目标（单机部署的明确承诺）

| 指标 | 目标 | 依据 |
|---|---|---|
| RPO（最多丢失的数据） | ≤ 1 分钟 | WAL 持续归档，`archive_timeout = 60s` |
| RTO（VPS 故障时的恢复时间） | 约 1–2 小时 | 新开 VPS → 从 R2 拉基础备份 + 回放 WAL → 切换 Tunnel；Runbook 写入 `docs/runbooks/` |
| 计划内停机 | 有 | PG 小版本升级、VPS 重启期间整站写操作不可用 |

单机没有高可用。业务需要更高可用性时，可加一台异地流式复制备库（手动提升），或迁移到托管 PG。

### 监控与告警
- 磁盘使用率、连接数、复制/归档延迟、慢查询（`pg_stat_statements`）、备份是否成功。
- 外部探活：Uptime Kuma 或 Cloudflare Health Checks；告警到邮件 / Telegram / Discord。

### 迁移到托管服务的后路
只使用标准 PG 特性与常见扩展（`pgcrypto`、`pg_trgm`，可选 `pgvector`），更换为 Neon / Supabase / RDS 时只需修改 Hyperdrive 配置。

## 2. Hyperdrive 与数据库连接

### Workers VPC（切换前 staging 与阶段二自建 PG）

Hyperdrive 通过 Workers VPC 服务经 Tunnel 访问私有数据库，**不需要公网主机名、DNS 记录、Access 应用或 Service Token**。链路：Worker → Hyperdrive → Workers VPC 服务（TCP）→ Tunnel → `cloudflared` → Postgres。

步骤（在 `项目维护约定` 中细化）：
1. 创建一个专用 Tunnel，在数据库所在机器上运行 `cloudflared`（阶段一为 `infra/local` 中的可选 `cloudflared` 服务，阶段二为 `infra/postgres`）。
2. Postgres 必须启用 TLS（Workers VPC 的要求）；阶段一使用自签证书，VPC 服务设置为不校验证书。
3. `wrangler vpc service create <name> --type tcp --tcp-port 5432 --app-protocol postgresql --tunnel-id <tunnel-id> --hostname <cloudflared 可达的数据库主机名>`（或 `--ipv4`）；阶段一的自签证书加 `--cert-verification-mode disabled`。
4. 创建两个 Hyperdrive 配置，指向该 VPC 服务（`wrangler hyperdrive create <name> --service-id <id> --database ... --user app ...`）：
   - `app-db`：**关闭缓存**
   - `app-db-cached`：开启缓存（max_age 按需要，如 60s）
5. 在 `apps/web`、`apps/jobs` 的 wrangler 配置中绑定为 `HYPERDRIVE`、`HYPERDRIVE_CACHED`。

### 备选方式：公网主机名 + Access（阶段二可选）

为 PG 配置 TCP 类型的公共主机名（如 `pg.example.com`），为其创建 Access 应用与 Service Token，Hyperdrive 带 Access 的 client id / secret 连接。需要域名与 DNS 编辑权限；优点是 CI 可以经 `cloudflared access tcp` 直接连库执行迁移（见 §5）。

连接代码：

```ts
// packages/db/src/client.ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export function createDb(hd: Hyperdrive) {
  const sql = postgres(hd.connectionString, {
    max: 5,                // 单个 Worker 调用内的并发连接数
    fetch_types: false,    // 省掉一次类型查询往返
    prepare: true,
  })
  return drizzle(sql, { schema })
}
// 每个请求调用一次 createDb(env.HYPERDRIVE)，不要缓存到模块作用域
```

## 3. 环境

| 环境 | Web | 数据库 | 支付 | 说明 |
|---|---|---|---|---|
| local | `wrangler dev` / `vite dev`（workerd） | 本地 Docker PG | Stripe test / PayPal sandbox | Hyperdrive 使用 `localConnectionString` 直连本地 PG；R2/KV/Queues 由 Miniflare 模拟 |
| preview | 每个 PR 一个 Worker 预览版本 | staging 库（**只读 schema**） | 测试模式 | 可选；PR 不得对 staging 库执行迁移，含 schema 变更的 PR 不部署预览（或改用本地验证） |
| staging | 阶段一：`*.workers.dev`；阶段二：`*.staging.<域名>` | 阶段一线上：Neon `product_res_staging`；阶段二：生产服务器上的独立 database 或独立实例 | 测试模式 | main 自动发布已验收；24 小时观察见 Neon runbook |
| production | 自定义域名（派生项目） | 生产库 | 正式 | 模板演示实例已于 2026-10-18 拆除；`env.production` 保留为参考 |

Wrangler 使用 `env.staging` / `env.production` 区分绑定与变量。

### 本地多 Worker 联调（已实测，wrangler 4.146 / @cloudflare/vite-plugin 1.62）

采用**两个进程**：`apps/web` 跑 `vite dev`，`apps/jobs` 跑 `wrangler dev`（`apps/jobs/scripts/dev.mjs`，端口取自 `.env.worktree` 的 `JOBS_PORT` / `JOBS_INSPECTOR_PORT`，并带 `--test-scheduled`）。根目录 `pnpm dev`（`turbo run dev`）同时启动两者。两个进程经本机 dev registry 自动互连，无需额外配置：
- web 的 `AI_MEDIA_WORKFLOW`（`script_name: "jobs"`）能创建 jobs 中定义的 Workflow 实例并查询状态；
- web 的 `EMAIL_QUEUE` producer 投递的消息由 jobs 的消费者处理；
- 手动触发 Cron：`curl "http://localhost:$JOBS_PORT/__scheduled?cron=*/5+*+*+*+*"`。
- 调试路由（仅 `vite dev`，生产构建返回 404）：`POST /api/dev/workflow` 启动实例、`GET /api/dev/workflow?id=` 查询状态、`POST /api/dev/email` 投递一封验证邮件（jobs 默认以 log 通道处理，只打日志）。

备选：Vite 插件的 `auxiliaryWorkers: [{ configPath: '../jobs/wrangler.jsonc' }]` 在单进程内同时运行两个 Worker，Workflow、Queue、Cron（经 `/cdn-cgi/local/explorer/api/local/scheduled?worker=jobs`）同样可用；未采用的原因是 jobs 会改由 web 的 Vite 构建并出现在 web 的构建产物中，与 jobs 独立部署（`wrangler deploy`）的方式不一致。

数据库连接：postgres.js 3.4.9 在 workerd 中调用 `sql.end()` 会产生无法捕获的「Stream was cancelled」，连接失败时其 socket 内部 promise 也会出现未处理的 rejection（不影响查询本身的错误传递）。因此 Worker 中按请求 / 事件创建 `createDb()`、不显式关闭，连接随请求结束由 workerd 回收，Hyperdrive 在边缘维护连接池；测试中由 `onUnhandledError` 只忽略来自该 polyfill 的 rejection（`packages/db/test/postgres-socket-rejection.ts`）。

## 4. 环境变量与绑定清单

### Secrets（线上 Wrangler secrets；本地 app `.dev.vars`，支付入口 `.env.local`）

本地支付入口是根目录 `.env.example` / `.env.local`：提交的模板仅含键和占位符，本地文件放真值且已 gitignore。当前只加载 Stripe/PayPal 五项支付凭据、billing CLI 的 test 开关与可选数据库连接。

- Web / Jobs：通过 `pnpm dev` 或 app 的 `dev` 脚本启动时，把五项支付变量同步到该 app 的 `.dev.vars` 管理区块；进程环境优先，原有认证配置保留。直接调用 `wrangler dev` 会绕过此同步，应使用项目脚本。
- billing seed / sync：Node 内置 dotenv 入口读取根 `.env.local`，共用同样的支付变量名；显式进程环境优先，空数据库值回退到 `.env.worktree`。同步 staging 时须明确指定 staging app 连接并核对库名。
- 认证：仍按 `apps/web/.dev.vars.example` 配置 app `.dev.vars`，OAuth mock 与邮件 log 保持原配置。
- 文本 AI：默认 Provider 密钥存于 Cloudflare AI Gateway BYOK；本地手动把 `AI_GATEWAY_TOKEN` 写入 `apps/web/.dev.vars`，可选的 Provider 密钥也写入同一文件的支付管理区块之外。默认 dev 支付同步只管理五项支付变量，不会把根 `.env.local` 或 shell 中的 AI 密钥同步到 Worker；非敏感 `AI_GATEWAY_ACCOUNT_ID` / `AI_GATEWAY_ID` 配置在 web 的 Wrangler vars（本地使用顶层 `vars`，线上使用对应环境的 `vars`）。不要把 AI 真值写入 vars 或前端环境变量。
- Orca：`.env.local` 不自动复制到子 worktree，每个 worktree 独立配置；数据库/端口仍用生成的 `.env.worktree`。
- 线上：`.env.local` 不自动上传，分别为 web/jobs 的 staging 环境配置 Cloudflare secrets。

构建/部署不执行支付同步，也不会把根 dotenv 真值注入前端代码或 Wrangler vars。Cloudflare Vite 插件会把 **已有 app `.dev.vars`** 复制到 SSR 构建目录的 `.dev.vars`，供本地 `vite preview` 使用；该文件也是被忽略的本地密钥文件，Web 的 Turbo build 排除它以防共享缓存携带本地密钥；整个 `dist` 目录不应作为可公开分享的纯静态产物。`vite preview` 使用构建时的密钥快照，并非直接读取最新根 dotenv。配置详情见 [支付联通 runbook](./runbooks/p2-payment-integration.md)。

```
BETTER_AUTH_SECRET
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
TURNSTILE_SECRET_KEY
RESEND_API_KEY                # jobs；仅 EMAIL_TRANSPORT=resend 时必填
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID
AI_GATEWAY_TOKEN             # 文本 AI 的 Gateway 鉴权；BYOK 必需
OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / DEEPSEEK_API_KEY   # 可选：Provider 密钥放 Worker 而非 BYOK；DeepSeek 配合 AI_TEXT_EGRESS=direct 时直连（#152）
FAL_KEY
MEDIA_WEBHOOK_SECRET          # 回调 URL 的 HMAC
R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   # R2 S3 API 令牌，仅授权 FILES 桶，用于签发预签名上传/下载 URL
SENTRY_DSN
```

文本 AI 默认在 Cloudflare **AI > AI Gateway > 所用 Gateway > Provider Keys** 保存所用 Provider 的 API Key（`default` alias），并开启 Gateway 鉴权。Worker 端只保存 `AI_GATEWAY_TOKEN` secret 与下方 account/gateway vars；Gateway 在请求不含 Provider 授权头时注入 BYOK 密钥。可选地将 Provider 密钥存为对应 Worker secret，模型工厂再经 Gateway 传给 Provider；显式 Provider 授权头会优先于 BYOK。两种方式的 Gateway 鉴权均使用 `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>`，token 需有 **AI Gateway Run** 权限。见 [Cloudflare BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)、[Gateway 鉴权](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) 与 [AI 配置说明](./06-ai.md#gateway-与密钥)。

线上在 `apps/web` 目录通过 `pnpm exec wrangler secret put AI_GATEWAY_TOKEN --env staging` 交互输入 Gateway token；该命令会创建新 Worker 版本并立即部署。采用可选方式时，用同一命令分别配置实际使用的 Provider secret。生产环境改用 `--env production`，各环境独立配置。本地 `.dev.vars` 不会随部署上传；凭据只在交互输入或本地被忽略文件中填写，不出现在命令参数、提交或日志中。见 [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

Sentry 的 `SENTRY_DSN` 仅供 web/jobs 服务端上报，两个 Worker 的 staging secret 分别配置；
`SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT` 只用于 GitHub `staging` environment 的
source map 上传，不进入 Wrangler vars、Worker bundle 或浏览器。运行时必须同时有 DSN 与
`SENTRY_ENVIRONMENT=staging|production|smoke` 才初始化 SDK；顶层 development 与测试默认不发送。
本地一次真实事件的显式验证及凭据处理见 [Sentry runbook](./runbooks/sentry.md)。

### Vars（非敏感）
```
APP_URL
PAYPAL_ENV=sandbox|live          # 规划项；当前 P2 工厂固定 sandbox，不读取该变量
AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID
AI_TEXT_EGRESS=direct|gateway   # CF 缺省 gateway；DeepSeek 需逐块流式时设 direct（Gateway 会整段缓冲 DeepSeek SSE，见 06-ai）
R2_ACCOUNT_ID / R2_FILES_BUCKET   # 拼接 S3 兼容端点
TURNSTILE_SITE_KEY(前端公开)
EMAIL_TRANSPORT=log|resend        # jobs 的邮件发送通道，默认 log：只记录收件人与模板名、不调用外部服务（无 Resend 凭据时使用）
EMAIL_FROM                        # jobs；EMAIL_TRANSPORT=resend 时必填，如 `product-res <noreply@example.com>`，域名需在 Resend 验证
EMAIL_REPLY_TO                    # jobs，可选；默认回复地址（通常为 app.supportEmail）
SENTRY_ENVIRONMENT=development|staging|production|smoke  # 服务端 SDK 开关；staging 在对应 Wrangler env 声明
APP_VERSION                      # CI 完整提交 SHA；jobs 通过 --var 注入，web 在 Vite 构建时固化
```

jobs 侧的邮件变量由 `@product-res/config` 的 `withEmailEnv()` 校验（`apps/jobs/src/env.ts`），`resend` 通道缺少 `RESEND_API_KEY` / `EMAIL_FROM` 时消费者拒绝处理消息（消息留在队列中重试）。

### Bindings
```
HYPERDRIVE, HYPERDRIVE_CACHED     (Hyperdrive)
FILES                             (R2)
CACHE                             (KV)
RL_AUTH, RL_AI                    (Rate Limiting)
EMAIL_QUEUE, EVENTS_QUEUE         (Queues: web 为 producer，jobs 为 consumer)
AI_MEDIA_WORKFLOW                 (Workflows: 定义在 jobs，web 通过 script_name 绑定)
JOBS                              (Service Binding: web → jobs，可选)
AI                                (Workers AI，可选)
```

## 5. 部署与 CI（GitHub Actions）

```
PR:    install → biome check → typecheck → unit test (vitest-plugin) → build
       并行 e2e-smoke：临时 PG → migrate → 本地 vite dev → Chromium 冒烟
       → （可选，且 PR 不含新迁移时）部署预览版本
main:  以上 + 数据库迁移(staging) → 部署 staging → e2e (Playwright) 
tag:   发布门禁 → production 审批 → 构建 jobs/web → 数据库迁移 → 部署 jobs/web → 冒烟测试
```

**staging 自动发布**：`.github/workflows/deploy-staging.yml` 跟随 main 上成功的 `CI`，检出该次 CI 的提交；也可在 main 上手动触发 `workflow_dispatch`。手动发布复用生产 CI 门禁：目标 SHA 必须有本仓库 main 上成功的 `CI` push 运行。仓库变量 `RELEASE_PHASE` 仅接受 `testing|live`，未设置按 `live`；`testing` 可绕过 CI，上线后仅手动选择 `bypass=hotfix` 并填写非空 `reason` 才能绕过。每次绕过都会输出 warning 与 Job Summary，记录类型、原因和触发人。发布使用 GitHub `staging` environment，`staging-deploy` concurrency 串行执行且不取消进行中的运行。PR 的 `ci.yml` 不引用 staging secrets，只操作临时 CI 数据库。

发布顺序为 install → Neon 迁移 → 构建 jobs 与 web → Sentry release / source map 上传 → 部署 jobs → 部署 web → 健康检查 → Playwright `staging` 项目 → finalize release。release 与两个 Worker 的 `APP_VERSION` 均为所检出提交的完整 SHA（`workflow_run.head_sha`，手动运行时为 `github.sha`），与 `/api/health.version` 一致。迁移通过 environment 的 `STAGING_MIGRATION_DATABASE_URL` 直连 Neon，以 `migrator` 执行；Cloudflare 认证使用 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。健康检查每 5 秒轮询、最多 3 分钟，要求 200、`db.status=up`、`version` 等于目标 SHA；之后用 Chromium 检查首页、定价与一次随机邮箱注册。任一步失败即停止发布。

jobs 用 `wrangler deploy --env staging --dry-run --outdir dist --var APP_VERSION:<SHA>` 构建；web 用 `CLOUDFLARE_ENV=staging APP_VERSION=<SHA> vite build`，两个不可达的 Hyperdrive 占位连接保留。构建后 `sentry-cli releases new` 创建 release，分别对 `apps/web/dist/server` 与 `apps/jobs/dist` 执行 `sourcemaps inject`，再以 `--release <SHA> --dist web|jobs --validate --strict --wait` 上传。web/jobs 的独立 dist 避免同名文件冲突，并与各自 SDK 配置一致。上传失败阻止部署；浏览器尚未接入 SDK，CI 在部署前删除 `dist/client` 下的全部 `.map`。SSR 与 jobs map 不在静态 assets 目录内。

部署直接使用注入后的产物：jobs 指定 `dist/index.js --no-bundle` 并再次传入版本 var；web 指定 Vite 生成的 `dist/server/wrangler.json --no-bundle`（包含 staging 绑定与 client assets 路径）。CI 不调用会重新构建的 `deploy:staging` 脚本。Sentry 认证只在上传与 finalize 步骤从 environment secrets 读取，PR CI 不上传。验收与失败排查见 [Sentry runbook](./runbooks/sentry.md)。


### 本地冒烟 e2e

PR 与 main 的 `e2e-smoke` job 和 `check` 并行运行，使用独立 Postgres 17 服务，先初始化角色并应用现有迁移，再由 Playwright 启动本地 `vite dev`。只运行 `playwright.smoke.config.ts` 选中的一个主流程用例：注册进入个人空间、真实退出后密码登录、购买积分包、付款回调入账及重复投递不重复发积分。job 预算 6 分钟，Chromium headless shell 按 Playwright 版本缓存；无 PR secrets，认证签名密钥在临时 runner 随机生成。

在已完成 Orca setup 的 worktree 中，确保本地 PG 已启动、认证 `.dev.vars` 按模板配置，且本 worktree 的 dev 端口空闲，运行：

```sh
pnpm --filter @product-res/db db:migrate
pnpm --filter @product-res/web exec playwright install --only-shell chromium
pnpm --filter @product-res/web test:e2e:smoke
```

夹具只接受 localhost 上的 `product_res_wt_*` 隔离数据库（CI 使用 `product_res_ci_e2e`），仅写入测试套餐，用户和付款通过应用产生。`smoke.vite.ts` 只在专用本地 dev 服务中替换 `createTestPaymentRuntime`，fake Provider 返回本地结账地址与确定的付款事件，复用真实支付服务与 Webhook 去重/入账管线。浏览器复用现有 Turnstile stub；Worker 的 siteverify 返回本地响应，其余外部 fetch 被阻止。五项支付凭据在 dev 子进程中清空，不复用已有服务，不访问 Stripe、PayPal 或 staging；该用例不代表真实平台联通验收。

失败时 CI 只上传 `apps/web/playwright-report/` HTML 报告，保留 7 天；此配置始终禁用 trace、video、截图，不上传 `test-results` 或服务端日志。其余离线 e2e 仍用 `pnpm --filter @product-res/web test:e2e`。

### 夜间全量测试

`.github/workflows/nightly.yml`（Actions 中的 **Nightly**）每日 UTC 19:00（北京时间次日 03:00）定时运行，也支持 `workflow_dispatch` 手动触发；两种入口都仅运行 `main`。三个 job 独立执行，互不阻塞：

- `e2e-full`：使用临时 Postgres 17，运行 `pnpm --filter @product-res/web test:e2e`，采用默认 `playwright.config.ts` 的离线测试范围，不需要外部服务密钥；不包含 Stripe 专用测试、staging / production 项目及 `ai-chat-disconnect`。
- `e2e-multi-tenant`：在 runner 的检出副本中用 `sed` 把 `template.config.ts` 改为 `multiTenant: true`，运行 `e2e/workspace.spec.ts` 与 `e2e/app-shell.spec.ts`，覆盖团队空间创建、邀请、成员管理与侧边栏工作区菜单（默认配置只覆盖单空间分支）；使用独立的 `product_res_wt_multi_tenant` 库。
- `create-project-verify`：运行 `pnpm test:create-project:verify`，验证生成项目的真实副本；衍生项目不包含该模板维护脚本，自动省略此步骤。

失败时上传 Playwright report 与 trace，保留 14 天。失败通知自动创建带 `nightly-failure` 标签的 issue；如果已有未关闭且带同标签的 issue，则追加评论。通知包含运行日期、失败 job 和 Actions run 链接。

在仓库 **Actions → Nightly** 查看运行结果，先按失败 job 下载报告与 trace，再判断是界面或行为变化造成的过时断言，还是真实功能缺陷；修正断言或业务实现，不删除有效用例或增加 retry 掩盖失败。衍生项目同步模板后会继承此 workflow，可按需删除文件或调整 `schedule`。

**阶段二私有 PG 迁移**：CI 可运行 `cloudflared access tcp`（需要 §2 的公网主机名 + Access 备选方式）在本地开转发端口，再执行迁移；或通过 SSH 在生产服务器上执行迁移。

**迁移原则**：只做向后兼容的变更（先加字段/表 → 部署代码 → 再删旧字段），保证 web/jobs 滚动发布期间新旧代码都能运行。staging 与 production 共用 `node scripts/production/migrate.mjs`，强制 `lock_timeout=5s`、`statement_timeout=15min`；锁超时后停止部署。CI 用固定版本 `squawk-cli` 检查相对 base 新增的 SQL；例外必须用 squawk ignore 注释并在同一行说明原因，不修改历史 SQL 来隐藏风险。

Cloudflare 回滚先读取生产 `/api/health.version`，逐条检查当前版本相对目标 tag 新增的迁移。只有每条都声明 `-- rollback-safe: <旧代码仍兼容的具体原因>` 才允许回滚，否则向前修复。该声明只说明 Worker 回退兼容性，不表示 SQL 可以反向执行。新迁移由协调者合并后统一生成并判断；worker 不生成迁移。

**生产部署顺序**：门禁 → production environment 审批 → 构建 `apps/jobs` 与 `apps/web` → source map 上传 → 迁移 → jobs → web。构建失败不执行迁移。生产仍要求 main 历史、staging 发布成功与审批，CI 绕过不影响这些要求。`RELEASE_PHASE=live` 必须配置 Sentry DSN 与上传配置，`testing` 缺失仅在 warning 与摘要中提示。详见 [生产发布 runbook](./runbooks/production-neon.md#7-发布与回滚)。

## 6. 安全清单

- 所有 Webhook 验签；回调 URL 带 HMAC；验签失败记录并告警。
- 线上 Secrets 存 Wrangler secrets；本地真值文件 `.env.local`、app `.dev.vars` 与 SSR 预览 `.dev.vars` 均被忽略，不进 Git、前端资源或公开日志。只提交不含真值的 `.env.example` / `.dev.vars.example`。
- Turnstile + Rate Limiting 保护认证与 AI 接口。
- R2 桶不公开；下载经鉴权签发短期 URL。
- 服务端下载外部 URL 时限制域名白名单、大小与超时（防 SSRF）。
- 管理后台操作写 `audit_log`；模拟登录有明显提示并记录。
- 数据库最小权限账号；自建 PG 只经 Tunnel（Workers VPC 或 Access）访问，不开放公网端口；Neon staging 通过非 pooled TLS 直连，不使用默认 owner 作为 Worker 连接账号。
- 依赖更新：Renovate / Dependabot。

### 安全响应头与 CSP 上线

`apps/web/src/security-headers.ts` 是 Cloudflare / Node 共用的响应头策略。页面、API、Server Function、重定向与错误响应都补齐 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`；只有 HTTPS 响应补 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。已有同名头原样保留，错误响应也携带请求 ID。

完整 CSP 只发送 `Content-Security-Policy-Report-Only`，其中 `frame-ancestors 'none'` 与 X-Frame-Options 一致；当前实际防嵌入由 X-Frame-Options 执行。脚本来源含同源与 Turnstile，表单允许 Stripe Checkout / Portal 跳转，R2 使用 `R2_ACCOUNT_ID` 拼接的精确下载 origin，Node 对象存储使用 `S3_ENDPOINT` 的 origin；Sentry 使用配置 DSN 的 ingest origin（目前 SDK 仅在服务端运行）。不使用全局 `*`。样式允许组件库实际使用的内联 style 属性。

浏览器端提前设置 Zod `jitless`，避免运行时编译与 Function 探测产生 CSP 违规。动态 SSR 为每个请求产生独立 nonce，路由器统一给主题和水合脚本加 nonce，SSR / 对话 API 流继续透传。预渲染静态 HTML 则对构建产物中的内联脚本计算 SHA-256 内容哈希，哈希按 HTML parser 的换行与 NUL 规范化规则计算，原始字节、缓存头及 ETag 保持不变；304 不替换缓存文档已有的哈希策略。Cloudflare 配置 `assets.run_worker_first: ["/*", "!/assets/*", "!/og/*", "!/fonts/share-card/*"]` 与 `ASSETS` 绑定：HTML / 动态路由先返回已有预渲染内容，未命中再走 SSR，因此首页无需访问数据库也能携带安全头。`/assets/*` 的哈希 JS / CSS / 字体等直接由静态服务返回，省去 Worker 调用；`/og/*` 的构建 PNG 同样直出，使用 `_headers` 保留一天缓存、noindex 与 nosniff；`/fonts/share-card/*` 的分享卡片字体直出，长期缓存并带 noindex。其他路径继续经过 Worker；新增静态目录时应核对构建输出后显式添加排除规则。Node 在 Nitro HTTP 外层对静态响应使用同一策略。

上线步骤：

1. 本地 `pnpm build` 后，用浏览器检查预渲染首页、登录与已登录对话页的主题、水合、导航和 CSP 违规事件；保留结果到私有证据库，并在 PR 中引用。
2. 在 staging 检查真实 Turnstile、Stripe 结账跳转、对话流、R2 媒体预览及 Sentry 错误上报；按浏览器 `securitypolicyviolation` 事件 / 控制台定位策略外来源。当前未设置自动报告接收端，需主动收集浏览器事件。
3. 新增集成时只添加实际 origin，复测对应流程。Report-Only 无违规和功能验收通过后，再单独决定是否切换为强制 CSP；本次不切换。

## 7. 可观测性

| 维度 | 工具 |
|---|---|
| 错误 | Sentry（web + jobs，带 release 与 source map） |
| 日志 | Workers Logs（结构化 JSON，含 requestId、workspaceId、userId） |
| 流量 | Cloudflare Web Analytics；产品漏斗默认自建 Plausible，可选 PostHog，见 [埋点](analytics.md) |
| AI | AI Gateway 仪表盘 |
| 业务指标 | 管理后台：注册、付费转化、MRR、积分消耗、任务成功率 |
| 数据库 | pg_stat_statements、导出器指标、备份状态 |

Sentry 只在服务端启用，接入 web fetch 与 jobs fetch / Queue / Cron / Workflow；事件经统一
`beforeSend` 脱敏过滤器处理，不采集邮箱、Authorization、Cookie、支付凭据或 AI 对话内容。
事件 release 为完整部署 SHA，dist 为 `web` 或 `jobs`，request ID 标签用于关联 Workers Logs。
生产 web/jobs 在 Wrangler 的 `env.production.observability` 开启日志并设 `head_sampling_rate: 1`。

events 消费失败达到 6 次或出现不可重试错误时进入 `events-dlq`（线上分别为
`events-dlq-staging`、`events-dlq-production`）。jobs 通过 producer 绑定直接转投不可重试消息，
确认发送成功后才 ack；死信消费者复用 `job_engine.message` 与 `job_engine.dead_letter`，
持久化原消息 ID、原队列、尝试次数、失败原因与时间，再直接发送运营告警，避免告警再次进入失败队列。
邮件队列继续沿用现有丢弃策略。队列创建、数据库最小授权和上线清单见
[生产 runbook §7a](./runbooks/production-neon.md#7a-events-死信队列与上线清单)。
管理员测试异常入口需新鲜的实时平台管理员会话、同源 POST 与后台审计；没有公开测试入口。
本地真实事件与合并后 staging 可读堆栈的验收记录见 [Sentry runbook](./runbooks/sentry.md)，
staging 尚未通过前不勾选 OpenSpec 1.2。

