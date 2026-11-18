# Neon production 操作与验收

生产使用独立于 staging 的 Neon 项目与数据库，计划、区域、备份保留期和预算由项目负责人选择。先完成 [staging-neon](staging-neon.md) §1–2 的建库与受限角色流程，再按本文配置生产资源、备份与发布门。示例资源名由生成器改为本项目名称；资源 ID、账号、域名与凭据由项目自身配置。


## 1. 项目

核对组织与区域，创建独立项目 `product-res-production`、Postgres 17、数据库 `product_res_production`；确认默认分支与非 pooled endpoint，不从 staging 复制资源 ID 或凭据。以下参数先由项目负责人选择，`--no-secrets` 避免输出密码：

```sh
neonctl projects create --org-id "${NEON_ORG_ID:?选择本项目组织}" --name product-res-production \
  --region-id "${NEON_REGION_ID:?选择本项目区域}" --pg-version 17 \
  --database product_res_production --role neondb_owner --no-secrets --output json
```

核对项目与默认分支归属，将 endpoint、数据库 owner、PITR 与计算配置记入本项目私有运维记录。


## 1a. 生产域名

核对本项目生产域名的 Zone、DNS 占用、账户权限及 TLS。web `env.production.routes` 使用 `custom_domain: true`，`APP_URL` 与实际 HTTPS 域名一致；已有同名 DNS 记录先核对用途，不直接覆盖。CI token 需有目标 Zone 的 Workers Routes 权限及实际资源所需账号权限。

域名同时用于 Google/GitHub OAuth 回调 `/api/auth/callback/<provider>`、Turnstile 允许的 hostname、支付 webhook `/api/billing/webhooks/<provider>`、生产只读冒烟 URL 与文件桶 CORS。邮件发件域在服务商验证，按要求设置 SPF/DKIM 等 DNS 记录。staging 使用独立 URL 与测试凭据。


## 2. 受限角色与凭据

