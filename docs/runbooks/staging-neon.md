# Neon staging 操作与验收

本 runbook 对应 `add-cloud-staging-neon`。staging 专用 Neon Postgres 17（`aws-us-west-2`），数据库 `product_res_staging`，角色 `migrator` / `app` / `readonly`；Hyperdrive 使用非 pooled 直连，TLS `sslmode=require`。不搬迁本机旧 staging 数据，不改变本地 worktree 或阶段二生产方案。

## 当前进度与证据（2026-10-09 UTC）

**main 已自动发布到 Neon staging，迁移、jobs → web、完整版本探活与注册冒烟均通过。** 当前线上代码为 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`。Neon change 最终完成 28/29，仅24 小时观察（9.2）保持未完成；新旧数据库是独立数据集。本 PR 3 仅更新文档与任务记录，配置已随 PR #62 合入 main。

- 前置 HTTP/2 PR [#61](https://github.com/ustclhx/product-res/pull/61) 已合并；compose 命令包含 `--protocol http2` 已验证。
- PR 2 [#62](https://github.com/ustclhx/product-res/pull/62) 已 squash 合并为 `ad1b5dafce6d3007c9409e0e0e9032437474eb7a`，包含 Neon Hyperdrive 绑定、AI Gateway vars 与 staging observability 配置；历史任务记录提交 `a876735` 的 CI run `37882993185` 已全部通过。随后 [#64](https://github.com/ustclhx/product-res/pull/64) 已 squash 合并为当前 main `ce623cab63a99d6eee8c8ba67eeb09e564f97779`，修复 CI web 预渲染的本地 Hyperdrive 配置。
- PR #62 合并后的初次自动发布 [run 37892016841](https://github.com/ustclhx/product-res/actions/runs/37892016841) 在 Deploy web 预渲染阶段失败，不能记录为成功。PR #64 仅在 Deploy web step 设置两个 local Hyperdrive 占位连接变量，目标不可达且不是真实数据库；构建沿用已有 pricing fallback 示例套餐。线上 Hyperdrive 绑定与迁移目标保持 Neon。
- 成功的自动发布 [run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572) 为 `completed / success`，head SHA 为 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`，时间 2026-10-09 06:36:31–06:38:28 UTC。迁移 06:37:12–14 → jobs 06:37:14–21 → web 06:37:21–43 → 版本探活 06:37:43–45 → 冒烟 06:38:13–23，全部 success；探活要求 200、db.up 与完整 SHA 匹配，三个原始冒烟用例 3 passed（10.0 秒），任务 7.4 通过。
- 自动部署日志记录 jobs Worker version `38ec01c5-8ced-4173-b478-e2e4f1dc9139`（06:37:21.5132201 UTC），web `7281e552-88c9-4c40-bfb9-b3ae0c69c83d`（06:37:43.8174925 UTC）。2026-10-09 06:41:05.684100 UTC 的独立健康观测为 status ok、db.up、version 与上述完整 SHA 一致；`jobs.lastCronAt = 2026-10-09T06:40:35.438Z`，晚于自动部署。脱敏证据汇总为 `/tmp/cloud-staging-neon-pr3-auto-evidence.json`。以下手动部署 SHA / Worker version 均为历史记录。
- Neon 项目 `product-res-staging`（`ancient-hill-97648731`），分支 `production`（`br-royal-band-aklc7axw`），已确认 Free、Postgres 17、`aws-us-west-2`。数据库 `product_res_staging` 与 public schema owner 均为 `migrator`。
- SQL 重建后的三角色均无 CREATEDB / CREATEROLE / BYPASSRLS / REPLICATION，且无 `neon_superuser` 成员身份。`migrator` 完整执行未经修改的 `infra/local/initdb/02-db-grants.sql`；app 在 public 有 USAGE、无 CREATE。
- psql 复核返回 `migrator | product_res_staging`，`\dn+ public` 显示 owner migrator、app/readonly 均只有 U。宿主机未装 psql，使用已有 PG 容器的客户端、通过 stdin 设置 PG 连接环境，仅连接 Neon 目标库。
- 迁移命令退出 0；数据库记录、SQL 文件、journal 条目均为 12。app 的 public 建表与 audit_log UPDATE、readonly 的 plan DELETE 均在事务探测中被拒绝，SQLSTATE `42501`。
- `billing:seed` 两次均退出 0，四套餐 `credit_pack` / `free` / `pro` / `team` 的行数与 ID 一致。平台价格同步已完成：网络失败后安全续跑 `billing:sync` 两次均退出 0，10 项映射均 active，UUID 与远端 ID 稳定；seed 与价格同步均不代替购买验收，详见 §2。
- 新 Hyperdrive 资源已创建并部署到两个 app 的 staging 绑定，见 §3；构建通过，配置已在 PR #62 合入 main。Neon 锁探针经用户批准补正 abandon 持锁时序后，一轮七场景、49 项原断言全部通过。
- 历史手动部署代码版本为 `7a229ce5e663d6781cefa2f441c01f164766a9ff`。开启 staging 日志后已按 jobs → web 重部署：jobs Worker version `cac1c571-e2b9-4e64-9ce9-f61faf9e4c70`（2026-10-09 03:37:51 UTC），web `c937023d-701a-4526-885f-42a5531f403b`（03:38:58 UTC），两者 APP_VERSION 均为同一完整 SHA。2026-10-09 03:35:05.869–03:36:10.165 UTC 的健康检查均为 200、db.up、完整 SHA 匹配；`jobs.lastCronAt` 从 `2026-10-09T03:35:04.669Z` 更新至 `2026-10-09T03:35:48.639Z`，在 10 分钟内更新，任务 2.3 通过。
- GitHub `staging` environment 已创建，`CLOUDFLARE_ACCOUNT_ID`、`STAGING_MIGRATION_DATABASE_URL` 与 `CLOUDFLARE_API_TOKEN` 三项名称已核对。CI 令牌经用户指示创建并配置，API 验证 active 与当前 account，剪贴板已清空。
- R2 桶 `files-staging` 已创建并核对列表；仅该桶对象读写的 S3 令牌 `files-staging-s3` 已获用户批准创建，凭据已按用户选择保存到本 worktree 的 `.env.staging-r2`（git 忽略、600、明文），两个字段已核验，剪贴板已清空，未写入 Mac 全局存储。AI Gateway `product-res-staging` 已创建、鉴权开启；Run 令牌已获批准创建并通过剪贴板 stdin 写入 web secret `AI_GATEWAY_TOKEN`，剪贴板已清空。Gateway vars 与 token 已部署；`staging:check-secrets` 退出 0、无必需缺项，健康检查无启动配置错误，任务 5.4 通过。
- Stripe key 已通过 API 核对目标 Sandbox，并补到 jobs。两平台既有 staging webhook 地址与事件均经 API 核对，PayPal 为 12 项事件；没有新建或删除 endpoint。PayPal Sandbox OAuth 已核验，jobs 三项 PayPal secrets 已补齐，临时 bulk 文件已删除；用户批准后 web PayPal 三项也已统一为核验过的 Sandbox 配置、名称已复核。Stripe endpoint signing secret 已按用户提供的值通过 stdin 补齐 jobs，名称已核对、临时文件已删除。
- Stripe Test `invoice.paid` 已由 CLI 发起，经 Stripe endpoint 投递到线上 staging：事件 `evt_1UOUaIL3UTpBAoXoYmdX1ucI` 在 Neon `webhook_event` 的 `api_version` 为 `2026-09-30.endive`、状态 `ignored`、`attempts = 1`、`processed_at = 2026-10-09T03:35:02.565Z`。真实验签通过，非订阅事件未触发业务动作，任务 5.3 通过；此证据来自 CLI，并非控制台操作，也不代表购买验收。
- 三个直连 URL 仅存忽略的 `.env.staging-neon`（600、明文），临时默认 owner URL 已移除，不写入 Mac 全局存储。两个文件均为三个带单引号的键值。本机 Node v23.11.0 的 parseEnv 在此输入上错误地产生连接串片段字段，输出字段名时泄露了 readonly 凭据。用户已在主/验证分支分别重置 readonly 并更新文件；两连接均已核验 product_res_staging/readonly、无高权限、可 SELECT、不能建表或写入。文件权限 600、git 忽略已复核；未保留旧密码，不声称额外做过旧密码登录测试。
- 独立空库重建（8.1）已通过；文档与路线图最终结项（8.2）在本 PR 3 完成。staging 注册冒烟（6.2）已通过：原三个用例、断言与超时均未修改，临时等效 Playwright 配置显式使用本机现有 HTTP 代理 `127.0.0.1:7897`，退出 0、3 passed、20.2 秒；注册与个人空间用例通过。没有 mock、伪造 Turnstile token 或修改系统设置，证据为 `/tmp/cloud-staging-neon-proxy-evidence.txt`。
- 版本探活（7.1）已通过：正确版本退出 0；错误版本经过 36 轮、约 180 秒退出 1，证据为 `/tmp/cloud-staging-neon-wrong-timed.log`。
- Stripe Checkout 首次返回 `BILLING_UNAVAILABLE`，Workbench 400 确认账户默认 Managed Payments 要求 product tax code。用户已批准每次创建 Checkout Session 显式设置 `managed_payments.enabled=false` 的两文件三行补正，已应用为提交 `ab9dc21274291a82a22da67aaa776c6a779dafef`；Stripe operations 回归由 RED（2 fail）转为 GREEN（20 passed），该提交的 CI run `37886473852` 全部通过。根目录 `check`、`check:deps`、`check:singletons`、`typecheck`、`test`、`build` 六项均退出 0，日志为 `/tmp/cloud-staging-neon-managed-{check,check-deps,check-singletons,typecheck,test,build}.log`。
- 历史 Managed Payments 补正后约 2026-10-09 04:58 UTC 再次按 jobs → web 手动部署完整代码版本 `ab9dc21274291a82a22da67aaa776c6a779dafef`，jobs Worker version `172b231b-7ef3-43f0-b677-aafba97c282e`、web `1c4273f4-420e-453c-96e0-fe950447372c`。部署时间仅据脱敏部署日志/文件时间推断，不作为精确时间戳；`2026-10-09T04:59:01.440Z` 健康检查为 200、status ok、db.up、完整 SHA 匹配，`lastCronAt = 2026-10-09T04:55:31.328Z`；随后心跳推进至 `2026-10-09T05:00:53.721Z`。
- 已在明确的 Stripe Sandbox 中用官方 `4242` 测试卡购买一次 $10 积分包，空间 `u-4py7aicz` 的 UI 余额从 0 增至 1000。`checkout.session.completed` 事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2` 在 `2026-10-09T05:00:14.299Z` 验签处理成功，API 版本为 `2026-09-30.endive`、`status = processed`、`attempts = 1`；付款 `01a11f08-8359-71e9-813e-64beae2501f9` 关联 `pi_3UOVugL3UTpBAoXo0hPVnZJQ`，`one_time / succeeded / 1000 USD`（最小货币单位）。唯一积分批次 `01a11f08-83f6-750c-b841-c10649a02cdd` 为 `purchase`、`amount = remaining = 1000`，`source_ref` 与 `payment_id` 均匹配该付款。
- 已修复的重投诊断历史：Workbench 原始投递为 200，`05:00:46` 与 `05:01:03` UTC 两次手动投递均为 500；`05:03:19` UTC 的第三次重投在 live tail 中报 `billing.webhook_failed` / `Webhook delivery association mismatch`。当时 `assertAssociation` 比较完整 event payload，已存与重投的顶层 `pending_webhooks` 从 3 变为 1，导致关联检查失败；三次失败均未重复入账。用户已授权最小修复，提交 `433e737b517733553537cfdb7ed9bb9fad6dbe4e` 仅在 Stripe 已存事件与入站事件的关联比较中忽略顶层 `pending_webhooks`；当前投递原始字节的签名验证、业务 payload 及 PayPal 比较仍严格校验。真实 worktree PG 管线回归由 RED 转为 GREEN（10 passed）；根目录六项检查全部退出 0，`typecheck` 13/13、`test` 22/22（802 passed、2 个既有 skip，其中 billing 247 passed）、`build` 2/2。日志为 `/tmp/cloud-staging-neon-duplicate-{check,check-deps,check-singletons,typecheck,test,build}.log`。
- 历史去重补正后已按 jobs → web 手动部署完整代码 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`，jobs Worker version `e60c6ed2-0f59-4bf8-b245-98e018096bd6`、web `5bfb1235-9cf6-4558-9b88-802938dcfb05`。部署精确时间未留证；`2026-10-09T05:11:05.853Z` 健康观测为 200、status ok、db.up、完整 SHA 匹配，`jobs.lastCronAt` 从 `2026-10-09T05:00:53.721Z` 推进至 `2026-10-09T05:10:39.639Z`。该历史提交的 [CI run 37887162498](https://github.com/ustclhx/product-res/actions/runs/37887162498) 已全部通过，head SHA 为上述完整 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`；CI 通过不代替首次 main 自动发布验收。
- 修复部署后，使用受保护的测试 key 经 Stripe CLI 重投同一原始购买事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2`；Stripe Workbench 的 `2026-10-09T05:11:10Z` Manual retry 明确返回 200 OK。重投后 readonly 核对付款、积分批次、事件与初始快照完全 deepEqual：各一条，付款仍为 `one_time / succeeded / 1000 USD`（最小货币单位），唯一 `purchase` 批次 `amount = remaining = 1000` 且关联原付款，事件仍 `processed / attempts = 1 / processed_at = 2026-10-09T05:00:14.299Z`；UI 余额仍为 1000。小额测试积分包购买、同事件去重及 Cron 心跳三项均通过，Neon 任务 9.1 已完成，Neon change 最终为 28/29，仅24 小时观察（9.2）保持未完成。
- 验收汇总为 `/tmp/cloud-staging-neon-purchase-acceptance.json`，只读前后快照为 `/tmp/cloud-staging-neon-payment-before-resend.json`、`/tmp/cloud-staging-neon-payment-result.json`，CLI 重投提交记录为 `/tmp/cloud-staging-neon-stripe-resend-result.json`，当时健康记录为 `/tmp/cloud-staging-neon-final-health.json`。CLI 退出 0 仅证明提交成功；endpoint 200 由 Workbench 独立观测确认。以上证据仅含公开 ID 与测试数据。
- 一小时日志验收（5.6）已通过：2026-10-09 03:39–04:39 UTC，账户级 Workers 数据集限定 jobs-staging，48 条 scheduled 记录、0 条错误；`event = "cron.heartbeat"` 为 13 条，确认结构化字段可检索；`event = "billing.provider_unconfigured"` 为 0 条。该窗口在日志启用后的部署之后，涵盖小时、每日和十分钟计费 Cron。jobs 仅 staging 开启日志、采样率 100%、traces 关闭。自动发布（7.4）已通过；24 小时观察（9.2）仍待完成。

以上为非敏感准备记录。后续实测需补 UTC、完整提交 SHA、两 Worker version、运行链接、退出码和关键结果；不记录密码、连接串、token 或 API key。

## 1. 建库、受限角色与本地凭据

在已登录的 Neon 控制台使用 Free 计划创建新项目（建议名 `product-res-staging`），Postgres 17、`aws-us-west-2`；先以默认 owner 创建空数据库 `product_res_staging`。下面是**新项目**的初始化流程；不对已有项目盲目重建同名角色。已有资源覆盖、删除、账号/组织或付款/条款选择由用户决定。

### 角色创建方式差异与本次处理

Neon Console / CLI / API 创建的角色自动成为 `neon_superuser` 成员；受限业务角色应通过 SQL 创建并显式授权，见 [Neon 角色文档](https://neon.com/docs/manage/roles)。本次最初在控制台创建的三角色均带 CREATEDB / CREATEROLE / BYPASSRLS / REPLICATION 与该成员身份，默认 owner 执行 `REVOKE neon_superuser FROM migrator, app, readonly` 被 `42501` 拒绝，事务已回滚。用户批准后，只删除并重建本次新建的三角色，保留项目、数据库与默认 owner；最终以 SQL 创建受限角色并完成 owner 授权。原权限 SQL 未改动。这是初次控制台建角的补救记录，不是新项目常规步骤。

### 新项目初始化

1. 通过受保护临时凭据，以默认 owner 直连新建的 `product_res_staging`，先核对 `current_user = neondb_owner`、`current_database() = product_res_staging`；确认三角色尚不存在。
2. SQL 创建三角色；密码以安全随机方式生成，通过交互式 psql `\password migrator`、`\password app`、`\password readonly` 设置，不把密码写进 SQL 文件、命令参数或历史。

```sql
CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT migrator TO neondb_owner;
ALTER DATABASE product_res_staging OWNER TO migrator;
REVOKE migrator FROM neondb_owner;
```

3. 以 `migrator` 重连目标库，按 §2 执行原权限脚本，令 public schema owner 与默认权限归属 migrator。核对三角色的高权限 flags 均为 false，且 `pg_has_role(rolname, 'neon_superuser', 'MEMBER')` 均为 false；不把 `neon_superuser` 设为数据库 owner。
4. 按用户确认，保存三个直连 URL 到被忽略的 `.env.staging-neon`（600、明文），不使用 Mac 密码 App 或全局钥匙串。键名为 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`；必须是非 pooled 主机名（不能带 `-pooler`）、`sslmode=require`。先执行 `git check-ignore .env.staging-neon`，设置文件权限 600。复制后立即清空剪贴板，不用 echo 或 shell tracing；移除临时默认 owner URL。

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

若 Neon 拒绝权限语句，停止并核对角色来源、owner 与授权，由默认 owner 修复必要授权；不修改原 SQL 的本地/CI 行为。本次受限角色重建后，migrator 完整执行原脚本通过，无需 owner 补执行脚本语句。迁移与三项权限拒绝结果见顶部证据。

确认 app 的 `current_database()` 为 `product_res_staging` 后：

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
psql "$NEON_APP_URL" -X -c 'select key from plan order by key'
```

应为 free / pro / team / credit_pack 四套餐，两次执行行数与 ID 不变；seed 不是平台价格同步，真实购买前按 [P2 支付联通](./p2-payment-integration.md) 同步测试报价。

2026-10-09 UTC 已完成测试报价同步。写入前 db guard 核验 `product_res_staging / app`，Stripe API 核验目标 Sandbox account，PayPal Sandbox OAuth 通过。网络失败后安全续跑 `billing:sync` 两次，均退出 0；readonly 复核全部 10 项映射 active，UUID 与远端 ID 均稳定。续跑日志为 `/tmp/cloud-staging-neon-sync-retry2.log`。此记录证明价格映射已同步；之后已完成一次 Stripe Sandbox 积分包购买及余额增加，最小修复部署后同一原始事件重投返回 200、记录与余额不再增加，任务 9.1 已通过，见顶部证据。

## 3. Hyperdrive 与切换

先核对已有名称，不覆盖资源。新建 `product-res-staging-neon`（关缓存）与 `product-res-staging-neon-cached`（max_age 60）。直连参数从环境读取；禁用命令 tracing，CLI 输出只保留名称、ID 与缓存配置，不输出源连接串。

```sh
pnpm --dir apps/web exec wrangler hyperdrive create product-res-staging-neon \
  --connection-string "$NEON_APP_URL" --caching-disabled
pnpm --dir apps/web exec wrangler hyperdrive create product-res-staging-neon-cached \
  --connection-string "$NEON_APP_URL" --max-age 60
```

2026-10-08 已创建以下资源，均使用 app、product_res_staging、非 pooled 直连与 TLS require：

| 资源 | ID | 缓存 |
|---|---|---|
| `product-res-staging-neon` | `b3a797e705e849a196a4f7fcaf887293` | disabled |
| `product-res-staging-neon-cached` | `ad4f2267382b427fbdd2ffe60d3a64de` | enabled；创建时指定 `--max-age 60` |

缓存资源的 API 响应省略默认 `max_age` / `stale_while_revalidate` 字段；[Cloudflare 官方默认值](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#default-cache-settings)分别为 60 秒 / 15 秒。这里记录创建参数与官方默认，不将省略字段当成显式返回的 60。

两个 app 的 `env.staging.hyperdrive` ID、Neon 注释、AI Gateway vars 与 observability 配置已随 PR #62 合入 main，本 PR 3 仅更新文档与任务记录，不重复配置变更。自动发布已使用新绑定并通过，见顶部证据。旧关缓存 ID `c4b28441aeaf49c3853a321a39cf8ec4`，旧缓存 ID `1b360caddf134503af774993499bdc4e`；观察期保留。以下为经授权的手动部署/重验参考；日常 main 发布由 §4 流水线负责。

```sh
pnpm --filter @product-res/jobs deploy:staging
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @product-res/web deploy:staging
node scripts/staging/wait-healthy.mjs https://web-staging.product-res-jobs.workers.dev/api/health "$(git rev-parse HEAD)"
STAGING_URL=https://web-staging.product-res-jobs.workers.dev pnpm --filter @product-res/web exec playwright test --project staging
```

健康检查应 200、db.up、版本匹配；当时按原调度验证 10 分钟内 jobs.lastCronAt 更新。本次线上检查与心跳已通过，完整版本及时间见顶部证据。2026-10-13 的 staging 半小时调度决定与后续心跳核验窗口见 §6。按 `scripts/probes/71-locks/README.md` 对新关缓存 ID 重跑一轮七场景；探针 token 只走 secret/stdin，避免 README 示例的明文参数。只操作本轮创建的临时探针，保留其他现有资源。记录日期、往返延迟、锁释放与七场景结论到 docs/07。**Neon 锁探针已通过，见下方补正重跑结果；2026-10-03 的本机链路历史结果不能代替本轮。**

2026-10-08 13:26–13:27 UTC，通过 `wrangler dev --remote` 临时 preview 使用新关缓存 Hyperdrive 执行原探针一轮，未部署第三个常驻 Worker。七场景均返回 200；四个行锁/advisory 的 commit/rollback 场景 B 等待 2591–2674ms，A 释放后 36–43ms 获取锁。row/advisory 的 abandon 场景分别复用 PID 1796/1824，因此原驱动的“两个 PID 不同”断言失败（退出 1）；B 实际在 A 响应返回约 577/557ms 后才开始，原 abandon 没有执行 hold。各场景及最终五次 try-lock/NOWAIT、pg_locks 检查均通过，打印的 idle-in-transaction 列表为空；cleanup 删除探针行，随后 app 直连确认 `probe.7.1.%` 行数为 0。

本机到远端 preview 的 `/check` 五次往返为 665/522/503/567/463ms（中位 522ms）；包含本机代理链路和数据库查询，不能当作已部署业务 Worker 的单条数据库时延。后端连接复用符合 [Hyperdrive 生命周期](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/)，但当前结果不能证明 abandon 两请求曾同时争锁，也不能因 PID 复用认定清理失败。首次失败记录保留；用户批准后的补正与一次重跑结果如下。

2026-10-08 13:57–13:59 UTC，用户批准仅增加 abandon 拿锁后的 hold 等待，保留驱动与全部原断言，通过同一新关缓存 Hyperdrive 一轮七场景退出 0：49 PASS、0 FAIL。六个锁场景 A/B 均不同 PID 与 xid，B 在 A 持锁期间开始事务；提交场景读到增加后的值，回滚/abandon 场景读到原值。B 等待 2558–2749ms；commit/rollback 距事务内 releaseAt 43–50ms 取得锁，abandon 距响应生成时间戳 38–39ms 取得锁。这些时间戳不等于 Hyperdrive 内部实际释放时刻。

八轮释放检查（每轮五次 try-lock/NOWAIT 与五次只读查询）通过，无其他 advisory holder，idle-in-transaction 列表为空。cleanup 返回 200；13:59:36 UTC app 直连终检确认 product_res_staging、探针行数 0、该 advisory key 无持有者、app 超两秒空闲未结束事务为空。临时 preview 已停止、随机 token 文件已删除。五次 `/check` 往返 752/623/743/567/518ms（中位 623ms），包含本机 loopback 代理与 remote preview，不能作为纯数据库或业务 Worker 时延。

## 4. 配置与自动发布

```sh
pnpm staging:check-secrets
```

脚本核对两个 Worker 的 secret 名称；必需项缺失退出 1，可选项缺失仍列出。web 必需 Auth、Turnstile、OAuth 四项、Stripe 两项、PayPal 三项；jobs 必需 Stripe 两项和 PayPal 三项。可选为 RESEND_API_KEY、AI_GATEWAY_TOKEN、SENTRY_DSN。真值只通过标准输入写 Wrangler，覆盖已有密钥需明确用户授权，本次 web PayPal 三项已获授权统一；Stripe 仅 Test mode，PayPal 仅 Sandbox，webhook 事件按 P2 runbook。

AI Gateway `product-res-staging` 与 R2 桶 `files-staging` 已创建。Gateway 鉴权已开启，账号/Gateway ID 的 web staging vars 与经 stdin 配置的 `AI_GATEWAY_TOKEN` 已部署；secrets 检查及启动配置验收（5.4）通过，见顶部证据。权限仅限当前账户，Cloudflare 无法限单个 Gateway。S3 令牌 `files-staging-s3` 仅授权该桶对象读写、永久有效，凭据已按用户授权保存 `.env.staging-r2`（git 忽略、600、明文），剪贴板已清空；绑定由媒体 change 接入。资源创建不代表 AI 或媒体联通验收；涉及付款/绑卡/条款时交给用户。

GitHub environment `staging` 需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、STAGING_MIGRATION_DATABASE_URL。三项已配置并核对名称；CI token 已验证 active 与当前 account。当前账号的最小权限方案为 Workers Scripts 编辑，Workers KV / Queues / Hyperdrive / Account Settings 读取；控制台没有独立 Workflows scope，Workflows API 使用 Workers Scripts 权限，不要求创建不存在的 scope。token 从控制台 Copy 后经剪贴板 stdin 写 `gh secret set`，立即清空；迁移 URL 只从忽略文件 stdin 传入。用 `gh secret list --env staging` 仅核对名称。

`deploy-staging.yml` 跟随 main 成功 CI，检出该次 head_sha；手动运行也限 main。environment 限制 secrets，PR CI 不引用它们。`staging-deploy` 串行且不取消：迁移 → jobs → web（完整 SHA）→ 3 分钟版本探活 → staging Chromium 冒烟。首次自动发布失败与补正后成功记录见顶部；任务 7.4 已按成功运行验收。手动重发：

```sh
gh workflow run deploy-staging.yml --ref main
```

版本探活（7.1）已验证正确版本退出 0，错误版本 36 轮约 180 秒后退出 1。staging 原三项 Chromium 冒烟（6.2）已在本机现有 HTTP 代理下通过，临时等效配置未修改断言或超时，详见顶部证据。PR #62 与 #64 均已合并；补正后的 main 自动发布（7.4）已通过，Actions 原三项 Chromium 冒烟为 3 passed（10.0 秒），见顶部成功运行。

jobs 已仅在 staging 开启日志、采样率 100%、traces 关闭，并按 jobs → web 完成重部署。近 1 小时 Workers Logs 的 `billing.provider_unconfigured` 检查（5.6）已通过：2026-10-09 03:39–04:39 UTC 的固定窗口检索为 0 条，同窗口有 48 条 scheduled 记录与 13 条结构化心跳，详见顶部证据。注册与两平台选择已完成；Managed Payments 与重复投递最小补正均已应用并部署，Stripe Sandbox 积分包付款、余额增加、同一原始事件重投 200 且无重复入账均通过，购买（9.1）已完成。Cron 心跳已通过 2.3；固定窗口 5.6 结果保留，不因本轮重部署重置。

## 5. 空库重建与回滚

独立空库重建（8.1）已通过，结果如下。重建只用新的 Neon 分支/空数据库，先核对它仍叫 `product_res_staging`；删除/覆盖继承副本需用户明确授权。新分支通常继承角色与数据，必须核对三角色已受限且目标库确实为空；已存在角色时跳过 §1 的 CREATE ROLE，不盲目删角色或已有表。按 §1–2 完成 owner、权限、迁移与 seed 校验，验证迁移数及 seed 幂等一致；将新分支直连信息写受保护本地文件。验证完成后才决定是否切换 Hyperdrive，不自动删除分支。

2026-10-08 13:47 UTC 创建独立验证分支 `verify-empty-rebuild-20261008`（`br-lucky-rice-ak38vmkg`，Free、Never 自动删除），父分支为 `production`。继承副本包含 12 条迁移，Console 无改名入口。用户明确授权后，仅删除此分支的 `product_res_staging` 副本，保留 neondb 与全部角色，再创建 owner 为 migrator 的空 `product_res_staging`。主分支、Hyperdrive 与 GitHub 迁移 secret 均未切换。

验证仅加载忽略的 `.env.staging-neon-rebuild`（600），先确认新分支 hostname、三角色身份、库名 product_res_staging/owner migrator，以及用户关系/函数/枚举/域对象均为 0。原权限 SQL 完整通过，三角色高权限均为 false；迁移退出 0，12 记录 = 12 SQL = 12 journal；app DDL/audit UPDATE 与 readonly DELETE 均拒绝 42501；seed 两次退出 0，四套餐及 ID 一致。没有更新 GitHub 迁移目标、没有部署 Worker。用户已完成 readonly 轮换，新连接与最小权限复核通过；该角色未绑定 Hyperdrive。验证分支不自动删除。

回滚前由用户确认本机旧 staging PG 与 cloudflared 可用。把两个 app 的 staging ID 还原为 §3 旧值，按 jobs → web 发布；确认健康与心跳。必要时由协调者禁用 `deploy-staging.yml`，避免自动发布覆盖回滚。Neon 新库与本机旧库是独立数据集，回滚不复制测试数据。

## 6. 24 小时观察与 staging 调度

切换后的观察窗口为 24 小时（2026-10-09 用户决定由七天缩短：当时 jobs Cron 每 5 分钟运行，计算基本不休眠，一天用量乘 30 即为月度估算）。每日检查 /api/health、Cron 心跳、错误率；Neon Dashboard 查看计算小时与存储占用，记录 Free 配额、使用量和预计耗尽时间。原先保持 Cron 频率的安排已由本节末尾的 2026-10-13 用户决定取代；生产仍保持默认频率。

观察基线（2026-10-09 04:04 UTC）：Neon 项目 `product-res-staging` 控制台仍为 Free；项目 Usage（Since Oct 8）显示 compute 3.05 CU-hrs、storage 40.38 MB、history 320.17 kB、network transfer 699.2 kB。这是包含两个分支的项目级统计，不能归因于主分支；控制台提示统计可延迟一小时。以本轮可核验的 2026-10-09 03:38 UTC 发布作为观察起点，观察在 2026-10-10 03:38 UTC 后完成，以 24 小时 compute CU-hrs × 30 估算月度用量并对照 Free 配额。

| 每日 UTC | compute CU-hrs | storage | health / SHA | Cron / 错误率 | 配额与预计耗尽时间 |
|---|---:|---|---|---|---|
| 2026-10-09 04:04（基线） | 3.05 | 40.38 MB | 200 / 7a229ce… | 心跳已验证；持续观察 | 24 小时后 ×30 外推 |
| 2026-10-10 09:32（24 小时后） | ≈5.5/天（推算，见下） | 库 10 MB（`pg_database_size`） | 200 / 254f5c1… | 心跳 09:30 正常；观察期 deploy 7 成功、3 失败（冒烟注销等待，#74 已修）、4 跳过 | 超出 Free，约第 18 天耗尽 |

**测量方法**：本次未读取 Neon 控制台（会话内无浏览器自动化，也没有 Neon API Key），CU-hrs 为推算值：`pg_postmaster_start_time()` = 2026-10-08 14:40 UTC，即 compute 已连续运行 42.9 小时、从未缩容到零；基线 3.05 CU-hrs / 13.4 小时 ≈ 平均 0.23 CU。因此每天约 5.5 CU-hrs，月度约 165 CU-hrs。复核时以控制台 Usage 为准，替换本行数字。

**对照配额**（[Neon 定价](https://neon.com/pricing)，2026-10-10 查询）：Free 每项目 100 CU-hrs/月，用尽后 compute 暂停到下个计费周期（数据保留，升级即恢复）；存储 1 GB/项目，当前远低于上限。Launch 按量计费 $0.106/CU-hr、$0.35/GB-月，无月度最低消费，按当前用量约 $17–19/月。

**历史结论（原高频调度）**：jobs Cron 每 5 分钟唤醒，scale-to-zero 不会生效，按当时推算，Free 计划的 compute 在每个计费周期约第 18 天用尽，之后 staging 数据库不可用到下一周期。该结论用于原调度，不代表半小时调度后的实测用量。

**决定与执行（2026-10-10，用户决定）**：测试阶段保持 Neon Free，接受计费周期后段 compute 暂停的风险，实际产品上线时再升级付费计划。已删除旧 Hyperdrive `c4b28441aeaf49c3853a321a39cf8ec4` / `1b360caddf134503af774993499bdc4e`、Workers VPC 服务 `01a10214-295e-78c1-b8db-506adb15ef2a` 与 Tunnel `product-res-local`（`1fad053b-8b3b-4dde-a8aa-7ddf524847a3`），并停止本机 `cloudflared` 容器；删除后 staging `/api/health` 正常（`db.status=up`，Cron 心跳持续）。阶段二若仍采用 Tunnel 方案，按 [hyperdrive-tunnel.md](hyperdrive-tunnel.md) 重新创建资源。9.2 完成。

**staging 降频决定（2026-10-13，用户决定）**：测试阶段的定时任务只需在一定窗口内跑通，staging 使用 `CRON_PROFILE=reduced`。仅 Cloudflare `env.staging` 将原五分钟心跳与十分钟维护合并到 `*/30 * * * *`：每次各执行一次心跳及 hold 回收、Webhook 恢复、退款补偿、文件清理，子任务继续独立处理失败。`0 * * * *` 小时计费和 `0 3 * * *`、`0 4 * * *` 每日任务保持不变；它们与半小时任务同分钟触发，预计不增加独立唤醒次数。顶层/本地默认、生产默认频率和 Node 五项调度均保持原样。配置合入 main 后由自动发布生效，不手动部署分支到 staging。

**预期用量（估算，待发布后复核）**：按每天约 48 次唤醒、每次计算活跃约 5.5 分钟、0.25 CU 估算，`48 × (5.5 / 60) × 0.25 ≈ 1.1 CU-hours/天`，月度约 35 CU-hours，低于上述 Free 每月 100 CU-hours 配额。实际请求、任务耗时、连接活跃时间与其他 Neon 分支会影响项目用量；持续访问可能阻止缩容到零。这是调度预算，不是已测得的节省量；发布后用 Dashboard Usage 与缩容记录复核。

**健康与验收窗口**：Cloudflare `/api/health` 返回实时 `jobs.lastCronAt`，不以心跳是否在 10 分钟内决定 200/503；部署探活只要求 200、db.up 与完整 SHA 匹配，staging 冒烟覆盖首页、定价页、注册与注销，也不检查心跳新鲜度。Node 健康接口的 10 分钟门槛随原调度保持不变。自动发布后按半小时触发窗口核验心跳推进及维护任务日志，不再要求 10 分钟内推进；健康接口请求本身会访问数据库，观察缩容时避免持续轮询。
