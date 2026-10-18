# 09 · 并行开发计划（Orca）

用 [Orca](https://www.onorca.dev/) 并行推进 `docs/08-roadmap.md` 的 8 个阶段：每个 Orca 任务对应一个 git worktree 与一个分支，从 `origin/main` 分出，完成后经 PR 合并回 main。本文规定 worktree 隔离方式、共享文件规则、阶段之间与阶段内部的并行波次，以及合并流程。

## 1. Orca 的工作方式与对本项目的约束

| Orca 特性 | 约束 |
|---|---|
| 新 worktree 默认从仓库 base ref（`origin/main`）分出 | 依赖其他任务成果的任务，必须等被依赖的分支**合并并推送到 main** 后再创建。确需提前开始时，可在创建时选「从本地分支分出」做堆叠，但堆叠层数不超过 1 |
| 「父 worktree」只是侧边栏嵌套显示，不影响分支 | 依赖关系用 orchestration 的任务 DAG 表达，不靠父子关系 |
| Orchestration：run（协调者）+ task DAG + `worker_done` + decision gate | 每个阶段一个 run；需要人工完成的事项（开 VPS、建支付账号、配 CI Secrets）用 decision gate 阻塞相关任务 |
| `orca.yaml` 的 `scripts.setup` / `scripts.archive` 在 worktree 创建 / 归档时运行，可读到 `ORCA_ROOT_PATH`、`ORCA_WORKTREE_PATH`、`ORCA_WORKSPACE_NAME` | 用于给每个 worktree 隔离数据库与端口，见 §2 |
| `orca.yaml` 只在 main（主 checkout）上的版本对新 worktree 生效 | 修改 `orca.yaml` 或 `scripts/orca/` 必须先合并到 main |

## 2. Worktree 隔离

配置文件：`orca.yaml`、`scripts/orca/{lib,setup,archive}.sh`、`.worktreeinclude`。

| 资源 | 方式 |
|---|---|
| 依赖 | 每个 worktree 自己 `pnpm install`（pnpm 全局内容寻址存储，安装很快）。**不共享 `node_modules`**：并行分支会安装不同依赖 |
| 构建缓存 | `.turbo` 通过 `worktree.sharedDirectories` 共享（内容寻址，可安全共享） |
| 本地数据库 | 所有 worktree 共用一个本地 PG 容器 `product-res-pg`；每个 worktree 使用独立数据库 `product_res_wt_<worktree 名>`，setup 时创建、archive 时删除。主 checkout 使用 `product_res_dev` |
| 端口 | 按 worktree 名哈希分配 `20000–29990` 中一个 10 个端口的段，写入 `.env.worktree`（`WEB_PORT`、`JOBS_PORT`、两个 inspector 端口） |
| Hyperdrive 本地连接 | `.env.worktree` 中的 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE(_CACHED)` 指向该 worktree 的数据库（`app` 账号）；`MIGRATION_DATABASE_URL` 为同一库的 `migrator` 账号，供 drizzle-kit 使用 |
| 本地认证配置 | 主 checkout 的 app `.dev.vars` 经 `.worktreeinclude` 复制，认证模板为 `apps/web/.dev.vars.example` |
| 本地支付配置 | 根 `.env.example` 提交占位符；各 worktree 自行创建被忽略的 `.env.local`，不自动复制，避免携带 staging 数据库连接。dev 入口生成/更新 app `.dev.vars` 支付区块，认证配置保留 |
| Miniflare 状态 | `.wrangler/state` 位于各 worktree 目录内，天然隔离 |

P0 实现时必须遵守的约定（setup 脚本依赖它们）：
- `infra/local/docker-compose.yml` 的容器名为 `product-res-pg`，超级用户 `postgres`，映射宿主机 `5432`，初始化脚本创建 `app` 账号（本地密码 `app`，只有 DML）以及 `migrator`（DDL）、`readonly`（SELECT）；单库权限由 `infra/local/initdb/02-db-grants.sql` 设置，setup 脚本对每个 worktree 库执行一次。
- `apps/web` 的 vite 配置与 `apps/{web,jobs}` 的 wrangler 本地开发配置，在 `.env.worktree` 存在时读取其中的端口与连接串，不存在时使用默认值（主 checkout）。

离线 Playwright 的 dev 子进程显式清空五项支付绑定，且不复用已有服务，避免混入联通账号的配置；运行测试的父进程也不能注入支付凭据；先停止本 worktree 已有的 dev 进程，再让 Playwright 自动启动独立服务。当前离线测试不替代真实 test/sandbox 联通。

## 3. 共享文件规则

并行分支最容易在以下文件上冲突，所有 worker 必须遵守：

1. **数据库迁移**：worker 在自己的 worktree 中用 `drizzle-kit push` 把 schema 直接同步到自己的数据库，**不提交迁移 SQL**。分支合并到 main 后，由协调者在 main 上统一 `drizzle-kit generate` 生成迁移并提交。理由：drizzle 迁移带序号和元数据文件，两个分支各自生成必然冲突。
2. **schema 按领域分文件**：`packages/db/src/schema/{auth,tenancy,billing,credits,ai,files,platform}.ts`，每条并行线只改自己领域的文件；汇总导出文件冲突时直接合并两边的导出行。
3. **`routeTree.gen.ts`**：已 gitignore，构建时生成。
4. **`pnpm-lock.yaml`**：冲突时不手工合并，rebase 后在 main 的依赖基础上重新 `pnpm install` 生成，再执行 `pnpm dedupe`。增量 `pnpm add` 可能让带可选 peer 的包（如 drizzle-orm）出现多个实例，CI 用 `pnpm dedupe --check` 与 `pnpm check:singletons` 拦截。
5. **文案文件**：`apps/web/messages/<locale>/<feature>.json` 按功能拆分，避免多条线同时改一个大文件。
6. **OpenSpec `tasks.md`**：worker 只勾选分配给自己的任务编号；change 的归档（`/opsx:archive`）只在 main 上、该 change 全部任务合并后进行。
7. **进程管理**：只结束自己启动的进程（按记录的 PID，或按本 worktree `.env.worktree` 中的端口：`lsof -ti :<端口> | xargs kill`）。**禁止 `pkill -f` / `killall` 等按名称或模式匹配结束进程**：Orca 以 `claude "<任务说明>"` 启动 agent，命令行里含任务说明全文，`pkill -f "vite dev"` 曾误杀其他 worktree 的 agent（P1 W5b）。

## 4. 阶段之间的波次

主线 P0 → P1 → P2 → P3 → P4 是硬依赖；P5、P6、P7 按依赖拆开，跟随主线提前进行。并发上限遵守当前运行时和配置；当前 4 个槽位包含协调者，因此每波最多 3 个 executor。

| 波次 | 主线 | 并行支线 |
|---|---|---|
| W0 | 工程骨架（P0 第 1 组）+ Orca 配置 | 人工：VPS、Cloudflare 资源（P0 5.1–5.3） |
| W1–W2 | P0 剩余部分 | — |
| W3 | P0 平台能力实测 | P7 可观测性；P6 i18n / 主题 / 内容 |
| W4–W5 | P1 | P6 继续；P3 计费函数（纯函数） |
| W6–W8 | P2 | P5 用户管理；P7 Waitlist / Newsletter |
| W9 | P3 注册表 → P3 对话 | P4 存储与 fal.ai 两条线；P6 接入真实定价 |
| W10 | P4 Workflow | P5 计费后台与模型管理 |
| W11 | 整体验收 | P5 审计与指标；P7 通知中心与公开 API |
| W12 | P7 创建项目脚本、文档 | — |

## 5. 阶段内部的任务拆分

记法：每个反引号名称是一个 Orca 任务（一个 worktree / 分支，分支名 `wt/<名称>`），括号内为该 change `tasks.md` 中的编号；`∥` 表示可同时运行；`→` 表示需等前一步合并进 main。

### P0 `setup-scaffold-and-infra`
- W0：`p0-scaffold`（1.1–1.4）在 main 上串行完成
- W1：`p0-config`（2.1, 2.2, 6.1） ∥ `p0-db`（3.1–3.3, 2.3） ∥ `p0-web`（4.1）
- W2：`p0-runtime`（4.2, 4.3, 4.4, 4.5；4.3 依赖 `p0-config` 的 2.2，因此不能放在 W1）
- 基础设施（阶段一，协调者在主 checkout 执行，需要 Cloudflare 账号）：5.1、5.2 → 5.5 → 5.6；CI 部署已移到路线图独立待办；5.3、5.4、6.3 已移到「生产迁移」
- W3：实测 `p0-probe-locks`（7.1） ∥ `p0-probe-workflow`（7.2） ∥ `p0-probe-stream`（7.3） ∥ `p0-probe-latency`（7.4） ∥ `p0-probe-tunnel`（7.5）→ `p0-findings`（7.6）

### P1 `add-auth-and-workspaces`
- `p1-schema`（1.1, 1.2, 2.1） ∥ `p1-email-templates`（3.1）
- → `p1-session`（2.2–2.6，另负责把 Better Auth 挂到 `apps/web` 的 `/api/auth/*` 并新增 `template.config.ts`） ∥ `p1-email-queue`（3.2） ∥ `p1-scoped`（4.3）
- → `p1-workspace`（4.1, 4.2） ∥ `p1-admin-settings`（5.1, 5.2） ∥ `p1-auth-ui`（7.1, 7.2）：都依赖 `p1-session` 的认证挂载，在它合并后开始；前两条线的页面先做不带样式的骨架，样式在 `p1-auth-ui` 合并后统一补
- → `p1-teams`（4.4–4.6）→ `p1-deletion`（6.1–6.4）→ `p1-e2e`（8.1）

### P2 `add-billing-and-credits`
- `p2-schema`（1.1, 1.2, 3.1）
- → `p2-ledger`（2.1–2.7） ∥ `p2-stripe`（3.2） ∥ `p2-paypal`（3.3） ∥ `p2-entitlements`（6.1, 6.2）
  - 2026-10-04 执行约束：先完成 Provider、管线与本地行为验证，不配置支付凭据，不请求真实平台。真实回调录制、平台同步与 staging 支付验收保留 decision gate，到支付联通阶段再配置；没有满足全部验收条件的任务不得提前勾选。
  - 依赖任务可从包含已审阅成果的集成分支创建一层堆叠；每波 executor 数量遵守当前运行时。
- → `p2-webhooks`（4.1–4.3） ∥ `p2-seed-sync`（1.3）
- → `p2-subscriptions`（5.1–5.5） ∥ `p2-signup-bonus`（8.1）
- → `p2-refunds`（7.1–7.4） ∥ `p2-crons`（9.1） ∥ `p2-pages`（10.1, 10.2）
- → `p2-admin-docs`（10.3, 10.4）→ `p2-acceptance`（11.1）

### P3 `add-ai-text-chat`
- `p3-pricing`（1.2，W4 起即可） ∥ `p3-gateway`（2.1）
- `p3-registry`（1.1, 1.3, 1.4，需 P2 权益已合并）
- → `p3-chat-api`（2.2, 2.3） ∥ `p3-model-picker`（3.2）
- → `p3-chat-edge`（2.4–2.6） ∥ `p3-chat-ui`（3.1）→ `p3-acceptance`（4.1, 5.1）

### P4 `add-ai-media-generation`（`p3-registry` 与 `p3-pricing` 合并后即可开始）
- `p4-schema`（1.1）
- → `p4-storage`（2.1–2.4） ∥ `p4-fal`（3.1, 3.2） ∥ `p4-form`（5.1）
- → `p4-submit`（4.1）→ `p4-workflow`（4.2–4.5，串行链，在同一 worktree 内完成） ∥ `p4-cancel-sweeper`（4.6, 4.7）
- → `p4-acceptance`（5.2, 6.1, 7.1）

### P5 `add-admin-console`（按依赖分批开始）
- P1 后：`p5-base`（1.1–1.3）→ `p5-users`（2.1–2.3）
- P2 后：`p5-billing`（3.1, 3.2）
- P3 后：`p5-models`（4.1, 4.2）
- P4 后：`p5-audit-metrics`（5.1–5.3）→ `p5-acceptance`（6.1）

### P6 `add-marketing-i18n-seo`
- W3 起：`p6-i18n`（1.1, 1.3） ∥ `p6-theme`（2.1） ∥ `p6-content`（3.1, 3.3–3.5）
- P1 后：`p6-i18n-user`（1.2, 1.4）
- P2 后：`p6-pricing`（3.2）
- 页面齐全后：`p6-seo`（4.1–4.4）→ `p6-acceptance`（5.1, 5.2）

### P7 `add-observability-and-optional-features`
- W3 起：`p7-obs`（1.1–1.4）
- P1 后：`p7-waitlist-news`（4.1, 4.2）
- P4 后：`p7-notify`（2.1, 2.2） ∥ `p7-public-api`（3.1–3.4）
- 收尾：`p7-agents-md`（5.1）→ `p7-bootstrap`（5.2, 5.3）→ `p7-acceptance`（6.1）

## 6. 用 Orca orchestration 执行

**每个阶段一个 run**，objective 为对应的 OpenSpec change 名。

**每个任务的 spec 模板**：

```
在本 worktree 中执行 /opsx:apply <change>，只做 tasks.md 中的 <编号列表>。
遵守 docs/09-parallel-plan.md §3 的共享文件规则（不提交迁移 SQL，只改 <领域> 的 schema 文件）。
完成标准：pnpm typecheck、pnpm biome check、相关测试通过；只勾选上述编号；推送分支并开 PR 到 main。
完成后发送 worker_done（outcome=succeeded|failed），失败时说明阻塞原因。
```

**启动 worker**（协调者执行）：

`worker-start --agent claude` 启动的 Claude 没有跳过权限确认，worker 会停在等待人工批准的状态，`worker-start` 在 `agent_readiness` 阶段超时失败。新 worktree 的 setup（`pnpm install`、建库）在 `wait-for-setup` 下也会拉长就绪时间。已授权 worker 以 bypass 模式运行，按以下步骤启动：

1. 建 worktree：`orca worktree create`（或 `worker-start --worktree new-top-level --name <名称> --base-branch origin/main --setup run`），等 worktree 中出现 `.env.worktree` 与 `node_modules`，表示 setup 已完成。
2. 在该 worktree 中开 bypass 终端并等待就绪：
   ```
   orca terminal create --worktree path:<worktree 路径> --title <名称> --command "claude --dangerously-skip-permissions --model <模型 id>" --json
   orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 30000 --json
   ```
3. 把任务绑定到该终端，worker 仍受 orchestration 监管（heartbeat、`worker_done`、release 照常）：
   ```
   orca orchestration worker-start --run <run_id> --task <task_id> --terminal <handle> --worktree path:<worktree 路径> --json
   ```
   首次用 `--spec` 而不是 `--task` 也可以。重试失败的任务时加 `--retry-of <dispatch_id>`，且必须是该任务**最新**一次已结束的 dispatch（用 `orca orchestration dispatch-show --task <task_id>` 查）；之前的 dispatch 若为 `reclaimable`，先 `worker-release`。
4. **让用户看到进度**：建 worktree 时加 `--activate`（否则 worktree 留在后台、界面中看不到）；task spec 中要求 worker 在每个检查点执行
   `orca worktree set --worktree path:<worktree 路径> --workspace-status in-progress|in-review --comment "<一句中文进度>"`，进度显示在工作区卡片上；阻塞时写 `阻塞：<原因>`，开完 PR 后改为 `in-review`。
5. **使用 Codex 作为 worker**（协调者仍由 Claude 担任，负责 spec、答复 ask、审阅、合并与清理）：第 2 步的命令换成
   ```
   codex -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier=priority --dangerously-bypass-approvals-and-sandbox
   ```
   `service_tier=priority` 即该模型的 Fast 档位（约 2 倍速度、用量更高）。Codex 不支持 `/opsx:apply` 斜杠命令，spec 中改为「按 `.agents/skills/openspec-apply-change/SKILL.md` 的流程实施」。
6. macOS 默认 shell 为 zsh：批量启动脚本用 `bash` 执行——zsh 中 `for n in $NAMES` 不按空格拆分，`$B:apps/...` 会被当成路径修饰符。

**合并流程**（协调者执行，一次只合并一个分支）：
1. 分支 rebase 到最新 `origin/main`，冲突按 §3 处理。
2. CI 通过、人工审阅 diff 后合并 PR。
3. 若该分支改了 schema：在 main 上 `drizzle-kit generate` 生成迁移、在本地 `product_res_dev` 验证后提交。若该分支的集成测试依赖新表（CI 按迁移建库，否则报 `relation ... does not exist`），改为在合并前于该 PR 分支上生成迁移并推送，CI 通过后再合并；同一波次只允许一个分支携带迁移，避免序号冲突。生成的 `meta/*.json` 提交前先 `biome check --write` 格式化。
4. 推送 main，然后把依赖该任务的后续任务从 blocked 放行（新 worktree 才能从包含该成果的 main 分出）。

**合并后清理 worktree**（协调者执行，不必再询问）：

PR 已合并、合并时已删除远端分支，说明该 worktree 中没有需要保留的内容，直接清理：

1. 确认可以清理：PR 状态为 merged，`git ls-remote --heads origin <分支>` 无结果，且 `git -C <worktree 路径> status --porcelain` 为空。任一条件不满足（如有未提交改动）时先停下，向用户确认。
2. 对已结束的 worker 执行 `orca orchestration worker-release --dispatch <dispatch_id>`；`worker-list --run <run_id> --terminal-state reclaimable` 应返回空。
3. 删除 worktree，**必须带 `--run-hooks`**：
   ```
   orca worktree rm --worktree path:<worktree 路径> --run-hooks --json
   ```
   Orca 默认跳过 `orca.yaml` 的 archive hook，不带 `--run-hooks` 时 worktree 被删除，但 `product_res_wt_<名称>` 数据库会残留。Orca 会一并删除可证明已合并的本地分支；squash 合并无法自动证明时，用 `git branch -D <分支>` 手动删除。
   实测（2026-10-06）：PR 合并、远端分支删除后，Orca 往往会**自动**移除该 worktree 与本地分支，且同样不运行 archive hook。因此即使第 3 步发现 worktree 已不存在，也必须执行第 4 步的数据库核对与补删。
4. 核对：`git worktree list` 中已无该 worktree，`docker exec product-res-pg psql -U postgres -tAc "select datname from pg_database where datname like 'product_res_wt_%'"` 中已无对应的数据库。worktree 已被其他途径删除而数据库残留时，在主 checkout 执行 `ORCA_WORKTREE_PATH=$PWD ORCA_WORKSPACE_NAME=<名称> bash scripts/orca/archive.sh` 补删（脚本只删除 `product_res_wt_` 前缀的库）。

**decision gate 清单**（需要人工完成后放行）：
- P0：Cloudflare 登录 / API Token、本机 `cloudflared` 与 Tunnel、Workers VPC 与 Hyperdrive 配置完成、GitHub Actions Secrets（staging 部署用）配置完成
- 生产迁移（阶段二）：生产服务器、R2 开通、域名与 DNS 权限、异地备份存储
- P1：Google / GitHub OAuth 应用、Resend 域名验证、Turnstile 站点
- P2：Stripe 测试账号、PayPal 沙箱账号与 webhook
- P3：AI Gateway 与至少一家 LLM 服务商的 API Key
- P4：fal.ai API Key、R2 S3 API 令牌
- P7：Sentry 项目、Telegram / Discord 通知渠道（可选）
