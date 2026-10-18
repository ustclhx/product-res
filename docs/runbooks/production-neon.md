# Neon production 操作与验收

> **实例状态（2026-10-18）**：用户确认拆除模板演示的生产实例与自托管测试实例。`product-res-production` Neon 项目及生产 Workers、KV、Queues、Hyperdrive、Turnstile、空文件桶和 GitHub `production` environment 已删除；备份开关变量 `PRODUCTION_BACKUP_SCHEDULE` 已删除。生产备份桶已解除 `retain-30d` 锁并设为所有对象 1 天后过期，待次日核空删除；Sentry Uptime 监控待用户手动删除。完整结果与手动收尾见[拆除记录](./evidence/teardown-2026-10-18.md)。下文为历史验收与派生项目操作参考，原资源 ID、凭据路径及已写入状态不代表仍可使用；`env.production` 与 workflow 保留，重新上线须创建项目自身资源和凭据。GitHub `production-backup` environment 本次未在删除范围内，仍保留。

本 runbook 对应 `add-cloud-production-neon`（2026-10-15 用户决定：Cloudflare 形态生产数据库使用 Neon 付费档，不自建 PG）。流程沿用 [staging-neon](./staging-neon.md) §1–2，本文只记录生产项目的事实与差异，不含任何凭据。

## 1. 项目（任务 1.1，2026-10-15）

| 项 | 值 |
|---|---|
| 组织 | `Haixin`（`org-ancient-mountain-81615147`），计划 **Launch**（用户 2026-10-15 升级） |
| 项目 | `product-res-production`（`super-resonance-99115167`），独立于 staging 项目 `product-res-staging` |
| 区域 / 版本 | `aws-us-west-2`（用户选定，与 staging 一致，沿用已验证的 Hyperdrive 锁探针结论）/ Postgres 17 |
| 默认分支 | `main`（`br-cold-morning-ar2z16iw`）；staging 默认分支名为 `production`，两者不要混淆 |
| 读写 endpoint | `ep-morning-resonance-arum7105`（非 pooled 主机名，不带 `-pooler`） |
| 数据库 | `product_res_production`，owner `migrator`；创建时默认 owner 为 `neondb_owner` |
| PITR 保留 | 7 天（创建时默认 1 天），见 §4 |
| 计算 | autoscaling 0.25–1 CU（创建时默认固定 1 CU），`suspend_timeout_seconds = 0`（平台默认 5 分钟缩容），见 §4 |

创建命令（`--no-secrets` 不在输出中打印密码）：

```sh
neonctl projects create --org-id org-ancient-mountain-81615147 --name product-res-production \
  --region-id aws-us-west-2 --pg-version 17 --database product_res_production --role neondb_owner \
  --no-secrets --output json
```

## 1a. 生产域名（任务 1.2，2026-10-15）

- 用户选定 production web 域名 **`app.ezarouter.cc`**；staging 保持 `web-staging.product-res-jobs.workers.dev`，不绑定自定义域名。
- Zone `ezarouter.cc`（`c6b12cacca002dc21f9b24370d4a5bd7`）在本 Cloudflare 账号 `170a06d3…` 下，`active`，Free Website 计划；NS 为 Cloudflare（`bingo` / `damien`）。apex 已在使用（Cloudflare 代理），不改动 apex 及其他记录。
- `app.ezarouter.cc` 公共 DNS（DoH `cloudflare-dns.com`）查询 A/AAAA/CNAME 均为 NXDOMAIN，未被占用。本机经代理的普通 `dig` 返回 `198.18.x.x`（fake-ip），不能作为依据。
- 绑定方式：web Worker `env.production` 的 Workers 自定义域名（`routes` 中 `custom_domain: true`），由 Cloudflare 自动建 DNS 记录与证书；存在同名 DNS 记录时绑定失败而不会覆盖。
- 权限：本机 wrangler OAuth 有 `zone (read)`、`workers_routes (write)`、`ssl_certs (write)`，无 DNS 读取权限（DNS records API 返回 Authentication error），实际绑定在 2.1 / 3.3 首次部署时验证。CI 使用的生产 Cloudflare API token（任务 1.4）须对 Zone `ezarouter.cc` 具备 Workers Routes 编辑权限，不能直接沿用只含账号级权限的 staging token。

域名确定后连带的配置（在对应任务中完成）：