按 [staging-neon §1](staging-neon.md#1-建库受限角色与本地凭据) 以 **SQL** 创建 `migrator` / `app` / `readonly`（NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOREPLICATION、NOBYPASSRLS），`GRANT migrator TO neondb_owner` → `ALTER DATABASE product_res_production OWNER TO migrator` → `REVOKE migrator FROM neondb_owner`；再以 migrator 执行 `infra/local/initdb/02-db-grants.sql`。

**Neon 密码设置**：Neon 控制面拒绝预先计算的 SCRAM 校验值（`ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'` 返回 `Neon only supports being given plaintext passwords`），psql `\password` 同样在客户端加密，因此不可用。设置方式：脚本用 `crypto.randomBytes(32)` 生成 64 位十六进制密码，`ALTER ROLE ... PASSWORD '<明文>'` 只经 psql **stdin** 与 TLS 发送；连接参数通过 `PG*` 环境变量传入，连接串与密码不出现在命令参数、shell 历史或输出中。默认 owner 连接串由 `neonctl connection-string main --role-name neondb_owner` 取得后只在脚本内存中使用。

三个非 pooled 直连 URL（`sslmode=require`）保存在当前 checkout 被忽略的 `.env.production-neon`（600），键名 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`。该文件只用于运维与恢复演练；CI 迁移凭据按 §6 写入 GitHub `production` environment。

```sh
set -a; . ./.env.production-neon; set +a
psql "$NEON_MIGRATOR_URL" -X -c 'select current_user, current_database()'   # 应为 migrator | product_res_production
```

## 3. 权限与迁移验证

按 [staging-neon §2](staging-neon.md#2-权限迁移与-seed) 执行 `infra/local/initdb/02-db-grants.sql` 与迁移。核对数据库和 public schema owner 均为 migrator，app/readonly 只有预期权限，三角色高权限 flags 与 `neon_superuser` 成员身份均为 false。

迁移记录数应等于 journal 条目数。app 建表、修改审计日志与 readonly 写业务表均应被拒绝；每次权限探测使用独立事务并 ROLLBACK。billing 启用时仅在确认目标库、角色和支付模式后 seed / sync；验证完成不自动接入 live 支付。


## 4. 项目设置与预算

按恢复目标选择 PITR 保留期、计算上下限与缩容策略，核对当前计划支持范围和组织内其他项目的计费影响。价格与配额以当前平台计划为准。

### 上线前成本基线（必须遵循）

没有真实用户时，数据库应能缩容到零。某项目（2026-11）曾因固定 1 CU 加五分钟 Cron 全天常驻，算力约 $76/月；按本基线用同期流量模拟约 $9/月。

1. **算力**：创建项目后立即把 endpoint 与项目默认值都改为 0.25–1 CU（新建项目可能默认固定 1 CU），`suspend_timeout_seconds` 保持 0（平台默认 5 分钟）；staging 上限不超过 2 CU。
2. **Cron**：开放支付或有真实用户依赖定时任务之前，production 使用 `CRON_PROFILE=reduced`（半小时）。五分钟心跳等于五分钟缩容窗口，数据库永远停不下来。恢复时显式写 `CRON_PROFILE=default` 并同步 `triggers.crons`；`scripts/production/check-wrangler-envs.mjs` 校验两者一致。
3. **扫描流量**：匿名请求的 404 也走 SSR 并读设置，所以每个生产 zone 都配一条 Cloudflare WAF 自定义规则（Block）拦截扫描路径，请求到不了 Worker：

   ```
   (lower(http.request.uri.path) contains "/wp-"
    or lower(http.request.uri.path) contains "wlwmanifest"
    or lower(http.request.uri.path) contains "xmlrpc"
    or ends_with(lower(http.request.uri.path), ".php")
    or lower(http.request.uri.path) contains "/.env"
    or lower(http.request.uri.path) contains "/.git")
   and not cf.client.bot
   ```

   只按路径拦截。不要按 User-Agent 或机房 IP 封禁，也不要开启 Bot Fight Mode、Block AI bots，否则会误伤搜索引擎和大模型爬虫。配置后确认首页、博客与 `robots.txt` 仍返回 200。
4. **轮询**：`/api/health` 每次都查库，只用于发布验证和低频人工检查，不接高频外部监控，也不让 agent 循环调用。验收结束关闭后台页面，已登录页面的轮询同样会让数据库常驻。前端新增轮询必须在 `document.hidden` 时暂停（参照通知与公告横幅）；间隔不长于设置 KV 缓存 TTL（60 秒）的轮询每次都会穿透到数据库。2026-11 product-res-staging 曾因四个遗忘的后台标签页每分钟读公告而全天常驻（约 6 CU-h/天）。
5. **复核**：发布后一周内查看 Neon Usage；运行时长接近 24 小时/天时，先查清是谁在唤醒，再考虑调整配置。


## 5. 逻辑备份存储与加密

创建与用户文件桶分离的私有备份桶，关闭公开访问：

```sh
pnpm --dir apps/web exec wrangler r2 bucket create product-res-production-backups
```

在 R2 配置并回读保留策略，例如 Bucket Lock `retain-30d`（全部前缀，30 天不可删除/覆盖）、生命周期 `expire-35d`（35 天过期，晚于锁定期）、中止未完成分片。保留期按项目恢复目标确认，调整时保持生命周期晚于锁定期。备份 S3 token 仅授权此桶对象读写，与文件桶 token 分开。

生成本项目独立 age 密钥，私钥目录 700、文件 600，私钥不进入仓库或 CI：

```sh
install -d -m 700 "$HOME/.config/product-res"
(umask 077; age-keygen -o "$HOME/.config/product-res/production-backup.agekey")
age-keygen -y "$HOME/.config/product-res/production-backup.agekey"
```

仅将最后命令输出的公钥写入 `BACKUP_AGE_RECIPIENT`，私钥保存两份离线副本；验证一次加解密往返和离线副本恢复。备份上传前 age 加密，数据库只读角色授权见 §8；备份/恢复脚本与演练见 [restore](restore.md)。


## 6. GitHub environments

| environment | 保护与允许的 ref | 配置 |
|---|---|---|
| `production` | 项目负责人审批，允许 tag `v*` 与分支 `main`（手动入口）；按团队情况设置审批人与自审策略 | secrets：`PRODUCTION_MIGRATION_DATABASE_URL`（migrator 非 pooled TLS）、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`；live 阶段另需 `SENTRY_DSN`、`SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT` |
| `production-backup` | 仅分支 `main`，定时备份不等待交互审批 | secrets：`PRODUCTION_READONLY_DATABASE_URL`（readonly 非 pooled TLS）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；variables：`BACKUP_BUCKET=product-res-production-backups`、`BACKUP_AGE_RECIPIENT`、`R2_ACCOUNT_ID` |

`backup-production.yml` 还由仓库 variable `PRODUCTION_BACKUP_SCHEDULE=true` 控制定时运行，完成首份备份与恢复演练后再启用。`BACKUP_BUCKET` 为备份桶，不是用户文件桶。

Cloudflare token 按实际部署资源配置账号权限和目标 Zone 的 Workers Routes 权限。先只读验证 token 归属、资源访问与 R2 列桶，再写入 environment；首个 API token / R2 S3 凭据由用户在平台控制台创建。

只在真实终端交互执行 `gh secret set <NAME> --env <environment>`，或从权限 600 文件经 stdin 写入 `gh secret set <NAME> --env <environment> < <文件>`；自动化调用必须提供非空 stdin，真值不进入 argv、输出或历史。用 `gh secret list --env <environment>` 只核对名称。生产 secrets 不放仓库级；PR CI 与 staging 作业使用各自 environment。


## 7. 发布与回滚

仓库变量 `RELEASE_PHASE` 仅取 `testing` 或 `live`，未设置按 `live`。测试阶段可以绕过 CI；正式上线后只有紧急修复可绕过。CI 必须是本仓库 `main` 分支上同一完整 SHA 的成功 `CI` push 运行，PR 检查不算。生产始终要求目标 tag 的提交在 main 历史上、已成功发布 staging，并经 `production` environment 审批；这些条件不能绕过。

正常发布：对已验证的提交推送 `v*` tag。批准后依次构建 jobs/web、上传 source map、迁移、部署 jobs、部署 web、校验 `/api/health` 完整 SHA，最后执行只读 Playwright 冒烟。两个构建产物保留在同一 job，构建失败不会触及数据库。live 阶段缺少 `SENTRY_DSN` 或 source map 上传配置会在迁移前失败；testing 只发 warning 并写摘要。GitHub production DSN 用于发布门禁，web/jobs 的运行时 `SENTRY_DSN` secrets 也必须分别配置，发布门禁不代替实际事件验收。

手动操作从 **main 的当前工作流** 运行并指定目标 tag，避免旧 tag 自带的旧工作流缺少新检查。`production` environment 的 deployment branches/tags 需同时允许 `main` 与 `v*`，保留必需审批人。维护者应先确认目标 tag 与摘要中的解析 SHA 一致。

```sh
# 普通手动重发 / 回滚，仍需 CI、staging 与审批
gh workflow run deploy-production.yml --ref main -f tag=vX.Y.Z
# 紧急修复：先部署同一 main SHA 到 staging，生产仍需审批
gh workflow run deploy-staging.yml --ref main -f bypass=hotfix -f reason='修复正在发生的生产故障，关联事件编号'
gh workflow run deploy-production.yml --ref main -f tag=vX.Y.Z -f bypass=hotfix -f reason='修复正在发生的生产故障，关联事件编号'
```

每次 CI 绕过都有 `::warning` 和 Job Summary，记录 `testing` 或 `hotfix` 类型、原因及 `github.actor`。testing 未填写原因时摘要会使用测试阶段说明；live 的 hotfix 原因必须非空。不得把 testing 长期当作上线后的发布通道。

回滚 dispatch 读取当前生产 `/api/health.version`，比较当前版本与目标 tag 的迁移文件。每条新增迁移必须在**当前生产提交**中有 `-- rollback-safe: <具体原因>`，否则部署前失败并改为向前修复。只新增表、可空列等且旧代码仍兼容时才能标注；删除/改名字段、增加旧写入无法满足的非空约束等不得标注。旧生产提交未带声明时会保守阻止跨迁移回滚；后来补注释不会追溯改变旧提交。历史 `0003`（变更约束）、`0004`（原非空列可为 null）与 `0009`（撤销权限）未声明安全，禁止自动跨越。该检查只允许回退 Worker，schema 与数据不回退；数据恢复按 [restore](restore.md)。

staging/production 共用 `node scripts/production/migrate.mjs`，连接启动参数强制 `lock_timeout=5s`、`statement_timeout=15min`，避免等锁长期阻塞。CI 以固定版本 `squawk-cli@2.67.0` 检查相对 base 新增的迁移，危险 SQL 会阻断 PR。依赖来源核对为 [sbdchd/squawk 官方仓库](https://github.com/sbdchd/squawk) 的 [npm 包 squawk-cli](https://www.npmjs.com/package/squawk-cli)，该版本 publisher 为 `sbdchd`，maintainers 为 `sbdchd` / `cdignam`。例外按 [原生 ignore 语法](https://squawkhq.com/docs/cli/) 在同一行写原因，例如下列空表上的已评审索引；迁移在事务内执行，`CONCURRENTLY` 需要另行规划，不盲目照搬建议。不要为回滚执行反向 SQL。

```sql
SET lock_timeout = '5s';
SET statement_timeout = '15min';
-- squawk-ignore require-concurrent-index-creation -- reason: table is empty before first deployment
CREATE INDEX example_idx ON example_table (id);
```

本地只读冒烟：`PRODUCTION_URL=<URL> pnpm --filter @product-res/web exec playwright test --project production`。

## 7a. events 死信队列与上线清单

合并后由协调者在确认 Cloudflare 账号后创建两个独立队列，资源名称必须与 jobs 的对应 Wrangler 环境一致；此步骤不由 worker 执行。Queues 的死信配置放在原队列 consumer 上，详见 [Cloudflare 死信队列文档](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)。

```sh
pnpm --dir apps/jobs exec wrangler queues create product-res-events-dlq-staging --env staging
pnpm --dir apps/jobs exec wrangler queues create product-res-events-dlq-production --env production
```

随后部署 jobs，使 `apps/jobs/wrangler.jsonc` 中 staging 与 production 的 events 队列的 `dead_letter_queue` 与 `EVENTS_DLQ` producer、死信 consumer 同时生效。认证邮件不加 DLQ。不可重试和达到尝试上限的错误用信封保留真实错误、原队列、原 ID 与失败时间，投递成功后确认原消息；原生 DLQ 同时保留意外消费者失败的落点。死信落库或告警失败时继续重试，运营告警直接发渠道，避免循环进入 events。

Cloudflare 过去只授权 public schema；复用 job-engine 死信表前，在 staging/production 各以 migrator 对已迁移的目标库授予最小权限（不调用 Node/DBOS 迁移，也不授予 app DDL）：

```sql
GRANT USAGE ON SCHEMA job_engine TO app;
GRANT SELECT, INSERT ON job_engine.queue, job_engine.message, job_engine.dead_letter TO app;
```

上线前逐项核对：

- 两个 DLQ 已创建，jobs consumer 与 producer 指向各自环境；生产两个 Worker 的日志开启且采样率为 1。
- app 可以幂等写入死信表，死信记录包含原 ID、原队列、尝试次数、原因、时间，运营渠道收到测试告警。
- production environment 允许 main 手动入口与 v* tag，保留审批；Sentry DSN 两端绑定、GitHub 上传配置及真实事件均已验收。
- 新迁移已由协调者生成、审阅 squawk 结果并判断 rollback-safe；两环境迁移入口的锁超时验证通过。
- **把仓库变量 `RELEASE_PHASE` 改为 `live`**，回读确认；普通手动发布不能绕过 CI，hotfix 必须有原因且摘要保留触发人。

## 8. 生产写操作清单


按 deploy-cloudflare 技能「写入前确认动作清单」，以下操作会在 Cloudflare 账号或生产库产生真实资源 / 权限变更，批准后由协调者执行并回读核对。名称与 staging 一一对应。

**A. 生产库备份权限**——以 `neondb_owner` 执行一次：

```sql
GRANT pg_read_all_data TO readonly;
```

原因：`readonly` 只在 public 有权限，`pg_dump` 读 `drizzle.__drizzle_migrations` 时报 `permission denied for schema drizzle`。`pg_read_all_data`（PG14+ 内置）可读全部 schema 与序列，仍不能写；权限与恢复演练说明（见 [restore §6](./restore.md)）。

**B. Cloudflare 资源**——先核对当前登录身份与写权限：

| staging | production（新建） | 说明 |
|---|---|---|
| Hyperdrive `product-res-staging-neon` / `-cached` | `product-res-production-neon` / `product-res-production-neon-cached` | 指向 `product_res_production` 的 app 非 pooled 直连，`sslmode=require`；缓存版沿用默认 max_age |
| KV `CACHE` | 新 KV namespace `product-res-production-cache` | web 与 jobs 共用 |
| R2 `product-res-files-staging` | `product-res-files-production` + CORS（origin 为本项目生产 `APP_URL`，PUT/GET/HEAD，同 `scripts/staging/files-cors.json`） | 用户文件；与备份桶 `product-res-production-backups` 分开 |
| Queues `product-res-email-staging` / `product-res-events-staging` | `product-res-email-production` / `product-res-events-production` | 消费者参数同 staging |
| Workflow `product-res-ai-media-staging` | `product-res-ai-media-production`（随 jobs 部署创建） | web 经 `script_name: product-res-jobs-production` 调用 |
| 限流 namespace | 为本项目环境分配三个独立整数 | 与 staging、本地不共享计数 |
| Worker `product-res-web-staging` / `product-res-jobs-staging` | `product-res-web-production` / `product-res-jobs-production`（首次发布创建） | web 绑定自定义域名为本项目生产域名 |

vars：`SENTRY_ENVIRONMENT=production`、`APP_URL`（本项目生产 HTTPS URL），按已确认的支付模式配置 `PAYMENT_MODE`（未接入 live 前关闭生产支付），jobs 的 `CRON_PROFILE` 按本项目调度需求选择。资源创建后把 ID 写入两个 `wrangler.jsonc` 的 `env.production`，以 `wrangler deploy --dry-run --env production` 与绑定名一致性检查验证。

**C. 生产 Worker secrets**——名称同 `scripts/staging/check-secrets.mjs` 的 web / jobs 清单（支付类除外），值需用户提供或新生成（如 `BETTER_AUTH_SECRET` 新随机值，OAuth / Turnstile 需为本项目生产域名新建生产应用）。

## 9. 生产 Worker secrets

按功能开关与实际两端消费者建立清单，写入前核对目标 Worker/environment。值由用户提供或安全生成，真值经交互或 stdin 写入；仅用 `wrangler secret list --env production` 核对名称。

| Worker | secrets 与来源 |
|---|---|
| `product-res-web-production` | 独立随机 `BETTER_AUTH_SECRET`；所选 OAuth 的生产 client ID/secret；本项目 Turnstile secret；可选 `BOOTSTRAP_ADMIN_EMAILS` |
| web / jobs 按消费者配置 | 文件桶的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`；AI Gateway token 或直连 Provider key；媒体 `FAL_KEY` / `MEDIA_WEBHOOK_SECRET`（两端共享值）；可选 `SENTRY_DSN` |
| `product-res-jobs-production` | 已验证发件域的 `RESEND_API_KEY`、`EMAIL_TRANSPORT` / `EMAIL_FROM`；支付与媒体功能所需 secrets |

OAuth 回调使用 §1a 的生产域名。文件与备份 R2 token 分开；同一绑定名只声明为 secret 或 var 之一。支付 secrets 仅在确认 live 账户、webhook 与生产支付清单后配置，详见 [支付联通](p2-payment-integration.md)。邮件 DNS 与服务商 Verified 状态需独立核验。

```sh
pnpm --dir apps/web exec wrangler secret put <SECRET_NAME> --env production
pnpm --dir apps/jobs exec wrangler secret put <SECRET_NAME> --env production
pnpm --dir apps/web exec wrangler secret list --env production
pnpm --dir apps/jobs exec wrangler secret list --env production
```

首次发布前完成 secret 名称、构建与绑定检查；值的有效性通过健康、注册邮件、OAuth 登录与所启功能验证。

