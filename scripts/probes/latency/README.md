# 7.4 延迟基线探针

`openspec/changes/archive/2026-10-04-setup-scaffold-and-infra/tasks.md` 7.4 的可重复实测。结论见 `docs/07-infrastructure.md` §8。

> 阶段一的数据库在开发者本机（docs/07 §0），本探针的数据只证明链路可用，不代表生产延迟。

## 测什么

`worker.js` 的 `GET /probe`：每个 HTTP 请求新建一个 postgres.js 客户端（选项与 `packages/db` 的 `createDb` 相同），经 `HYPERDRIVE`（`product-res-staging`，关缓存）对 `setting` 表执行同一查询 `select value from setting where key = 'probe.7.4.latency'` 共 1 + 5 次：

- `firstMs`：新客户端的第一次查询（包含与 Hyperdrive 建连与 prepare）；
- `reusedMs`：同一连接上后续 5 次查询；
- `requestColo`：`request.cf.colo`（请求进入的机房）；
- `executionColo`：Worker 内 `fetch('https://www.cloudflare.com/cdn-cgi/trace')` 返回的 `colo`，即 Worker 实际执行的机房；
- 响应头 `cf-placement`：`local-XXX` / `remote-XXX`（Smart Placement 或显式放置时由平台添加）。

`?prepare=0` 是对照组（postgres.js `prepare: false`）。

`GET /relay?to=<off|smart|...>`：从本 Worker 的执行位置请求另一个 probe Worker 的 `/probe`，使目标 Worker 的入口机房不在本机附近（例如经 `probe-74-latency-eu` 转发，目标的 `requestColo` 为 FRA）。

计时用 `Date.now()`：Workers 中时钟只在 I/O 时推进，测得的就是等待数据库的时间。

## 临时 Worker（`wrangler.jsonc` 的各个环境）

| 环境 | Worker | 放置 |
|---|---|---|
| （顶层） | `probe-74-latency-off` | `placement.mode = off` |
| `smart` | `probe-74-latency-smart` | Smart Placement |
| `eu` | `probe-74-latency-eu` | 显式放置 `aws:eu-central-1`（实际执行于 FRA） |
| `ap` | `probe-74-latency-ap` | 显式放置 `aws:ap-northeast-1`（实际执行于 NRT） |

都只绑定 `HYPERDRIVE`（关缓存）。`postgres` 通过 `alias` 从 `packages/db/node_modules` 解析（`scripts/` 不是 workspace 包）。

## 运行

在仓库根目录执行，`W` 表示 `pnpm --dir apps/web exec wrangler`；需要阶段一 staging 链路正常（`docs/runbooks/hyperdrive-tunnel.md`）。

```bash
# 1. 准备查询的行（app 账号只有 DML）
docker exec product-res-pg psql "postgres://app:app@localhost:5432/product_res_staging" -c \
  "insert into setting (id, key, value) values (gen_random_uuid(), 'probe.7.4.latency', '{\"probe\":\"7.4\"}') on conflict (key) do nothing"

# 2. 部署（配置路径须为绝对路径，因为 pnpm --dir 会切换工作目录）
for e in "" smart eu ap; do W deploy -c "$PWD/scripts/probes/latency/wrangler.jsonc" ${e:+--env} ${e:+$e}; done

# 3. 测量（每个 Worker 默认 60 次请求，即 60 个首次建连样本、300 个复用连接样本）
node scripts/probes/latency/run.mjs --workers off,eu,ap --out /tmp/latency.json
node scripts/probes/latency/run.mjs --workers off,eu --prepare 0           # 对照组
node scripts/probes/latency/run.mjs --workers off,smart --via eu           # 入口机房在 FRA
```

Smart Placement 需要先有一段持续流量才会做出放置决定：先持续请求 `probe-74-latency-smart`（本机直连，或经 `/relay` 从其他地区），观察 `cf-placement` 从 `local-`（尚未分析）变为 `local-XXX` 或 `remote-XXX` 后再测量。本次本机直连数分钟后变为 `local-LAX`；经 FRA / NRT 转发约 70 分钟后仍为 `local-FRA` / `local-NRT`。

`results/` 中是 2026-10-03 的原始数据（汇总与每个请求的样本）。

## 清理

```bash
for e in "" smart eu ap; do W delete -c "$PWD/scripts/probes/latency/wrangler.jsonc" ${e:+--env} ${e:+$e} --force; done
docker exec product-res-pg psql "postgres://app:app@localhost:5432/product_res_staging" -c \
  "delete from setting where key like 'probe.7.4.%'"
```

## 局限

- 只有开发者本机一个客户端位置，本机经代理出口在美国西部，请求固定进入 LAX；「其他地区」用显式放置（targeted placement）和 `/relay` 模拟，不是真实的异地用户。
- 显式放置使用 AWS 区域名，平台映射到附近的 Cloudflare 机房（`aws:eu-central-1` → FRA、`aws:ap-northeast-1` → NRT），映射关系可能变化，以 `executionColo` 为准。
- 数据库在本机、Tunnel 接入点在 LAX，延迟主要由「接入机房 ↔ 开发者本机」的网络决定，与生产服务器无关。
