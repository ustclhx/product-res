# 7.1 实测：Hyperdrive 下的事务、行锁与 advisory lock

验证经 Hyperdrive（关缓存）时，显式事务中的 `SELECT ... FOR UPDATE` 与 `pg_advisory_xact_lock` 能让并发请求串行执行，且事务提交 / 回滚 / 被丢弃后锁都会释放，连接池中不残留锁。结论见 `docs/07-infrastructure.md` §2「事务与锁（7.1 实测）」。

| 文件 | 说明 |
|---|---|
| `worker.ts` | 临时 Worker `probe-71-locks`，绑定 Hyperdrive `product-res-staging`（关缓存）；连接参数与 `packages/db` 的 `createDb()` 相同（postgres.js，`max: 5`、`prepare: true`、`fetch_types: false`） |
| `run.mjs` | 本机驱动脚本：发起并发请求、判定结果、打印原始 JSON 与汇总表 |
| `wrangler.jsonc` | 临时 Worker 配置；本目录不是 workspace 包，经 `alias` 借用 `packages/db` 安装的 postgres.js |

## 测什么

`GET /lock?mode=row|advisory|none&end=commit|rollback|abandon&hold=<ms>` 在一个事务中：

1. 记录开始时刻与后端 pid；`SET LOCAL lock_timeout`（默认 20s，防止后到者永久挂起）；
2. 取锁：`row` 为 `SELECT ... FROM setting WHERE key='probe.7.1.row' FOR UPDATE`，`advisory` 为 `pg_advisory_xact_lock(710001)`，`none` 为不加锁的对照组；取锁时刻在同一条语句中用 `clock_timestamp()` 取得；
3. 读计数器 → `pg_sleep(hold)` → 写回计数器 +1（读-改-写，锁失效时会丢失更新）；
4. `commit`：正常提交；`rollback`：回调中抛错，postgres.js 发出 `ROLLBACK`；`abandon`：拿到锁后立即返回响应、事务既不提交也不回滚，Worker 结束后客户端连接被丢弃。

所有时间点都取数据库时钟 `clock_timestamp()`，A、B 两个请求的时间可以直接比较。

`run.mjs` 对每个场景先发 A（持锁 3s），800ms 后发 B（持锁 0.5s，正常提交），判定：

- A、B 使用不同的后端连接；B 在 A 持锁期间开始事务；
- B 拿到锁的时刻晚于 A 持锁结束（`commit` / `rollback`）或 A 的响应返回（`abandon`）；
- B 读到的计数器：A 提交时为 A 写入后的值，A 回滚 / 被丢弃时为原值；
- 之后串行 5 次 `GET /check?tryLock=1`（新事务中 `pg_try_advisory_xact_lock` 与 `FOR UPDATE NOWAIT` 均立即成功），并发 5 次 `GET /check`（`pg_locks` 中无其他会话持有该 advisory key，`pg_stat_activity` 中无事务时长超过 2s 的 `idle in transaction` 连接）。

对照组 `none`：B 不等待、读到旧值，两次 +1 后计数器只增加 1。

数据只使用 `setting` 表中 key 为 `probe.7.1.row` 的一行（`/setup` 插入，`/cleanup` 删除所有 `probe.7.1.` 开头的行）。

## 部署、运行、清理

在仓库根目录执行；需要本机 PG 与 `cloudflared`（compose profile `tunnel`）在运行，且 wrangler 已登录。

```bash
# 1. 部署（PROBE_TOKEN 只在本次部署中使用，不写进仓库）
export PROBE_TOKEN=$(openssl rand -hex 16)
pnpm --dir apps/web exec wrangler deploy -c ../../scripts/probes/71-locks/wrangler.jsonc --var "PROBE_TOKEN:$PROBE_TOKEN"

# 2. 运行（参数为轮数，默认 3；每轮 7 个场景，约 3 分钟）
#    新部署的 workers.dev 地址可能要等几十秒才生效，setup 返回 404 时稍后重试
PROBE_URL=https://probe-71-locks.product-res-jobs.workers.dev node scripts/probes/71-locks/run.mjs 3

# 3. 清理：run.mjs 结束时已调用 /cleanup 删除 probe.7.1.* 行（KEEP_ROWS=1 时保留）；最后删除 Worker
pnpm --dir apps/web exec wrangler delete -c ../../scripts/probes/71-locks/wrangler.jsonc --force
```

运行中途中断时，先手动 `curl -H "x-probe-token: $PROBE_TOKEN" $PROBE_URL/cleanup` 再删除 Worker。

可选的旁证（只读，在本机以超级用户查看）：

```bash
docker exec product-res-pg psql -U postgres -d product_res_staging \
  -c "select pid, state, now()-xact_start as xact_age, now()-backend_start as conn_age from pg_stat_activity where datname='product_res_staging'" \
  -c "select * from pg_locks where locktype='advisory'"
```