| 用途 | 地址 / 动作 | 任务 |
|---|---|---|
| 应用 URL 与认证回调 | `APP_URL=https://app.ezarouter.cc`；Google / GitHub OAuth 生产应用回调登记该域名 | 2.1 / 2.2 |
| 邮件发件域 | 生产发件地址所用域名需在邮件服务商验证，并按其要求在 DNS 增加 SPF / DKIM 记录（需用户在控制台操作或授予 DNS 编辑权限） | 2.2 |
| Turnstile | 生产站点 hostname 加入 `app.ezarouter.cc` | 2.2 |
| 支付 webhook（Q9 后） | `https://app.ezarouter.cc/api/billing/webhooks/stripe`、`/paypal` | 6.1 |
| 只读冒烟 | Playwright `production` project 的 baseURL | 3.2 |

## 2. 受限角色与凭据

按 staging §1 以 **SQL** 创建 `migrator` / `app` / `readonly`（NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOREPLICATION、NOBYPASSRLS），`GRANT migrator TO neondb_owner` → `ALTER DATABASE product_res_production OWNER TO migrator` → `REVOKE migrator FROM neondb_owner`；再以 migrator 执行 `infra/local/initdb/02-db-grants.sql`。

**与 staging runbook 的差异——密码设置**：Neon 控制面拒绝预先计算的 SCRAM 校验值（`ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'` 返回 `Neon only supports being given plaintext passwords`），psql `\password` 同样在客户端加密，因此不可用。生产采用：脚本用 `crypto.randomBytes(32)` 生成 64 位十六进制密码，`ALTER ROLE ... PASSWORD '<明文>'` 只经 psql **stdin** 与 TLS 发送；连接参数通过 `PG*` 环境变量传入，连接串与密码不出现在命令参数、shell 历史或输出中。默认 owner 连接串由 `neonctl connection-string main --role-name neondb_owner` 取得后只在脚本内存中使用。

