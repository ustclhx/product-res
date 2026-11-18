# Neon staging 操作与验收

为项目创建独立的 staging Neon Postgres 17，数据库 `product_res_staging`，角色 `migrator` / `app` / `readonly`；区域由项目负责人选择。Hyperdrive 使用非 pooled 直连与 TLS `sslmode=require`。资源名示例随生成器改名，资源 ID 必须使用本项目新建或明确复用的资源。


## 1. 建库、受限角色与本地凭据

在已登录的 Neon 控制台选择本项目组织、计划与区域，创建新项目（建议名 `product-res-staging`），Postgres 17；先以默认 owner 创建空数据库 `product_res_staging`。下面是**新项目**的初始化流程；不对已有项目盲目重建同名角色。已有资源覆盖、删除、账号/组织或付款/条款选择由用户决定。

### 受限角色的创建方式

Neon Console / CLI / API 创建的角色自动成为 `neon_superuser` 成员；受限业务角色应通过 SQL 创建并显式授权，见 [Neon 角色文档](https://neon.com/docs/manage/roles)。


### 新项目初始化

1. 通过受保护临时凭据，以默认 owner 直连新建的 `product_res_staging`，先核对 `current_user = neondb_owner`、`current_database() = product_res_staging`；确认三角色尚不存在。
2. SQL 创建三角色；密码以安全随机方式生成，按 [production-neon §2](production-neon.md#2-受限角色与凭据) 的 stdin/TLS 流程设置（Neon 不接受 psql `\password` 生成的 SCRAM 校验值），不把密码写进 SQL 文件、命令参数或历史。

```sql
CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT migrator TO neondb_owner;
ALTER DATABASE product_res_staging OWNER TO migrator;
REVOKE migrator FROM neondb_owner;
```

3. 以 `migrator` 重连目标库，按 §2 执行原权限脚本，令 public schema owner 与默认权限归属 migrator。核对三角色的高权限 flags 均为 false，且 `pg_has_role(rolname, 'neon_superuser', 'MEMBER')` 均为 false；不把 `neon_superuser` 设为数据库 owner。
4. 保存三个直连 URL 到被忽略的 `.env.staging-neon`（600、明文）。键名为 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`；必须是非 pooled 主机名（不能带 `-pooler`）、`sslmode=require`。先执行 `git check-ignore .env.staging-neon`，设置文件权限 600。复制后立即清空剪贴板，不用 echo 或 shell tracing；移除临时默认 owner URL。

```sh
set -a
. ./.env.staging-neon
set +a
# 引用已加载的变量，不把连接串真值写入命令历史或输出。
psql "$NEON_MIGRATOR_URL" -X -v ON_ERROR_STOP=1 \
  -c 'select current_user, current_database()'
```

只有返回 `migrator | product_res_staging` 后才执行写入。Neon 直连命令不得回退到本机同名 `product_res_staging` 或共享 `product_res_dev`；本地开发验证仍只连接当前 worktree 数据库。

## 2. 权限、迁移与 seed

不在 Neon 执行含本地密码的 `01-roles.sql`。以 migrator 执行现有权限脚本：

```sh
psql "$NEON_MIGRATOR_URL" -X -v ON_ERROR_STOP=1 \
  -f infra/local/initdb/02-db-grants.sql
psql "$NEON_MIGRATOR_URL" -X -c '\dn+ public'
MIGRATION_DATABASE_URL="$NEON_MIGRATOR_URL" pnpm --filter @product-res/db db:migrate
psql "$NEON_MIGRATOR_URL" -X \
  -c 'select count(*) from drizzle.__drizzle_migrations'
```

迁移记录数应等于 `packages/db/migrations/meta/_journal.json` 条目数。核对 public owner 为 migrator，app 只有 USAGE；用 app 分别在独立事务中尝试 `CREATE TABLE public.t(x int)` 与 `UPDATE audit_log SET id=id WHERE false`，用 readonly 在独立事务中尝试 `DELETE FROM plan WHERE false`，均应拒绝，最后 ROLLBACK。测试即使意外成功也不会留下表或更改审计记录。

若 Neon 拒绝权限语句，停止并核对角色来源、owner 与授权，由默认 owner 修复必要授权；不修改原 SQL 的本地/CI 行为。


确认 app 的 `current_database()` 为 `product_res_staging` 后：

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
psql "$NEON_APP_URL" -X -c 'select key from plan order by key'
```

应为 free / pro / team / credit_pack 四套餐，两次执行行数与 ID 不变；seed 不是平台价格同步，真实购买前按 [P2 支付联通](./p2-payment-integration.md) 同步测试报价。


## 3. Hyperdrive 与切换

先核对本项目已有资源名称与归属。创建 `product-res-staging-neon`（关闭缓存）与 `product-res-staging-neon-cached`（`max_age=60`），两者均连接 app、`product_res_staging`、非 pooled 直连与 TLS。通过已授权的 Cloudflare 控制台输入受保护连接；或使用请求体与授权头经 stdin 传入的 API 流程，连接串不进入 argv、输出或历史。回读仅记录资源 ID 与缓存配置，填入 web/jobs 的 `env.staging.hyperdrive`；缓存与非缓存绑定分别为 `HYPERDRIVE_CACHED` / `HYPERDRIVE`。


以下为获准手动发布时的参考；日常发布走 §4 流水线。先将 `STAGING_URL` 设为本项目的实际 HTTPS URL。

```sh
pnpm --filter @product-res/jobs deploy:staging
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @product-res/web deploy:staging
node scripts/staging/wait-healthy.mjs "${STAGING_URL:?先设置本项目 staging URL}/api/health" "$(git rev-parse HEAD)"
STAGING_URL="$STAGING_URL" pnpm --filter @product-res/web exec playwright test --project staging
```


健康检查应 HTTP 200、`db.status=up`、完整 SHA 匹配；按 `apps/jobs/wrangler.jsonc` 的实际 Cron 周期核对心跳推进及维护任务日志。锁与事务等关键数据库行为在本项目隔离环境验证，证据写入 `EVIDENCE_DIR`。

## 4. 配置与自动发布

```sh
pnpm staging:check-secrets
```

脚本按默认功能核对两个 Worker 的 secret 名称；关闭 OAuth/支付等功能时按 `template.config.ts` 与实际消费者解释缺项。必需项缺失退出 1，可选项缺失仍列出。web 必需 Auth、Turnstile、OAuth 四项、Stripe 两项、PayPal 三项；jobs 必需 Stripe 两项和 PayPal 三项。可选为 RESEND_API_KEY、AI_GATEWAY_TOKEN、SENTRY_DSN。真值只通过标准输入写 Wrangler，覆盖已有密钥需明确用户授权；Stripe 仅 Test mode，PayPal 仅 Sandbox，webhook 事件按 P2 runbook。


按所选功能创建私有 R2 文件桶 `product-res-files-staging`，CORS 仅允许本项目 staging URL；S3 token 限该桶对象读写。启用 Gateway 时创建本项目 Gateway、配置账号/Gateway vars，并经 stdin 写入 `AI_GATEWAY_TOKEN`。web/jobs 的绑定、桶名与 `R2_FILES_BUCKET` 保持一致；密钥仅进入受保护本地文件或目标 Worker。

GitHub environment `staging` 需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、STAGING_MIGRATION_DATABASE_URL。先只读验证 token 归属与资源权限，再配置并核对名称。CI token 权限按当前 workflow 使用的资源确定；参考权限为 Workers Scripts 编辑，Workers KV / Queues / Hyperdrive / Account Settings 读取；Workflows API 使用 Workers Scripts 权限；以当前平台控制台与部署操作所需权限为准。token 从控制台 Copy 后经剪贴板 stdin 写 `gh secret set`，立即清空；迁移 URL 只从忽略文件 stdin 传入。用 `gh secret list --env staging` 仅核对名称。

`deploy-staging.yml` 跟随 main 成功 CI，检出该次 head_sha；手动运行也限 main。environment 限制 secrets，PR CI 不引用它们。`staging-deploy` 串行且不取消：迁移 → jobs → web（完整 SHA）→ 3 分钟版本探活 → staging Chromium 冒烟。先把 workflow 的 `STAGING_URL` 与两个 Worker 的 `APP_URL` 改为本项目可访问 URL，核对所选功能的 secrets 与绑定。获准手动重发：

```sh
gh workflow run deploy-staging.yml --ref main
```


## 5. 空库重建与回滚

重建只用新的 Neon 分支/空数据库，先核对它仍叫 `product_res_staging`；删除/覆盖继承副本需用户明确授权。新分支通常继承角色与数据，必须核对三角色已受限且目标库确实为空；已存在角色时跳过 §1 的 CREATE ROLE，不盲目删角色或已有表。按 §1–2 完成 owner、权限、迁移与 seed 校验，验证迁移数及 seed 幂等一致；将新分支直连信息写受保护本地文件。验证完成后才决定是否切换 Hyperdrive，不自动删除分支。


回滚到本项目已验证的上一版本与绑定，按 jobs → web 发布并重新检查健康和心跳；必要时暂停自动发布，防止覆盖回滚。保留新库与资源，schema 迁移保持向前兼容；数据恢复见 [restore](restore.md)。不同数据库之间的数据迁移需要单独方案，不随应用回滚自动执行。

## 6. 运行观察与调度

按项目选择的观察窗口检查健康、完整 SHA、Cron 心跳、错误率与 Neon Usage；记录计算、存储与预算。`CRON_PROFILE=reduced` 的心跳核验按实际半小时周期；连续健康轮询本身会唤醒数据库，观察缩容时避免持续请求。费用与配额以项目当前计划为准。

