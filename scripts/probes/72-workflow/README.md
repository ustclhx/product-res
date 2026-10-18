# 7.2 探针：跨 Worker Workflow 与事件缓冲

`openspec/changes/archive/2026-10-04-setup-scaffold-and-infra/tasks.md` 7.2 的可重复实测。结论见 `docs/06-ai.md` §4「Workflow」下的实测记录。

| 文件 | 作用 |
|---|---|
| `workflow/` | Worker `probe-72-workflow`（模拟 `apps/jobs`）：定义 Workflow `probe-72-wf`（类 `ProbeWorkflow`）。参数 `{ sleepSeconds, waits }`：先 `step.sleep(sleepSeconds)`，再依次 `waitForEvent`；超时被捕获并记入输出 |
| `caller/` | Worker `probe-72-caller`（模拟 `apps/web`）：经 `script_name: "probe-72-workflow"` 绑定上面的 Workflow，提供 `/create`、`/create-and-send`、`/status`、`/event`、`/terminate`，需带 `authorization: Bearer $PROBE_TOKEN` |
| `run.mjs` | 驱动脚本，执行各场景并输出原始 JSON |

不使用数据库，不需要 Hyperdrive 绑定。

## 部署

在仓库根目录执行（用 `apps/jobs` 中安装的 wrangler）：

```bash
export PROBE_TOKEN=$(openssl rand -hex 24)
pnpm --dir apps/jobs exec wrangler deploy -c ../../scripts/probes/72-workflow/workflow/wrangler.jsonc
pnpm --dir apps/jobs exec wrangler deploy -c ../../scripts/probes/72-workflow/caller/wrangler.jsonc \
  --var PROBE_TOKEN:$PROBE_TOKEN
export PROBE_URL=https://probe-72-caller.<workers.dev 子域名>.workers.dev
```

必须先部署 `probe-72-workflow`：caller 的 Workflow 绑定指向它。新部署的 workers.dev 地址可能有几十秒返回 404。

类型检查：`./node_modules/.bin/tsc -p scripts/probes/72-workflow/tsconfig.json`。

## 运行

```bash
cd scripts/probes/72-workflow
node run.mjs                        # 全部短场景（并发执行，约 3 分钟）
node run.mjs baseline multi         # 只跑指定场景

# 保留时长：创建 sleep 60s / 5min / 15min / 60min 的实例并立即发事件，到期后查看
node run.mjs retention-start /tmp/probe-72-retention.json
node run.mjs retention-check /tmp/probe-72-retention.json
```

| 场景 | 内容 |
|---|---|
| `baseline` | 跨 Worker 创建实例、查询状态，实例进入 `waitForEvent` 后 `sendEvent` |
| `early-sleep` | 实例在 `step.sleep(30s)` 中时先发事件，之后的 `waitForEvent` 能否收到 |
| `before-start` | 同一次调用中 `create` 后立即 `sendEvent`（实例尚未开始执行） |
| `multi` | 先发 `a#1`、`a#2`、`b#3`、`other#4`，再依次等待 `b`、`a`、`a`、`a(15s)`：按 type 匹配、同 type 的顺序、是否只消费一次 |
| `dot-type` | type 含 `.`（`media.done`）时 `sendEvent` 与 `waitForEvent` 的行为 |
| `after-complete` | 实例完成后 `sendEvent`；对不存在的实例 `get` |

## 清理

```bash
# 若有未结束的实例（如中途放弃的 retention），先终止
curl -X POST "$PROBE_URL/terminate" -H "authorization: Bearer $PROBE_TOKEN" -d '{"id":"<instance id>"}'

pnpm --dir apps/jobs exec wrangler delete probe-72-caller --force
pnpm --dir apps/jobs exec wrangler delete probe-72-workflow --force
# 删除 Worker 不会删除其中定义的 Workflow（实测），必须单独删除
pnpm --dir apps/jobs exec wrangler workflows delete probe-72-wf
pnpm --dir apps/jobs exec wrangler workflows list | grep probe-72   # 期望无输出
```