三个非 pooled 直连 URL（`sslmode=require`）保存在主 checkout 被忽略的 `.env.production-neon`（600），键名 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`。该文件只用于运维与恢复演练；CI 迁移凭据在任务 1.4 写入 GitHub `production` environment。

```sh
set -a; . ./.env.production-neon; set +a
psql "$NEON_MIGRATOR_URL" -X -c 'select current_user, current_database()'   # 应为 migrator | product_res_production
```

## 3. 验证结果（2026-10-15）

- 身份：owner、migrator、app、readonly 分别返回 `<角色> | product_res_production`。
- 数据库 owner 与 public schema owner 均为 `migrator`；public ACL 为 `{migrator=UC/migrator,app=U/migrator,readonly=U/migrator}`。
- 三角色 `rolsuper / rolcreatedb / rolcreaterole / rolreplication / rolbypassrls` 均为 false，`pg_has_role(rolname,'neon_superuser','MEMBER')` 均为 false。
- 拒绝验证（独立事务、ROLLBACK）：app `CREATE TABLE public.t` → `permission denied for schema public`；readonly `CREATE TABLE public.t` → 同上；app `CREATE SCHEMA` → `permission denied for database product_res_production`。
- 尚未迁移（0 张业务表）：app 修改 `audit_log`、readonly 写业务表的拒绝验证在首次生产发布（任务 3.3）迁移后执行，届时迁移记录数应等于 `packages/db/migrations/meta/_journal.json` 条目数。

## 4. 项目设置与费用（2026-10-15 用户按推荐配置确认）

用户在组织升级 Launch 后按以下推荐配置确认，已经 Neon API（`neonctl api ... -X PATCH`）修改并回读核对：

| 项 | 创建时默认 | 现值 |
|---|---|---|
| 生产 PITR 保留 | 1 天 | **7 天**（`history_retention_seconds = 604800`，Launch 上限） |
| 生产计算 | 固定 1 CU | **autoscaling 0.25–1 CU**（endpoint 与项目默认值），缩容沿用平台默认 5 分钟 |
| staging 计算上限 | 0.25–8 CU（升级后） | **0.25–2 CU**（两个 endpoint 与项目默认值） |

**费用依据**（[Neon 定价](https://neon.com/pricing)，2026-10-15 查询，Launch）：$0.106/CU-hour、$0.35/GB-月、PITR history $0.20/GB-月，每项目含 10 个分支与 500 GB 出流量，无月度最低消费。升级为组织级：同组织的 `product-res-staging` 与无关项目 `yingshu` 也按量计费，不再受 Free 的 100 CU-hours 上限保护。

**估算（每月，待 Usage 复核）**：生产首次发布前接近 $0；发布后默认 Cron 使 compute 基本常驻，0.25 CU 空闲约 183 CU-hours ≈ $20–25（固定 1 CU 时约 $77）；测试期生产使用 `CRON_PROFILE=reduced` 时约 33 CU-hours ≈ $4（见提案 2.1 / D7）；存储与 7 天 history 低于 $0.1；staging 约 $4，验收期另加 $1–3。

## 5. 逻辑备份存储与加密（任务 1.3，2026-10-15）

用户选定 R2。桶与规则由 wrangler 创建并回读核对：

| 项 | 值 |
|---|---|
| 桶 | `product-res-production-backups`（账号 `170a06d3…`，2026-10-15T08:57Z 创建），r2.dev 公开访问关闭 |
| Bucket Lock | `retain-30d`：全部前缀，对象写入后 30 天内不可删除或覆盖 |
| 生命周期 | `expire-35d`：全部前缀，35 天后过期（晚于锁定期，避免删除失败）；未完成分片 1 天后中止。另有平台默认规则：未完成分片 7 天后中止 |

保留策略：每日一份，约保留 35 份；锁定期内即使 R2 凭据泄露也无法删除已有备份。调整保留期时先改生命周期再改锁（生命周期天数始终大于锁定天数）。

加密：备份上传前用 age 公钥加密，私钥不进仓库与 CI。

- 公钥（`BACKUP_AGE_RECIPIENT`）：`age1e7a6xlm8rfj0skg8658qhk559prk6g6d4pcrtk0usl5g43e4c3fq3l3tve`
- 私钥：开发机 `~/.config/product-res/production-backup.agekey`（目录 700、文件 600），生成后已做一次加解密往返验证。**用户须另存两份离线副本**（如密码管理器 + 离线介质）；私钥丢失则所有备份不可解密，恢复演练（4.2）时验证离线副本可用。

## 6. GitHub environments（任务 1.4，2026-10-15）

| environment | 保护规则 | 允许的 ref | 用途 |
|---|---|---|---|
| `production` | 必需审批人 `ustclhx`，允许本人审批（`prevent_self_review=false`，单人仓库） | 仅 tag `v*` | 生产迁移与部署（3.1） |
| `production-backup` | 无审批（每日定时任务不能等待人工） | 仅分支 `main` | 每日逻辑备份（4.1） |

| environment | 名称 | 类型 | 状态 |
|---|---|---|---|
| production | `PRODUCTION_MIGRATION_DATABASE_URL` | secret | 已写入（Neon migrator 非 pooled 直连） |
| production | `CLOUDFLARE_ACCOUNT_ID` | secret | 已写入 |
| production | `CLOUDFLARE_API_TOKEN` | secret | 用户 2026-10-16 04:09Z 在真实终端重写（`product-res-production-deploy`：账号级 Workers Scripts / KV / R2 / Queues / Hyperdrive 编辑，Zone `ezarouter.cc` 的 Workers Routes 编辑与 Zone 读取） |
| production | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | secret | 待 5.2 |
| production-backup | `PRODUCTION_READONLY_DATABASE_URL` | secret | 已写入（Neon readonly 非 pooled 直连） |
| production-backup | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secret | 用户 2026-10-16 04:13Z 重写（`product-res-production-backups-rw`：Object Read & Write，仅限桶 `product-res-production-backups`） |
| production-backup | `BACKUP_BUCKET` / `BACKUP_AGE_RECIPIENT` / `R2_ACCOUNT_ID` | variable | 已写入（非机密） |

secret 均经 stdin 写入（无末尾换行），不出现在命令参数或输出中。仓库级 secrets 为空，生产值只存在于上述两个 environment；PR 与 `deploy-staging.yml`（environment `staging`）的作业无法读取。

用户自行写入时须在**真实终端**执行 `gh secret set <NAME> --env <environment>`（交互提示、输入不回显），或从 600 权限文件经 stdin 写入（`gh secret set <NAME> --env <environment> < <文件>`）。**不要**在 Claude Code 提示符用 `!` 执行不带输入的 `gh secret set`：该模式没有 TTY，gh 会把空值写成 secret（2026-10-15 实际发生，`CLOUDFLARE_API_TOKEN` 与 `R2_ACCESS_KEY_ID` 被写为空，需重写）。写入前应先用只读 API 验证凭据（token verify、Zone 与资源读取、R2 列桶 HTTP 200）。

wrangler 无法创建 API token（无对应命令，OAuth 可选范围不含 API Tokens 权限，其登录令牌短期有效且绑定本机），R2 S3 密钥同样派生自 API token；首个凭据必须在控制台创建。

## 7. 发布与回滚（任务 3.1 / 3.2）

- 发布：对已合并到 main 且 `Deploy staging` 成功的提交创建并推送 `v*` tag。`deploy-production.yml` 先运行 `scripts/production/check-release.mjs`，校验提交在 main 上且该完整 SHA 有成功的 staging 发布；再进入 `production` environment 等待审批。批准后依次迁移、部署 jobs、部署 web、等待 `https://app.ezarouter.cc/api/health` 返回完整 SHA，最后运行只读冒烟（`playwright test --project production`，仅 GET）。
- 回滚：`gh workflow run deploy-production.yml --ref <上一个 tag>`，同样需要审批。只回退 Worker 版本，不回滚 schema；迁移须保持向前兼容，破坏性迁移单独评审。数据问题按恢复 runbook 处理。
- 生产 Sentry secrets 未配置（5.2 前）时，流水线跳过 source map 上传并给出 warning，仍删除客户端 map。
- 本地对任意环境试跑只读冒烟：`PRODUCTION_URL=<URL> pnpm --filter @product-res/web exec playwright test --project production`。

