# 07 · 基础设施、环境与部署

## 0. 部署阶段

模板按两个阶段推进基础设施，避免在原型尚未成形时就投入生产服务器的运维：

| 阶段 | 时间 | 数据库 | 连接方式 | Worker 部署 | 域名 | 备份 |
|---|---|---|---|---|---|---|
| **阶段一：开发与云端 staging 测试** | 从 Phase 0 到完成最小原型 | 本地开发：Docker PG（`infra/local`）；线上 staging：Neon `product_res_staging` | 本地开发直连；staging：Hyperdrive → Neon 非 pooled TLS 直连（§2） | staging 部署到 `*.workers.dev` | 不需要 | 不做 |
| **阶段二：生产上线**（派生项目参考） | 完成最小原型之后 | production：Neon Launch 的独立项目；staging 为同组织另一项目（2026-10-15 随组织升级为 Launch 计费） | Hyperdrive → Neon 非 pooled TLS 直连（与 staging 相同） | staging / production，绑定自定义域名 | 需要（可先用已有 Zone 的子域名） | 必须：Neon PITR + 独立逻辑备份与恢复演练 |

**2026-10-15 用户决定**：Cloudflare 形态的生产数据库使用 Neon 付费档，不自建 PG，不建设 Tunnel / Workers VPC，计划与任务见 `docs/08-roadmap.md`「Cloudflare 生产上线」。§1 的自建 PG、§2 的 Workers VPC / Access 方案保留为历史与后路，不再是阶段二默认。自托管形态（Node + Compose）使用 Compose 内的 PG，见 `docs/node-jobs-extension.md` 与 `docs/runbooks/selfhost-*.md`。

**最小原型**指 Phase 0–3 完成：可以注册登录、开通套餐或购买积分、进行一次计费正确的 AI 对话（见 `docs/08-roadmap.md`）。

**当前状态（2026-10-18）**：按用户确认，模板演示的 Cloudflare 生产实例与自托管测试实例已拆除。生产 Workers、KV、Queues、Hyperdrive、Turnstile 与 Neon 项目已删除；GitHub `production` environment（含 secrets）与 `PRODUCTION_BACKUP_SCHEDULE` 已删除。自托管 `product-res-selfhost` 栈、项目卷、本机项目镜像与 `/opt/product-res-selfhost` 已清理，80/443 已释放。四个非空 R2 桶已解除锁并设为所有对象 1 天后过期，待 2026-10-19 核空后删桶；`selfhost.ezarouter.cc` DNS 与 Sentry Uptime 监控因 API 权限不足待用户手动删除。生产自定义域名已解绑，公共 DNS 的 A/AAAA/CNAME 均为 NXDOMAIN。详见[拆除记录](./runbooks/evidence/teardown-2026-10-18.md)。

