# Runbook · 本机数据库经 Tunnel 接入 Hyperdrive（历史链路与回滚）

> 2026-10-10：本表中的 Tunnel、Workers VPC 服务与旧 Hyperdrive 已删除（见 [staging-neon.md](staging-neon.md) §6），本文仅作重建步骤参考；回滚需按下文重新创建资源。

> 历史记录：本文保存 Neon 切换前的阶段一配置与命令，仅用于核对旧链路或经用户确认的回滚。当前 staging 目标、迁移与发布流程见 [Neon runbook](staging-neon.md)；main 已自动发布到 Neon staging，当前完整代码版本 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`；[run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572)（2026-10-09 06:36:31–06:38:28 UTC）迁移、jobs → web、版本探活与三项冒烟均 success。Neon change 最终为 28/29，仅24 小时观察（9.2）未完成；以 2026-10-09 03:38 UTC 切换为基线，最早 2026-10-16 同时刻完成，旧资源继续保留。下文“每次合并后手动迁移”等说明属于历史流程，不适用于 Neon 自动发布。

把开发者本机 Docker 中的 Postgres 接到 Cloudflare 上的 staging Worker：

```
Worker（*.workers.dev）→ Hyperdrive → Workers VPC 服务（TCP）→ Tunnel → cloudflared ×2（本机 Docker）→ Postgres（TLS）
```

不需要域名、DNS 记录、Access 应用或 Service Token。背景与取舍见 `docs/07-infrastructure.md` §0、§2。

## 旧链路保留资源（账号 `170a06d37ad50396b19943eb6b77a21d`）

| 资源 | 名称 | ID |
|---|---|---|
| Tunnel | `product-res-local` | `1fad053b-8b3b-4dde-a8aa-7ddf524847a3` |
| Workers VPC 服务 | `product-res-local-pg`（主机名 `postgres`，端口 5432，不校验证书） | `01a10214-295e-78c1-b8db-506adb15ef2a` |
| 旧 Hyperdrive（关缓存） | `product-res-staging`（历史 `HYPERDRIVE` 绑定） | `c4b28441aeaf49c3853a321a39cf8ec4` |
| 旧 Hyperdrive（开缓存，max_age 60s） | `product-res-staging-cached`（历史 `HYPERDRIVE_CACHED` 绑定） | `1b360caddf134503af774993499bdc4e` |
| Queue | `email-staging` | — |
| Workflow | `ai-media-staging`（定义在 `jobs-staging`） | — |
| Worker | `jobs-staging`、`web-staging` | `https://web-staging.product-res-jobs.workers.dev` |

workers.dev 子域名 `product-res-jobs` 是账号级设置（第一次部署时由 wrangler 自动注册），可在 Cloudflare 控制台 Workers → 子域名处修改；修改后所有 `*.workers.dev` 地址随之改变。

## 前置条件

- Docker Desktop 已启动；`pnpm install` 已完成。
- 已登录 Cloudflare：`pnpm --dir apps/web exec wrangler login`（OAuth 已包含 Tunnel、Workers VPC、Hyperdrive、Queues、Workers 所需权限）。
- 下文命令均在仓库根目录执行，`W` 表示 `pnpm --dir apps/web exec wrangler`。

## 一、日常使用

```bash
# 启动本机 PG（TLS）与两个 cloudflared 副本
docker compose -f infra/local/docker-compose.yml --profile tunnel up -d

# 检查：两个副本各注册 2 条连接，Tunnel 状态 healthy
docker compose -f infra/local/docker-compose.yml --profile tunnel logs cloudflared | grep "Registered tunnel connection"
W tunnel info product-res-local

# 检查 staging 链路
curl -s https://web-staging.product-res-jobs.workers.dev/api/health

# 不用 staging 时只停 cloudflared（本机开发不受影响）
docker compose -f infra/local/docker-compose.yml --profile tunnel stop cloudflared
```

历史本机链路下，本机关机或 cloudflared 停止会使 staging 的 `/api/health` 返回 503。当前 Neon staging 不依赖这条链路，停用 cloudflared 不影响其数据库连接。

## 二、从零重建

### 1. 本机 Postgres 启用 TLS

`infra/local/docker-compose.yml` 通过 `pg-tls-entrypoint.sh` 在首次启动时生成自签证书并开启 `ssl=on`（Workers VPC 要求数据库启用 TLS）。

```bash
docker compose -f infra/local/docker-compose.yml up -d postgres
docker exec product-res-pg psql -U postgres -tAc "show ssl"     # 期望 on
```

### 2. staging 数据库

```bash
docker exec product-res-pg psql -U postgres -c 'CREATE DATABASE product_res_staging'
docker exec -i product-res-pg psql -v ON_ERROR_STOP=1 -q -U postgres -d product_res_staging < infra/local/initdb/02-db-grants.sql
MIGRATION_DATABASE_URL=postgres://migrator:migrator@localhost:5432/product_res_staging pnpm --filter @product-res/db db:migrate
```

