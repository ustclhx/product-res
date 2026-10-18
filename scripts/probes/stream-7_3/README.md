# 7.3 实测：流式响应 + `waitUntil` 读完源流

验证 `docs/06-ai.md` §3 文本对话第 5 步的假设：服务端把模型流 tee 一份放进 `ctx.waitUntil` 读完（AI SDK 的 `ctx.waitUntil(result.consumeStream())`），客户端中途断开后仍能读完并写库；并测出响应结束 / 客户端断开后 `waitUntil` 还能运行多久。结论见 `docs/06-ai.md` §3「客户端中断不影响结算」「兜底」。

## 组成

| 文件 | 作用 |
|---|---|
| `worker.js` | 临时 Worker `probe-73-stream`：`GET /stream` 产生模拟的模型流，`GET /results` 列出结果，`POST /cleanup` 删除结果 |
| `wrangler.jsonc` | 绑定阶段一 staging 的关缓存 Hyperdrive（`product-res-staging`）；`postgres` 通过 `alias` 借用 `packages/db` 安装的 postgres.js |
| `run.mjs` | 客户端：串行跑各场景，按时断开，最后汇总服务端写库结果 |

`/stream` 参数：`run`（运行 ID）、`total`（源流持续秒数）、`interval`（每块间隔毫秒，默认 500）、`mode`：

- `tee`：源流 tee 成两路，一路作为响应体，另一路在 `ctx.waitUntil` 中读完（被测写法）
- `nowait`：同 `tee`，但读完的 promise 不交给 `waitUntil`（对照组）
- `detached`：立即返回短响应，源流只在 `waitUntil` 中读完（测响应正常结束后的余量）

服务端读流时每 5 秒写一次 `setting` 行 `probe.7_3.<run>.progress`（已读块数、已用时间），读完写 `probe.7_3.<run>.done`；请求开始时写 `probe.7_3.<run>.start`。被中止的运行只留下最后一次 `progress`，从中可以看出在第几秒被终止。

## 运行

前置：阶段一 staging 链路可用（本机 `product-res-pg` 与 `cloudflared` 在运行，见 `docs/runbooks/hyperdrive-tunnel.md`），wrangler 已登录。

```bash
cd scripts/probes/stream-7_3
W=../../../apps/web/node_modules/.bin/wrangler

$W deploy                                                   # 部署 probe-73-stream
$W tail --format json > tail.jsonl &                        # 可选：记录每个请求的 outcome
node run.mjs https://probe-73-stream.<子域名>.workers.dev    # 全部场景约 16 分钟
node run.mjs https://probe-73-stream.<子域名>.workers.dev tee-60   # 只跑一个场景
```

刚部署后第一个请求可能返回 Cloudflare 的错误页（workers.dev 路由尚未生效），几秒后重试即可。

输出表格各列：`sourceSec` 源流总时长、`clientSec` 客户端断开（或读完）的时刻、`serverChunks` 服务端读到的块数、`serverDone` 是否写了 `done` 行、`lastWriteSec` 最后一次写库距请求开始的秒数。

## 清理

```bash
curl -X POST https://probe-73-stream.<子域名>.workers.dev/cleanup   # 删除 probe.7_3.* 行
$W delete probe-73-stream
```