## 8. 生产写操作清单（2026-10-15 起草；A、B 已获用户批准并执行）

### 执行记录（2026-10-15）

- **A 已执行**：`neondb_owner` 执行 `GRANT pg_read_all_data TO readonly`；回读 `pg_has_role('readonly','pg_read_all_data')` 由 f 变 t，readonly 高权限 flags 与 neon_superuser 成员身份仍均为 false；readonly 以 PG17 容器 `pg_dump` 成功（空库 1159 字节），`CREATE TABLE` 仍被拒绝。
- **B 已执行**（名称冲突预检通过后创建）：

  | 资源 | 名称 | ID / 状态 |
  |---|---|---|
  | KV | `product-res-production-cache` | `76d4f2b69b1a45db8fe1c0a66eaf9b34` |
  | R2 | `files-production` | 已建；CORS 仅 `https://app.ezarouter.cc`、PUT/GET/HEAD；r2.dev 关闭 |
  | Queues | `email-production` / `events-production` | 已建 |
  | Hyperdrive | `product-res-production-neon` | `0519ee8f8e5b4f0f95ecd9d425c58a36`（缓存关闭） |
  | Hyperdrive | `product-res-production-neon-cached` | `3deaa579109549f9a06f12b6c8d4aae6`（缓存开启，默认 max_age） |

  Hyperdrive 经 Cloudflare API 创建：请求体与授权头均经 stdin，连接串不进命令参数或输出；缓存设置回读 staging 两个配置后照搬；创建时 Hyperdrive 已实际连通 `product_res_production`（app，非 pooled）。Workflow `ai-media-production` 与两个 Worker 随首次发布（3.3）创建。
- **构建验证**：jobs `wrangler deploy --env production --dry-run` 全部绑定指向上述资源；web 生产构建在预渲染阶段因 `env.invalid missing TURNSTILE_SITE_KEY` 失败（模板启用 Turnstile，站点 key 为构建期必需 var）。用户批准后经 Cloudflare API（wrangler OAuth 的 `challengewidgets.write`）新建 Turnstile 站点 `product-res-production`：managed 模式、仅允许 `app.ezarouter.cc`，站点 key `0x4AAAAAAFXeXLLV-NITAkGX` 写入 web `env.production.vars`；密钥未输出，存于开发机 `~/.config/product-res/turnstile-production.secret`（600），在 2.2 写为 web secret `TURNSTILE_SECRET_KEY`。复验后 web 生产构建（预渲染无 `env.invalid`）与部署 dry-run 通过。不使用始终通过的测试 key；生成器会清空 `0x` 开头的真实站点 key，新项目须自行配置。

按 deploy-cloudflare 技能「写入前确认动作清单」，以下操作会在 Cloudflare 账号或生产库产生真实资源 / 权限变更，批准后由协调者执行并回读核对。名称与 staging 一一对应。

**A. 生产库权限（4.1 前置）**——以 `neondb_owner` 执行一次：

```sql
GRANT pg_read_all_data TO readonly;
```

原因：`readonly` 只在 public 有权限，`pg_dump` 读 `drizzle.__drizzle_migrations` 时报 `permission denied for schema drizzle`。`pg_read_all_data`（PG14+ 内置）可读全部 schema 与序列，仍不能写；本地临时角色已验证（见 [restore §6](./restore.md)）。