拆除前 Cloudflare 生产 **v0.1.3** 的完整 SHA 为 `54c537542ad0f2033628c136a7057a705c6d0218`；[发布 run 38910072786](https://github.com/ustclhx/product-res/actions/runs/38910072786)、每日加密逻辑备份、两路恢复演练及 Sentry 可读堆栈与健康监控均已验证，见 [production runbook](./runbooks/production-neon.md) 与[历史发布恢复证据](./runbooks/evidence/production/release-2026-10-16.md)。配置、workflow、部署材料与 runbook 保留供派生项目使用，原生产资源 ID 已失效，重新上线须创建项目自身资源和凭据。staging 继续由 main 自动发布到 Neon（同组织 Launch），`add-cloud-staging-neon` 已于 2026-10-11 完成 29/29 并归档。

Cloudflare 生产 change 的模板范围已结项，合并后由协调者归档；自托管四个 change 已于 2026-10-17 全部同步并归档（#239）。`add-cloud-acceptance-followups` 的 staging 支付验收由另一 worker 处理中，未合并结果不计入当前 main 进度。2026-10-18 用户决定：正式收款主体（Q9）、生产 live 支付（原 6.1）与生产延迟放置对比（原 5.1）不在模板内验收，移交派生项目上线清单，方法见 `docs/05-billing.md` §8、本文件 §8 与 production runbook。派生项目开放注册前还需恢复默认 Cron 并复核费用。

Phase 0 本机链路的历史实测条件与当前观察范围：

- 切换前 staging 访问旧数据库要求开发者本机与 `cloudflared` 在线；当前线上 Neon 链路已解除此依赖，旧 Tunnel / VPC 资源已删除。
- Phase 0 请求绕回本机，其延迟基线只验证原链路可用，不能代表 Neon 或生产环境。
- 本机 PG 不做备份；Neon staging 为可重建测试数据，24 小时观察显示 compute 常驻约 165 CU-hrs/月，超出 Free 100 CU-hrs；2026-10-10 曾决定测试阶段保持 Free，2026-10-15 已随组织升级为 Launch（见 runbook staging-neon §6 与 production-neon §4），staging 不替代生产备份方案。阶段一的旧 Hyperdrive、Tunnel 与 Workers VPC 资源已于 2026-10-10 删除。

## 1. 自建 Postgres（Cloudflare 形态后路；2026-10-15 起阶段二改用 Neon 付费档，见 §0）

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

> 状态：推迟到阶段二实施。R2 主备份与异地第二副本均为待办（`docs/08-roadmap.md`「生产迁移」）。

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

### 阶段一线上 staging：Neon（main 自动发布已验收）

Neon 项目 `product-res-staging`（2026-10-15 前为 Free，现随组织为 Launch 计费，计算 0.25–2 CU），Postgres 17、`aws-us-west-2`，数据库 `product_res_staging`；Hyperdrive 使用 app 的非 pooled 直连与 `sslmode=require`。migrator 为数据库/public owner，仅用于迁移，readonly 用于排查。Console 创建角色默认加入 `neon_superuser`；受限角色通过 SQL 创建，再由默认 owner 授权，原 `02-db-grants.sql` 不变。2026-10-08 已验证三角色均无高权限 flags/该成员身份，app DDL 与审计 UPDATE、readonly DELETE 均被拒绝。

| 绑定 | 新资源 | ID | 状态 |
|---|---|---|---|
| `HYPERDRIVE` | `product-res-staging-neon` | `b3a797e705e849a196a4f7fcaf887293` | web/jobs staging 已部署使用，缓存关闭 |
| `HYPERDRIVE_CACHED` | `product-res-staging-neon-cached` | `ad4f2267382b427fbdd2ffe60d3a64de` | web/jobs staging 已部署使用，缓存开启，创建参数 max_age 60 |

缓存 API 省略默认字段，官方默认 max_age 为 60 秒，详见 [操作记录](./runbooks/staging-neon.md#3-hyperdrive-与切换)。计费、会话及权限读写使用不缓存的 `HYPERDRIVE`。新关缓存 Hyperdrive 经 remote preview 的 Neon 锁探针七场景/49 断言已通过，证据见下文；§8 保留本机链路历史延迟，不能作为 Neon 业务 Worker 延迟基线。

### Workers VPC（切换前 staging 与阶段二自建 PG）

Hyperdrive 通过 Workers VPC 服务经 Tunnel 访问私有数据库，**不需要公网主机名、DNS 记录、Access 应用或 Service Token**。链路：Worker → Hyperdrive → Workers VPC 服务（TCP）→ Tunnel → `cloudflared` → Postgres。

步骤（在 `docs/runbooks/hyperdrive-tunnel.md` 中细化）：
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

### 事务与锁（7.1 本机链路历史实测，2026-10-03）

**结论：可用。** 经 Hyperdrive（关缓存）时，显式事务内的 `SELECT ... FOR UPDATE` 与 `pg_advisory_xact_lock` 都能让并发请求串行执行；事务提交、回滚，以及 Worker 中途结束导致事务被丢弃，三种情况下锁都会释放，连接池中不残留锁或未结束的事务。`docs/04`、`docs/06` 中「先取空间级 `pg_advisory_xact_lock` 再检查并写入」的写法保持不变，不需要改用 design.md 风险条目中「锁 workspace 行」的替代写法。

**测试方法**（`scripts/probes/71-locks/`，可重复执行）：
- 临时 Worker `probe-71-locks` 绑定 `product-res-staging`（关缓存），连接参数与 `createDb()` 相同（postgres.js 3.4.9，`max: 5`、`prepare: true`、`fetch_types: false`），用 `sql.begin()` 开显式事务。
- 请求 A 取锁后读计数器、`pg_sleep(3s)`、写回 +1；800 ms 后请求 B 争同一把锁（持锁 0.5 s 后提交）。行锁为 `setting` 表中 `probe.7.1.row` 一行的 `FOR UPDATE`，advisory lock 为 `pg_advisory_xact_lock(710001)`（与 `hashtextextended(...)` 生成的 bigint 键同一函数）。A 分别以提交、回滚（回调中抛错）、丢弃（拿到锁后立即返回响应，事务不结束）三种方式结束；另有不加锁的对照组。
- 时间点都取数据库时钟 `clock_timestamp()`，A、B 可直接比较。每个场景后在新事务中串行 5 次 `pg_try_advisory_xact_lock` + `FOR UPDATE NOWAIT`，并查 `pg_locks` 与 `pg_stat_activity`。
- 共 3 轮 × 7 个场景，全部判定通过。

**关键数据**（第 1 轮原始时间，相对 A 开始事务，单位 ms）：

| 场景 | A 拿到锁 | B 开始事务 | A 持锁结束 | B 拿到锁 | 说明 |
|---|---|---|---|---|---|
| 行锁 / A 提交 | 630 | 1304 | 5358（发出 COMMIT 前） | 5673 | B 读到 A 提交后的计数器（1 → 2） |
| advisory / A 被丢弃 | 640 | 788 | 1450（A 已返回响应） | 1613 | B 读到原值，A 的事务被回滚 |
| 对照组（不加锁） | 324 | 964 | 4938 | 1446 | B 不等待、读到旧值，两次 +1 后计数器只 +1（丢失更新） |

3 轮汇总（ms）：

| 场景 | A 持锁时长 | B 等待时长 | B 在 A 释放后多久拿到锁 |
|---|---|---|---|
| 行锁 / 提交 | 4141–4984 | 3359–4694 | 164–360 |
| 行锁 / 回滚 | 4118–4730 | 3783–4883 | 160–332 |
| 行锁 / 丢弃 | 649–790 | 630–762 | 160–443 |
| advisory / 提交 | 4734–4871 | 4835–5086 | 312–371 |
| advisory / 回滚 | 4732–4910 | 4877–5188 | 313–336 |
| advisory / 丢弃 | 631–810 | 640–825 | 163–192 |
| 对照组（不加锁） | 4581–4617 | 470–489 | 不等待（B 在 A 释放前 3.5–3.8 s 已拿到） |

- 「B 在 A 释放后多久拿到锁」约为一次 Worker ↔ 本机数据库的往返（A 的 `COMMIT` / `ROLLBACK` 送达数据库所需时间）；阶段一每条语句往返约 160–500 ms，持锁时长因此比 `pg_sleep` 多出 1–2 s，不代表生产延迟（§0）。
- A 被丢弃时，Hyperdrive 在客户端断开后回滚该事务，约一次往返内释放锁；该后端连接（如 pid 8725）随后被其他请求复用，未被关闭。
- 全部场景结束后，在本机以超级用户查看 `product_res_staging`：`pg_locks` 中没有 advisory lock，`pg_stat_activity` 中所有 `app` 连接都是 `idle`（无 `idle in transaction`）。

**Neon 直连复核（2026-10-08，通过）：** 使用新关缓存 Hyperdrive，经 `wrangler dev --remote` 临时 preview，未新增常驻 Worker。首次原探针 abandon 立即返回、B 在响应后才开始，因 PID 复用断言失败。

2026-10-08 13:57–13:59 UTC，用户批准仅增加 abandon 拿锁后的 hold 等待，保留驱动与全部原断言，通过同一新关缓存 Hyperdrive 一轮七场景退出 0：49 PASS、0 FAIL。六个锁场景 A/B 均不同 PID 与 xid，B 在 A 持锁期间开始事务；提交场景读到增加后的值，回滚/abandon 场景读到原值。B 等待 2558–2749ms；commit/rollback 距事务内 releaseAt 43–50ms 取得锁，abandon 距响应生成时间戳 38–39ms 取得锁。这些时间戳不等于 Hyperdrive 内部实际释放时刻。

八轮释放检查（每轮五次 try-lock/NOWAIT 与五次只读查询）通过，无其他 advisory holder，idle-in-transaction 列表为空。cleanup 返回 200；13:59:36 UTC app 直连终检确认 product_res_staging、探针行数 0、该 advisory key 无持有者、app 超两秒空闲未结束事务为空。临时 preview 已停止、随机 token 文件已删除。五次 `/check` 往返 752/623/743/567/518ms（中位 623ms），包含本机 loopback 代理与 remote preview，不能作为纯数据库或业务 Worker 时延。

[Hyperdrive 会复用源连接](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/)；两次实测详见 [操作记录](./runbooks/staging-neon.md#3-hyperdrive-与切换)。

**对设计的影响 / 使用约束**（建议，供 `docs/04`、`docs/06` 后续实现遵守）：
- 只用事务级的 `pg_advisory_xact_lock`，且必须放在显式事务（`db.transaction()`）中；不在事务中的单条 `SELECT pg_advisory_xact_lock(...)` 在语句结束时即释放，起不到互斥作用。
- 不使用会话级的 `pg_advisory_lock` / `pg_advisory_unlock`：Hyperdrive 以事务为单位复用连接，会话级锁会留在被其他请求复用的连接上（本次未实测，属于事务模式连接池的已知限制）。
- 在取锁的事务中 `SET LOCAL lock_timeout`（如 5s），避免排队过久超出 Worker 请求时长；超时报 `55P03`，按「稍后重试」处理。
- 持锁期间只做数据库操作，不调用外部 API（AI 供应商、支付等）；等待中的请求也各占一条 Hyperdrive 连接。

### cloudflared 副本切换（7.5 实测，2026-10-03）

**结论：两个副本能让链路在单副本故障后自动恢复，但切换不是无感的。** 停掉（`docker stop`）或 kill 其中一个副本后，经 Hyperdrive 的数据库访问会卡住约 5–10 s：期间发起的 `/api/health` 中有 4–14 个（约每 300 ms 一个请求时）超过 Worker 端 5 s 的探测超时返回 503，其余的等到 Hyperdrive 经另一个副本重新连上后一起返回（耗时 3–5.7 s）。优雅停止与 kill 的表现没有明显差别。副本重新启动不会引起任何失败。两个副本全停时，`/api/health` 一直返回 503（前约 5 s 的请求挂到超时，之后约 180 ms 快速失败）；启动后 1.2–1.5 s 恢复。

**测试方法**（`scripts/probes/75-tunnel-failover/`，可重复执行，原始数据在其 `results/` 下）：
- 环境：本机 Docker Desktop（macOS），compose 项目 `product-res` 中的 `product-res-pg` 与两个 `cloudflared` 副本（2026.9.3，QUIC，每个副本 2 条连接，边缘位置均为 `lax*`）。请求的是已部署的 `web-staging`，链路 Worker → Hyperdrive（`product-res-staging`，关缓存）→ Workers VPC → Tunnel → cloudflared → PG。
- 本机每 300 ms 发起一个 `GET /api/health`，不等待上一个返回（单次约 0.65–1.2 s）；`200` 且 `db.status = up` 记为成功。`/api/health` 的数据库探测超过 5 s 即返回 503（`apps/web/src/server/health.ts`），所以「失败」实际是「数据库访问超过 5 s 或报错」。
- 场景依次为：S0 基线 30 s；S1 `docker stop` 副本 1，保持 60 s 后 `docker start`，观察 45 s；S2 对副本 2 同样操作；S3 `docker kill` 副本 1，保持 60 s 后启动；S4 两个副本同时 `docker stop`，保持 30 s 后同时启动，观察 60 s。每次启动后从 `docker logs -t` 中取 2 条 `Registered tunnel connection` 的时刻。
- 共运行 3 轮（每轮约 7.5 分钟、约 1500 个请求）。以下时间都相对该场景的 `docker stop` / `docker kill` 或 `docker start`，单位 s。

**单副本停止 / kill**（S1–S3，统计操作后 20 s 内发起的请求，每个场景约 73 个）：

| 轮 | 场景 | 失败（503） | 成功但 > 3 s | 失败请求的发起时刻 | 受影响请求全部返回 | 启动后失败 | 重新注册（距 `docker start`） |
|---|---|---|---|---|---|---|---|
| 1 | S1 stop 副本 1 | 5 | 1 | 0.6 – 6.3 | 11.4 | 0 | 1.4 / 2.1 |
| 1 | S2 stop 副本 2 | 7 | 7 | 0.7 – 4.3 | 10.0 | 0 | 0.9 / 1.6 |
| 1 | S3 kill 副本 1 | 8 | 8 | −0.2 – 2.8 | 9.4 | 0 | 0.9 / 1.6 |
| 2 | S1 | 5 | 1 | 0.9 – 2.1 | 7.8 | 0 | 0.9 / 1.6 |
| 2 | S2 | 14 | 10 | 0.7 – 14.2 | 19.4 | 0 | 1.2 / 2.2 |
| 2 | S3 | 9 | 7 | −0.2 – 3.1 | 9.4 | 0 | 0.9 / 1.6 |
| 3 | S1 | 4 | 1 | 1.2 – 5.4 | 8.6 | 0 | 0.9 / 1.8 |
| 3 | S2 | 10 | 7 | 0.6 – 7.2 | 14.2 | 0 | 0.9 / 1.6 |
| 3 | S3 | 6 | 9 | −0.2 – 1.3 | 7.2 | 0 | 0.8 / 1.5 |

- 失败几乎都是 5.2–6.0 s 后的 503（Worker 端探测超时），只有 1 个在 1 s 内返回 503（第 3 轮 S1，连接报错）。成功但变慢的请求与失败请求在同一时刻（操作后约 6–10 s）一起返回，说明这段时间所有新请求都在等 Hyperdrive 重建经由另一副本的连接。
- 第 2 轮 S2 在主中断（0.7–4.0 s 发起的请求）之后，7.3 s、13.3 s、14.2 s 发起的请求又各有 1 个超时，其余请求正常，属于切换后的零星长尾。
- `docker stop` 约 1.1 s 完成：cloudflared 收到 SIGTERM 后注销连接（`Unregistered tunnel connection`），日志随即出现 `no more connections active and exiting`，没有等待默认 30 s 的 grace period 去排空 Hyperdrive 的长连接。因此「优雅停止」对 Hyperdrive 并不优雅，与 kill 一样会切断经由该副本的数据库连接。kill 时在途的请求（操作前 0.2 s 发起）也失败。
- 副本重新启动：约 0.8–1.4 s 注册第 1 条连接、1.5–2.2 s 注册第 2 条；启动前后都没有失败，成功请求延迟不变（启动后首个请求 30–300 ms 内发起即成功）。
- 基线（S0）：0 失败，p50 约 650 ms，p95 0.67–1.9 s。

**两个副本全停**（S4，保持 30 s）：

| 轮 | 失败 / 请求 | 全停期间的表现 | 启动后首个成功请求 | 启动后失败 | 重新注册（距 `docker start`，副本 1 / 副本 2） | 中断时长（首个失败发起 → 首个成功发起） |
|---|---|---|---|---|---|---|
| 1 | 106 / 313 | 操作后 0.9 s 起全部失败；5.1 s 前发起的挂到 5 s 超时，之后约 180 ms 返回 503 | +1.52 | 5（发起于启动后 0–1.2 s） | 0.95, 1.7 / 0.9, 1.7 | 31.8 |
| 2 | 107 / 313 | 0.6 s 起全部失败；4.8 s 后快速失败 | +1.54 | 5（0–1.2 s） | 0.9, 1.6 / 0.9, 1.7 | 32.1 |
| 3 | 105 / 312 | 0.8 s 起全部失败；4.1 s 后快速失败 | +1.16 | 3（0.3–0.9 s） | 1.1, 1.8 / 0.9, 1.6 | 31.5 |

- 全停期间没有任何请求成功；中断时长 ≈ 停止时长 + 1.2–1.5 s。
- 恢复所需时间：首条连接注册后 0.3–0.6 s 即有请求成功，不需要等两个副本的全部连接注册完。第 1 轮有 1 个在启动后 1.2 s 发起的请求仍挂到 5 s 超时，其余启动后的失败都是快速 503。
- 全停期间 Worker 端仍按 5 s 超时或快速失败返回 503，没有挂起超过 6 s 的请求；客户端没有出现超时或网络错误。

**测试条件的局限**：两个副本与 PG 在同一台机器、同一个 Docker 网络中，出口经过本机代理（cloudflared 日志中边缘 IP 为 `198.18.0.x`），只测了 `/api/health` 一种请求；数据不代表阶段二的生产环境（§0）。没有测量进行中的写事务被切断时的表现。

**对阶段二的建议**：
- 继续运行至少两个 `cloudflared` 副本，并放到不同的故障域（不同主机或至少不同的进程管理单元）；阶段一两个副本在同一台机器上，本机故障就是 S4。
- 单副本故障按「数据库访问中断 5–10 s」处理，而不是无感：
  - 健康检查告警不要以单次 503 触发，至少连续失败 30 s（或连续 3 次以上检查）再告警；另外单独监控 Tunnel 的连接数（少于 4 条即降级），用于发现单副本故障。
  - 读请求可以在连接错误或超时后重试一次；写请求（尤其计费、积分扣减）必须能安全重试（幂等键），且事务被切断时以回滚为准（7.1 已验证连接断开时事务被回滚、锁被释放）。
- 计划内的 cloudflared 升级或重启要逐个副本进行，两次之间至少间隔 30 s（确认新副本注册了 2 条连接、`/api/health` 恢复正常后再动下一个），并避开流量高峰：每停一个副本都会有一次 5–10 s 的数据库访问卡顿，`--grace-period` 不能避免（cloudflared 不排空 Hyperdrive 的长连接）。
- 阶段二在生产服务器上用同一脚本重测（`HEALTH_URL`、`REPLICA_1`、`REPLICA_2` 可配置），并补测「写事务进行中切断副本」的场景。

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
tag:   数据库迁移(production) → wrangler deploy (jobs 先于 web) → 冒烟测试
```

**staging 自动发布**：`.github/workflows/deploy-staging.yml` 跟随 main 上成功的 `CI`，检出该次 CI 的提交；也可在 main 上手动触发 `workflow_dispatch`。发布使用 GitHub `staging` environment，`staging-deploy` concurrency 串行执行且不取消进行中的运行。PR 的 `ci.yml` 不引用 staging secrets，只操作临时 CI 数据库。

发布顺序为 install → Neon 迁移 → 构建 jobs 与 web → Sentry release / source map 上传 → 部署 jobs → 部署 web → 健康检查 → Playwright `staging` 项目 → finalize release。release 与两个 Worker 的 `APP_VERSION` 均为所检出提交的完整 SHA（`workflow_run.head_sha`，手动运行时为 `github.sha`），与 `/api/health.version` 一致。迁移通过 environment 的 `STAGING_MIGRATION_DATABASE_URL` 直连 Neon，以 `migrator` 执行；Cloudflare 认证使用 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。健康检查每 5 秒轮询、最多 3 分钟，要求 200、`db.status=up`、`version` 等于目标 SHA；之后用 Chromium 检查首页、定价与一次随机邮箱注册。任一步失败即停止发布。

jobs 用 `wrangler deploy --env staging --dry-run --outdir dist --var APP_VERSION:<SHA>` 构建；web 用 `CLOUDFLARE_ENV=staging APP_VERSION=<SHA> vite build`，两个不可达的 Hyperdrive 占位连接保留。构建后 `sentry-cli releases new` 创建 release，分别对 `apps/web/dist/server` 与 `apps/jobs/dist` 执行 `sourcemaps inject`，再以 `--release <SHA> --dist web|jobs --validate --strict --wait` 上传。web/jobs 的独立 dist 避免同名文件冲突，并与各自 SDK 配置一致。上传失败阻止部署；浏览器尚未接入 SDK，CI 在部署前删除 `dist/client` 下的全部 `.map`。SSR 与 jobs map 不在静态 assets 目录内。

部署直接使用注入后的产物：jobs 指定 `dist/index.js --no-bundle` 并再次传入版本 var；web 指定 Vite 生成的 `dist/server/wrangler.json --no-bundle`（包含 staging 绑定与 client assets 路径）。CI 不调用会重新构建的 `deploy:staging` 脚本。Sentry 认证只在上传与 finalize 步骤从 environment secrets 读取，PR CI 不上传。验收与失败排查见 [Sentry runbook](./runbooks/sentry.md)。

GitHub `staging` environment 三项 secrets（`CLOUDFLARE_ACCOUNT_ID`、`STAGING_MIGRATION_DATABASE_URL`、`CLOUDFLARE_API_TOKEN`）已配置，CI token 已验证 active 与当前 account。PR #62 合并为 `ad1b5da` 后的首次自动发布在 web 预渲染阶段失败：本地 Hyperdrive 缺少模拟连接串，迁移与 jobs 已成功。PR #64 合并为 `ce623ca`，在 Deploy web 的环境变量中为两个 Hyperdrive 绑定设置不可达的本地占位连接；仅使预渲染 preview 能启动，快照按既有设计降级为示例数据，绝不连接真实库。其触发的 [Deploy staging run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572) 于 `2026-10-09T06:36:31Z–06:38:28Z` 全部成功：Neon 迁移 → jobs → web → 版本健康检查 → staging 冒烟（`3 passed (10.0s)`）。健康检查匹配完整 `ce623cab63a99d6eee8c8ba67eeb09e564f97779` 且 `db.status=up`，任务 7.4 已验收；本机原三项冒烟（6.2）亦已通过，断言与超时未改。PR3 仅补齐文档与任务记录，9.2 24 小时观察保留未完成。操作与回滚见 [Neon staging runbook](./runbooks/staging-neon.md)。

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

**阶段二私有 PG 迁移**：CI 可运行 `cloudflared access tcp`（需要 §2 的公网主机名 + Access 备选方式）在本地开转发端口，再执行迁移；或通过 SSH 在生产服务器上执行迁移。

**迁移原则**：只做向后兼容的变更（先加字段/表 → 部署代码 → 再删旧字段），保证 web/jobs 滚动发布期间新旧代码都能运行。

**部署顺序**：迁移 → `apps/jobs` → `apps/web`（web 依赖 jobs 中定义的 Workflow / Queue 消费者）。

## 6. 安全清单

- 所有 Webhook 验签；回调 URL 带 HMAC；验签失败记录并告警。
- 线上 Secrets 存 Wrangler secrets；本地真值文件 `.env.local`、app `.dev.vars` 与 SSR 预览 `.dev.vars` 均被忽略，不进 Git、前端资源或公开日志。只提交不含真值的 `.env.example` / `.dev.vars.example`。
- Turnstile + Rate Limiting 保护认证与 AI 接口。
- R2 桶不公开；下载经鉴权签发短期 URL。
- 服务端下载外部 URL 时限制域名白名单、大小与超时（防 SSRF）。
- 管理后台操作写 `audit_log`；模拟登录有明显提示并记录。
- 数据库最小权限账号；自建 PG 只经 Tunnel（Workers VPC 或 Access）访问，不开放公网端口；Neon staging 通过非 pooled TLS 直连，不使用默认 owner 作为 Worker 连接账号。
- 依赖更新：Renovate / Dependabot。

## 7. 可观测性

| 维度 | 工具 |
|---|---|
| 错误 | Sentry（web + jobs，带 release 与 source map） |
| 日志 | Workers Logs（结构化 JSON，含 requestId、workspaceId、userId） |
| 流量 | Cloudflare Web Analytics；产品分析可选 PostHog / Umami |
| AI | AI Gateway 仪表盘 |
| 业务指标 | 管理后台：注册、付费转化、MRR、积分消耗、任务成功率 |
| 数据库 | pg_stat_statements、导出器指标、备份状态 |

Sentry 只在服务端启用，接入 web fetch 与 jobs fetch / Queue / Cron / Workflow；事件经统一
`beforeSend` 脱敏过滤器处理，不采集邮箱、Authorization、Cookie、支付凭据或 AI 对话内容。
事件 release 为完整部署 SHA，dist 为 `web` 或 `jobs`，request ID 标签用于关联 Workers Logs。
管理员测试异常入口需新鲜的实时平台管理员会话、同源 POST 与后台审计；没有公开测试入口。
本地真实事件与合并后 staging 可读堆栈的验收记录见 [Sentry runbook](./runbooks/sentry.md)，
staging 尚未通过前不勾选 OpenSpec 1.2。

## 8. 延迟基线（Phase 0 实测 7.4，2026-10-03）

### 生产初测（2026-10-16，v0.1.0）

`https://app.ezarouter.cc/api/health` 顺序请求 40 次（间隔 1 秒），记录 Worker 内 `db.latencyMs`（Hyperdrive → Neon `aws-us-west-2`，非缓存连接）与 `cf-ray` 入口机房。全部入口为 LAX（开发机经美国西部出口）：

| n | min | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| 40 | 40 ms | 45 ms | 90 ms | 116 ms | 171 ms |

这是单一入口、默认放置下的健康探测往返，只作上线基线；Smart Placement 与显式放置对比需按下文 `scripts/probes/latency/` 部署临时探针 Worker（绑定生产 Hyperdrive、只读 `setting`），2026-10-18 用户决定移交派生项目按真实用户地域执行（原 `add-cloud-production-neon` 5.1，不属于模板验收）。

> **2026-10-03 实测时 staging 数据库在开发者本机，以下历史数据只证明「Worker → Hyperdrive → Workers VPC → Tunnel → 本机 PG」链路可用，不代表当前 Neon 或生产延迟。** 派生项目上线时按实际 Neon 区域与用户地域重新测量放置对比。

### 测试方法

可重复执行的探针在 `scripts/probes/latency/`（部署、运行、清理步骤见其 README）：

- 临时 Worker `probe-74-latency-{off,smart,eu,ap}`，代码相同，只有放置方式不同：关闭放置、Smart Placement、显式放置 `aws:eu-central-1`（实际执行于 FRA）、显式放置 `aws:ap-northeast-1`（实际执行于 NRT）。都绑定 `product-res-staging`（关缓存）。
- 每个 HTTP 请求新建一个 postgres.js 客户端（选项同 `createDb`：`max: 5`、`fetch_types: false`、`prepare: true`），对 `setting` 表顺序执行同一查询 `select value from setting where key = $1` 共 6 次，在 Worker 内计时：第 1 次为**首次建连**（新连接 + prepare），后 5 次为**复用连接**。
- 记录 `request.cf.colo`（入口机房）、Worker 内请求 `cloudflare.com/cdn-cgi/trace` 得到的 `colo`（实际执行机房）、响应头 `cf-placement`。
- **两个以上地区**：本机（经代理出口在美国西部）直接请求时入口固定为 LAX；另用两种方式让 Worker 在其他地区执行：① 显式放置（targeted placement）；② 由显式放置在 FRA / NRT 的探针 Worker 经 `/relay` 转发请求，使 off / smart 两个 Worker 的入口机房分别为 FRA、NRT。
- 每组 60 个请求（60 个首次建连样本、300 个复用连接样本），顺序执行。原始数据在 `scripts/probes/latency/results/`。

本机环境：两个 `cloudflared` 副本的 Tunnel 连接都注册在 LAX（`lax01/08/10/13`），即从 Cloudflare 看，数据库「位于」LAX；每次数据库往返都包含 LAX ↔ 开发者本机（经本机代理）这一段。

### 结果（Worker 内测得的数据库往返，单位 ms，p50 / p95）

| 入口机房 | 执行机房 | 放置 | `cf-placement` | 首次建连 | 复用连接 |
|---|---|---|---|---|---|
| LAX | LAX | 关 | — | 320 / 1576（第 1 轮）；482 / 501（第 2 轮） | 159 / 166；161 / 167 |
| LAX | LAX | Smart | `local-LAX` | 479 / 501 | 162 / 166 |
| LAX | FRA | 显式 `aws:eu-central-1` | `remote-FRA` | 704 / 911 | 312 / 398 |
| LAX | NRT | 显式 `aws:ap-northeast-1` | `remote-NRT` | 670 / 705 | 262 / 272 |
| FRA（经 relay） | FRA | 关 | — | 782 / 889 | 312 / 458 |
| FRA（经 relay） | FRA | Smart | `local-FRA` | 786 / 938 | 314 / 323 |
| NRT（经 relay） | NRT | 关 | — | 695 / 851 | 264 / 281 |
| NRT（经 relay） | NRT | Smart | `local-NRT` | 694 / 726 | 264 / 277 |

对照组（`prepare: false`）：LAX 执行时首次 323 / 377、复用 319 / 347；FRA 执行时首次 630 / 727、复用 621 / 719。

所有测量与预热（Smart Placement 预热约 3,500 个请求）中没有失败请求。

### 结论

1. **链路可用**：LAX、FRA、NRT 三个执行位置经 Hyperdrive（关缓存）查询本机 `product_res_staging` 均成功。
2. **单次往返由「执行机房 → Tunnel 接入点（LAX）→ 本机」决定**：LAX 执行约 160 ms（几乎全部是 LAX ↔ 本机），FRA 约 310 ms，NRT 约 265 ms；不同执行位置之间的差值（约 +150 / +105 ms）就是执行机房到 LAX 的距离。
3. **Smart Placement 在本场景下没有效果**：入口为 LAX 时决定为 `local-LAX`（本来就在 Tunnel 接入点，合理）；入口为 FRA / NRT 时，在约 70 分钟、约 3,000 个请求后仍为 `local-FRA` / `local-NRT`，没有把 Worker 移到 LAX，延迟与关闭时相同。原因未查实，可能是：Smart Placement 主要依据 `fetch` 子请求的耗时，而 Hyperdrive 走的是 TCP socket；探针每个请求还有一次发往本地机房的 `fetch`（trace），可能把判断拉向「留在本地」；流量规模较小。
4. **首次建连的额外开销来自 prepare，而不是与 Hyperdrive 建连**：`prepare: true` 时首次查询约 2–3 次往返、之后每次 1 次往返；`prepare: false` 时每次查询都是约 2 次往返。首次查询是 2 次还是 3 次往返在两轮测量之间不同（LAX 第 1 轮 320、第 2 轮 482），原因未查实（可能与 Hyperdrive 到源站的连接池状态有关）。

### 对设计的影响（建议）

- 保持 `createDb` 的 `prepare: true`（§2）：同一请求内的重复查询只需 1 次往返；改为 `false` 会让每次查询多一次往返。
- 请求内顺序执行的查询次数直接放大延迟（阶段一每次约 160–310 ms）。后续 change 应尽量合并查询（CTE、`returning`、一个事务内少次往返），避免在一个请求中串行多次读库；这一点在阶段二数据库离用户较远时同样适用。
- 不依赖 Smart Placement 把访问数据库的 Worker 移到数据库附近。阶段二若用户与数据库不在同一地区，建议对以数据库为主的 Worker 评估显式放置（`placement.mode = "targeted"`，`region` 或 `host` 指向数据库所在地区），并在阶段二重新测量本基线后再决定。