历史流程要求每次合并含迁移的改动后，在本机对 `product_res_staging` 重新执行最后一条命令。当前 main 流水线自动迁移 Neon，此命令仅用于经确认的旧链路重建/回滚。

### 3. Tunnel 与 cloudflared

```bash
W tunnel create product-res-local          # 记下输出的 Tunnel ID
```

取运行令牌写入 `infra/local/.env`（已被 `.gitignore` 忽略，不要提交、不要打印到日志）：

```bash
ACCOUNT_ID=170a06d37ad50396b19943eb6b77a21d
TUNNEL_ID=<上一步的 ID>
OAUTH=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
TOKEN=$(curl -s -H "Authorization: Bearer $OAUTH" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')
(umask 077; printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN" > infra/local/.env)

docker compose -f infra/local/docker-compose.yml --profile tunnel up -d
```

### 4. Workers VPC 服务

`cloudflared` 与 Postgres 在同一 compose 网络中，VPC 服务的主机名用 compose 服务名 `postgres`；自签证书需要关闭证书校验。

```bash
W vpc service create product-res-local-pg --type tcp --tcp-port 5432 --app-protocol postgresql \
  --tunnel-id <TUNNEL_ID> --hostname postgres --cert-verification-mode disabled
```

### 5. Hyperdrive

```bash
W hyperdrive create product-res-staging --service-id <VPC_SERVICE_ID> \
  --database product_res_staging --user app --password app --scheme postgresql --caching-disabled
W hyperdrive create product-res-staging-cached --service-id <VPC_SERVICE_ID> \
  --database product_res_staging --user app --password app --scheme postgresql --max-age 60
```

把两个 ID 填入 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 的 `env.staging.hyperdrive`。

> 刚创建 VPC 服务后立即创建 Hyperdrive 可能失败，且命令没有明显报错（重建演练中遇到过）。每次创建后用 `W hyperdrive list` 确认配置存在，不存在就重新执行。

### 6. Queue 与部署

```bash
pnpm --dir apps/jobs exec wrangler queues create email-staging
pnpm --filter @product-res/jobs deploy:staging      # 先部署 jobs：web 的 Workflow 绑定指向 jobs-staging
pnpm --filter @product-res/web deploy:staging       # CLOUDFLARE_ENV=staging vite build && wrangler deploy
curl -s https://web-staging.product-res-jobs.workers.dev/api/health   # 期望 200，db.status = up
```

`jobs.lastCronAt` 在下一次 Cron（每 5 分钟）后出现。

## 验证记录

- 2026-10-03：按本文第二节第 3–5 步，用一次性的名称（`product-res-rebuild-test*`）在同一 compose 网络中另起一个 cloudflared，重建 Tunnel、VPC 服务与 Hyperdrive，经 `wrangler dev --remote` 查询 `product_res_staging` 成功（TLS、`app` 账号），随后按第四节删除。第 1、2、6 步在搭建正式 staging 时已执行。

## 三、排查

| 现象 | 检查 |
|---|---|
| `/api/health` 返回 503 | `docker compose ... ps` 中 cloudflared 是否在运行；`W tunnel info product-res-local` 是否 healthy；`show ssl` 是否为 on |
| Tunnel healthy 但查询失败 | VPC 服务的主机名是否为 `postgres`（compose 服务名）、端口 5432、证书校验是否为 `disabled` |
| 认证失败（28P01） | Hyperdrive 中的账号密码与本机 `app` 账号是否一致；`product_res_staging` 是否执行过 `02-db-grants.sql` |
| 表不存在 | 本机是否对 `product_res_staging` 执行了最新迁移 |
| 延迟波动大（160 ms – 2.5 s） | 阶段一请求要绕回开发者本机网络，新建连接时明显变慢；不代表生产延迟（docs/07 §0） |

## 四、历史整套链路删除参考（当前不执行）

以下是删除整套旧 staging 的历史命令，其中 Worker、Queue 仍为 Neon staging 共用，不能作为24 小时观察后的旧 Hyperdrive 清理步骤执行。任务 9.2 未完成，不删除旧资源；观察满 24 小时后按 [Neon runbook §6](staging-neon.md#6-24-小时观察任务-92-保持未完成) 由用户决定旧 Hyperdrive、Tunnel 与 VPC 的去留。

```bash
pnpm --dir apps/web exec wrangler delete web-staging
pnpm --dir apps/jobs exec wrangler delete jobs-staging
W queues delete email-staging
W hyperdrive delete <两个 Hyperdrive ID>
W vpc service delete <VPC_SERVICE_ID>
docker compose -f infra/local/docker-compose.yml --profile tunnel stop cloudflared
W tunnel delete product-res-local   # 需等 cloudflared 的连接关闭（停止后约几分钟），否则报错 1022，稍后重试
rm infra/local/.env
```