**B. Cloudflare 资源（2.1）**——本机 wrangler OAuth 已有对应写权限：

| staging | production（新建） | 说明 |
|---|---|---|
| Hyperdrive `product-res-staging-neon` / `-cached` | `product-res-production-neon` / `product-res-production-neon-cached` | 指向 `product_res_production` 的 app 非 pooled 直连，`sslmode=require`；缓存版沿用默认 max_age |
| KV `CACHE` | 新 KV namespace `product-res-production-cache` | web 与 jobs 共用 |
| R2 `files-staging` | `files-production` + CORS（origin `https://app.ezarouter.cc`，PUT/GET/HEAD，同 `scripts/staging/files-cors.json`） | 用户文件；与备份桶 `product-res-production-backups` 分开 |
| Queues `email-staging` / `events-staging` | `email-production` / `events-production` | 消费者参数同 staging |
| Workflow `ai-media-staging` | `ai-media-production`（随 jobs 部署创建） | web 经 `script_name: jobs-production` 调用 |
| 限流 namespace 1002/1004/1006 | 1007/1008/1009 | 与 staging、本地不共享计数 |
| Worker `web-staging` / `jobs-staging` | `web-production` / `jobs-production`（首次发布 3.3 创建） | web 绑定自定义域名 `app.ezarouter.cc` |

vars：`SENTRY_ENVIRONMENT=production`、`APP_URL=https://app.ezarouter.cc`，**不设** `PAYMENT_MODE`（Q9 前支付关闭），jobs 测试期 `CRON_PROFILE=reduced`（开放注册前改回默认，D7）。资源创建后把 ID 写入两个 `wrangler.jsonc` 的 `env.production`，以 `wrangler deploy --dry-run --env production` 与绑定名一致性检查验证（2.1）。

**C. 生产 Worker secrets（2.2）**——名称同 `scripts/staging/check-secrets.mjs` 的 web / jobs 清单（支付类除外），值需用户提供或新生成（如 `BETTER_AUTH_SECRET` 新随机值，OAuth / Turnstile 需为 `app.ezarouter.cc` 新建生产应用）。

## 9. 生产 Worker secrets（任务 2.2，2026-10-16 核对名称）

用户在真实终端写入；协调者以 `wrangler secret list --name <worker>` 只核对名称（不读值）。值的正确性在首次发布（3.3）时以健康检查、注册邮件与登录实际验证。

| Worker | secrets | 来源 |
|---|---|---|
| `web-production` | `BETTER_AUTH_SECRET` | 本地随机生成，未留存 |
| | `TURNSTILE_SECRET_KEY` | Turnstile 站点 `product-res-production`（开发机 `~/.config/product-res/turnstile-production.secret`） |
| | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 生产 OAuth 客户端，回调 `https://app.ezarouter.cc/api/auth/callback/google` |
| | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub 生产 OAuth App，回调 `https://app.ezarouter.cc/api/auth/callback/github` |
| | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 token，仅 `files-production`（与备份 token 分开） |
| | `DEEPSEEK_API_KEY` | 生产文本 AI 直连（未配 AI Gateway） |
| | `FAL_KEY`、`MEDIA_WEBHOOK_SECRET` | 与 jobs 相同值（媒体回调 HMAC 需一致） |
| `jobs-production` | `RESEND_API_KEY` | Resend 发信 key，域名 `ezarouter.cc` |
| | `EMAIL_TRANSPORT`（`resend`）、`EMAIL_FROM`（`EzaRouter <noreply@ezarouter.cc>`） | 用户以 **secret** 写入；运行时与 var 等效。**不要**再在 `wrangler.jsonc` 中声明同名 var，否则部署时绑定名冲突 |
| | `FAL_KEY`、`MEDIA_WEBHOOK_SECRET` | 与 web 相同 |

未配置（可选）：`SENTRY_DSN`（两端，5.2）、`BOOTSTRAP_ADMIN_EMAILS`（web；无管理员则无法在生产后台创建模型与套餐授权，首次发布前建议配置）、`EMAIL_REPLY_TO`。支付 secrets 待 Q9（6.1）。

Resend 域名记录（DoH 核对）：`resend._domainkey.ezarouter.cc` TXT 存在；`send.ezarouter.cc` 的 MX 与 SPF TXT 存在（经 CNAME `send.forge.rmta.net`）；`_dmarc.ezarouter.cc` 未配置（建议补 `v=DMARC1; p=none;` 以提升送达率）。域名验证状态以 Resend 控制台 Verified 为准。
