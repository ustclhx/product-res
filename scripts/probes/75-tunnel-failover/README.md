# 7.5 实测：cloudflared 副本切换

验证阶段一 staging 链路（Worker → Hyperdrive → Workers VPC → Tunnel → 本机 `cloudflared` ×2 → Postgres）在一个 `cloudflared` 副本停止、被 kill，或两个副本同时停止时，staging 的 `/api/health` 是否失败、失败多久、恢复多久。结论见 `docs/07-infrastructure.md` §2「cloudflared 副本切换（7.5 实测）」。

| 文件 | 说明 |
|---|---|
| `run.mjs` | 驱动脚本：持续请求 `/api/health`，按场景 `docker stop` / `docker kill` / `docker start` 两个 cloudflared 容器，汇总每个场景的数据 |
| `results/<时间戳>/` | 每次运行的原始数据（见下文「输出」） |

不需要部署任何 Worker，只读访问已部署的 `web-staging`。

## 前置条件

- 本机 compose（项目名 `product-res`）已按 `docs/runbooks/hyperdrive-tunnel.md` 第一节启动：`product-res-pg` 与两个 cloudflared 副本 `product-res-cloudflared-1` / `-2` 都在运行，且各注册了 2 条连接。
- `curl -s https://web-staging.product-res-jobs.workers.dev/api/health` 返回 200、`db.status = up`。
- Node ≥ 22（使用内置 `fetch`）、本机 `docker` CLI 可用。脚本不调用 wrangler，也不需要 Cloudflare 凭据。
- 运行期间不要有其他人依赖 staging：脚本会让 staging 的数据库访问中断数十秒。

## 运行

在仓库根目录执行（默认参数约 8 分钟）：

```bash
node scripts/probes/75-tunnel-failover/run.mjs
```

依次执行的场景（请求按「发起时刻」归属场景）：

| 场景 | 操作 |
|---|---|
| S0 | 基线：两个副本都在运行，`BASELINE_MS`（30s） |
| S1 | `docker stop` 副本 1，保持 `HOLD_MS`（60s），`docker start`，再观察 `SETTLE_MS`（45s） |
| S2 | 对副本 2 做同样的事 |
| S3 | `docker kill` 副本 1（SIGKILL，无优雅关闭），保持 60s，启动，观察 45s |
| S4 | 两个副本同时 `docker stop`，保持 `BOTH_HOLD_MS`（30s），同时启动，观察 `FINAL_MS`（60s） |

请求循环每 `INTERVAL_MS`（300ms）发起一个请求，不等待上一个返回（单次请求约 1.2s，串行无法达到该频率）；客户端超时 `TIMEOUT_MS`（20s）。上述参数都可用同名环境变量覆盖，容器名用 `REPLICA_1` / `REPLICA_2`，地址用 `HEALTH_URL`。

每次 `docker start` 后，脚本读取该容器 `docker logs -t --since <启动时刻>`，等待 2 条 `Registered tunnel connection`，记录各自距启动的毫秒数与边缘位置。

## 输出

终端打印失败请求与汇总表；`results/<时间戳>/` 下保存：

| 文件 | 内容 |
|---|---|
| `config.json` | 本次参数 |
| `requests.ndjson` | 每个请求：`seq`、`start` / `end`（相对运行开始的 ms）、`ms`、`status`、`db`、`dbLatencyMs`、`colo`、`error`、`ok`（200 且 `db.status = up`） |
| `events.ndjson` | 场景开始、`stop` / `stopped` / `kill` / `killed` / `start` / `registered` 的时刻（`t` 相对运行开始的 ms，`at` 为墙钟时间） |
| `product-res-cloudflared-*.log` | 运行期间两个副本的日志（`docker logs -t`） |
| `summary.json` | 每个场景的汇总（字段见下） |

`ok = false` 的含义：`503 / db=down` 为 Worker 端 5s 数据库探测超时或连接错误（`apps/web/src/server/health.ts`）；`status = 0` 为客户端超时或网络错误。

`summary.json` 中的时间都相对该场景第一个 `docker stop` / `docker kill`（单位 ms），请求按**返回**时刻归属场景（操作前已发出、因操作而失败的请求算在该场景）：

| 字段 | 含义 |
|---|---|
| `requests` / `failed` / `failureKinds` | 场景内的请求数、失败数与失败类型 |
| `firstFailureStart` / `lastFailureStart` / `recoveredStart` / `outageMs` | 首个与最后一个失败请求的发起时刻、其后首个成功请求的发起时刻、两者之差 |
| `afterStop` | 操作前 2s 到 `docker start` 之间发起的受影响请求：失败数 `failed`、成功但超过 `SLOW_MS`（3s）的 `slowOk`、发起区间与最后一个返回的时刻 `lastEnd` |
| `afterStart` / `firstOkAfterStartMs` | `docker start` 后 20s 内的受影响请求；启动后首个成功请求距启动的毫秒数 |
| `registered` | 每个容器 2 条 `Registered tunnel connection` 距 `docker start` 的毫秒数 |
| `stopTookMs` | `docker stop` 命令本身的耗时 |
| `okLatency` | 成功请求的 p50 / p95 / max |

修改汇总逻辑后可对已有数据重新汇总（覆盖该目录的 `summary.json`，不操作容器、不发请求）：

```bash
node scripts/probes/75-tunnel-failover/run.mjs --analyze scripts/probes/75-tunnel-failover/results/<时间戳>
```

`results/` 中保留了 2026-10-03 的 3 轮原始数据（`docs/07-infrastructure.md` 中的表格据此整理）。

## 恢复

脚本正常结束、出错或被 Ctrl-C 中断时都会对未运行的副本执行 `docker start`。手动核对 / 恢复：

```bash
docker start product-res-cloudflared-1 product-res-cloudflared-2
docker logs --since 5m product-res-cloudflared-1 2>&1 | grep "Registered tunnel connection"   # 期望 2 条
docker logs --since 5m product-res-cloudflared-2 2>&1 | grep "Registered tunnel connection"
pnpm --dir apps/web exec wrangler tunnel info product-res-local    # Status: healthy
curl -s https://web-staging.product-res-jobs.workers.dev/api/health         # 200，db.status = up
```

不要用 `docker compose ... up` 恢复：在没有 `infra/local/.env` 的 worktree 中执行会以空的 `TUNNEL_TOKEN` 重建容器。`docker start` 复用原容器及其环境变量。
