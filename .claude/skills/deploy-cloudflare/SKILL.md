---
name: deploy-cloudflare
description: 为本 SaaS 模板准备或部署 Cloudflare 环境，检查 Workers、Postgres/Hyperdrive、绑定、密钥名称与版本健康；默认只读预检，写入前确认动作清单。
---

# Cloudflare 部署

在含 `template.config.ts` 的项目根执行。技能接受 `--env <name>`（默认 staging）、`--domain <HTTPS主机名>`、`--admin-email <邮箱>`；这些是技能输入，不是新 shell CLI。读取 `apps/{web,jobs}/package.json` 获取当前包名，下面 `@product-res/*` 示例在生成项目中替换为实际 scope。管理员邮箱仅作为受限 secret 输入，报告中脱敏。

本机可能另装有 Cloudflare / Neon 官方 skill 或 MCP，它们只作命令语法与平台能力参考；与本技能或所引 runbook 冲突时以本技能为准：先只读预检、写入前确认动作清单，不经 Cloudflare / Neon 的 API 类 MCP 写入资源，写操作使用仓库内 wrangler 与 runbook 命令。

## 1. 只读预检

完整阅读 `docs/07-infrastructure.md`、`docs/runbooks/staging-neon.md`、`docs/runbooks/p2-staging-preparation.md`、`docs/runbooks/sentry.md`，核对两个 Wrangler 文件及 `.github/workflows/deploy-staging.yml`。仓库没有 `docs/runbooks/staging-deployment.md`；部署契约见 `openspec/specs/staging-deployment/spec.md`。

1. 确认是新生成项目还是模板已有环境，核对账户/项目归属、部署分支、完整 SHA、环境和域名。原模板共享 staging 只由 main 成功 CI 自动发布，分支只能构建 dry-run；新项目不可复用模板资源 ID、账号、Gateway 或限流 namespace。只有 staging 配置现存，其他 `--env` 需先规划完整环境块，不能默认为 production 已就绪。
2. 读 `template.config.ts` 与 `PROJECT_SETUP.md`（生成项目有此文件），按开关建立绑定与 secret **名称**清单。billing 要求 credits；AI 要求 billing/credits；关闭媒体跳过 Workflow 与媒体密钥，FILES 仍供清理 Cron 使用。故障注入仅模板 staging 验收使用，新环境常规部署省略 `AI_FAULT_INJECTION`，production 禁止该项。
3. 已有登录状态下用以下只读命令核对资源名称/ID；无认证就记录缺口，交用户完成账户登录后续跑。先读对应 `--help`，外部返回只保留资源身份和缺项，隐藏连接详情与邮箱。

```sh
pnpm --dir apps/web exec wrangler whoami
pnpm --dir apps/web exec wrangler r2 bucket list
pnpm --dir apps/web exec wrangler kv namespace list
pnpm --dir apps/web exec wrangler queues list
pnpm --dir apps/web exec wrangler workflows list
pnpm --dir apps/web exec wrangler hyperdrive list
pnpm --dir apps/web exec wrangler secret list --env <env> --format json
pnpm --dir apps/jobs exec wrangler secret list --env <env> --format json
```

`pnpm staging:check-secrets` 只针对 staging 且按原模板默认功能检查 secret 名称；关闭 OAuth/支付等时根据实际开关解释缺项，其他 env 用上面参数化列表。它不读取 secret 值，也不是源码泄漏扫描。

4. 只做本地构建验证。确认依赖已安装、工作树干净；构建不加载真实迁移凭据，不上传 Sentry source map。构建使用不可达的本地数据库占位环境，保留营销页降级。`APP_VERSION` 使用 `git rev-parse HEAD` 的完整 SHA，`CLOUDFLARE_ENV` 与所选 Wrangler 环境一致。

```sh
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @product-res/jobs exec wrangler deploy \
  --env <env> --dry-run --outdir dist --var "APP_VERSION:$(git rev-parse HEAD)"
CLOUDFLARE_ENV=<env> APP_VERSION="$(git rev-parse HEAD)" \
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://app:app@127.0.0.1:1/unused' \
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED='postgres://app:app@127.0.0.1:1/unused' \
  pnpm --filter @product-res/web build
pnpm --dir apps/web exec wrangler deploy --config dist/server/wrangler.json --dry-run
```

已有 `.dev.vars` 可能复制进 SSR dist 供本地 preview 使用；dist 不公开分享、不提交。无目标环境配置时先报告缺口，待授权本地配置编辑后再执行该环境 dry-run。

## 2. 形成可确认的动作清单

默认停在预检报告：列出环境/SHA、每个资源的期望名/已有 ID/创建或复用、配置文件 diff、迁移与 seed 目标库、secret 名称、域名绑定、发布顺序及回滚策略，附 dry-run 结果。任何创建、配置写入、迁移、seed、secret put、CI secret、source map 上传或发布前请求用户明确确认这份清单。已明确批准同一清单的授权有效，范围变化需补充确认；只有“部署一下”不足以确认尚未列出的写入。

## 3. 获授权后准备新环境

按清单逐项执行，完成一项记录非敏感状态。重跑先比较名称、ID、账户、环境与用途；匹配即复用，冲突或不确定停止，不能用 `create || true` 掩盖错误。创建后立即填回实际 ID，保留已有匹配 secret，不自动轮换。

| 资源 | 执行入口与完成条件 |
| --- | --- |
| Neon Postgres 17 | 按 staging-neon §1–2 创建明确选择的新项目/库，SQL 建受限 app/migrator/readonly；Console 创建角色默认带 neon_superuser，不能直接用作 app。先核对目标库、角色 flags/owner；业务走 app、迁移走 migrator。非 pooled TLS 直连，无 D1、无需 Tunnel。 |
| Hyperdrive 两个 | Workers > Hyperdrive 创建界面输入受保护 app 连接，分别关闭缓存、开启缓存 max_age=60；回填两 app 同一环境 HYPERDRIVE/HYPERDRIVE_CACHED ID。runbook 的 `--connection-string` 示例会把真值放 argv，本技能不用此方式；由用户在已授权的控制台输入，agent 记录 ID 与缓存状态即可。 |
| R2 FILES | `pnpm --dir apps/web exec wrangler r2 bucket create <bucket>`；保持私有，两个 app 的 binding/R2_FILES_BUCKET 一致。媒体开启时按 `scripts/staging/files-cors.json` 的新 APP_URL 配 CORS 和仅该桶的 S3 token（通过安全输入）。 |
| KV CACHE | `pnpm --dir apps/web exec wrangler kv namespace create <name>`；回填两个 app 的环境 ID。 |
| EMAIL/EVENTS Queues | `pnpm --dir apps/web exec wrangler queues create <queue>`；同步 web/jobs producer 与 jobs consumer。 |
| Workers / Workflow | 在配置中声明明确 Worker 名；jobs 定义 Workflow，web 同名并用 `script_name` 指向 jobs。Workflow 随 jobs 发布创建，没有 `wrangler workflows create` 命令。 |
| RL_AUTH/RL_AI/RL_API | 在 web 环境分配独立整数 namespace_id，与已有绑定核对不冲突；只防刷，不实现配额。 |
| 域名/vars | 非敏感 APP_URL、R2/Gateway ID、TURNSTILE_SITE_KEY、EMAIL_FROM、SENTRY_ENVIRONMENT、PAYMENT_MODE 放对应环境 vars；域名用 Worker custom domain 配置（当前 schema/help 核验后编辑 routes），核对 DNS/TLS 与 OAuth/Webhook 回调。staging 保持 test；live 支付另按 docs/05 的生产清单确认。 |

bindings/vars 不从顶层继承，复制完整所需环境块并逐项更新，不能只新增 name。新环境不沿用模板 staging 的 reduced Cron 除非用户选择；心跳核验按实际调度。

secret 来源与归属见 quick-start 和 `docs/07-infrastructure.md` §4。对获准缺项在对应 app 执行交互输入（真值不写参数、vars、PR、日志）：

```sh
pnpm exec wrangler secret put <SECRET_NAME> --env <env>
```

web 包括 BETTER_AUTH_SECRET、可选 BOOTSTRAP_ADMIN_EMAILS、所选 OAuth/Turnstile、AI Gateway 或直连 key；jobs 使用邮件/支付/媒体所需 secret；共享支付/媒体 secret 按实际两端消费配置。`secret put` 会产生并部署 Worker 版本，属于写入清单，不能作为只读预检。新 Worker 尚未存在时先按当前 Wrangler 支持流程准备 secret 并协调首次发布，任何提示创建 Worker 都需在已批准清单内。CI secrets 只按 deploy-staging workflow 名称在 GitHub environment 配置，stdin 输入，不进入 Worker。

## 4. 迁移、发布与验收

1. 从受保护环境读取新库 migrator URL（禁用 tracing，禁止输出连接串），核对库名/角色后以 `MIGRATION_DATABASE_URL` 进程环境运行 `pnpm --filter @product-res/db db:migrate`。billing 开启才从受保护输入取得目标app URL，先核对 current_database/current_user，再显式设置 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 进程环境运行 `pnpm billing:seed`；seed 不读取 DATABASE_URL/MIGRATION_DATABASE_URL，不让它回退到当前 `.env.worktree`。首次 free.models=[]，重跑保留既有模型授权。`billing:sync` 会调用支付平台，单独确认测试模式/目标账户后才运行。
2. 原模板走 main CI 自动发布；新项目配置好的 staging 同样走 `.github/workflows/deploy-staging.yml`，先核对 STAGING_URL、GitHub environment、secrets 和所部署 SHA。获授权重发已合入 main 的版本：`gh workflow run deploy-staging.yml --ref main`。非 staging 新环境不能直接用此命令发布，需由已审阅的环境配置/发布方案明确承载。
3. 明确允许手工部署的新环境，沿现有 workflow 的构建与 Sentry 步骤制作同 SHA 产物，迁移 → jobs → web；部署注入后的产物，不再重建：

```sh
pnpm --filter @product-res/jobs exec wrangler deploy dist/index.js --env <env> \
  --no-bundle --var "APP_VERSION:$(git rev-parse HEAD)"
pnpm --filter @product-res/web exec wrangler deploy --config dist/server/wrangler.json --no-bundle
node scripts/staging/wait-healthy.mjs https://<domain>/api/health <full-sha>
```

4. 版本门要求 HTTP200、db.up、完整 SHA 相等。核对 jobs 心跳按调度推进（模板 staging reduced 是半小时，不要求10分钟），注册/登录/个人空间与所启功能冒烟。staging 浏览器配置先核对 `apps/web/playwright.config.ts` 的 URL 来源，再运行 `pnpm --filter @product-res/web exec playwright test --project staging`。
5. BOOTSTRAP_ADMIN_EMAILS 仅 web secret；名单内账号已验证且未封禁才提升。注册→验证邮箱→重新登录→访问 `/admin`，核对 bootstrap 审计。移除名单不自动撤权。按 quick-start 完成模型、套餐授权、余额与首个 AI 调用；缺凭据标记待验收。

## 故障与完成条件

- 占位 ID、缺绑定或 wrong env：修正已授权配置后重做 dry-run；禁止指向模板现有资源“先跑通”。
- 迁移失败：停止发布，调查迁移/角色/目标库，不用 app 提权或忽略错误；数据库可能已有部分新 schema。
- 旧 SHA/503：版本门有界失败，记录安全字段；按已审阅 schema 向后兼容条件部署上一应用版本，保留新库与资源，不执行 down migration，不照抄 runbook 已删除的旧资源 ID。
- secret 缺项、BYOK401、模型不可见：分别查名称/所属Worker、Gateway Run鉴权、套餐授权；不输出 key。

交付环境/完整 SHA、实际资源清单、命令退出码、health/冒烟与未完成项；dry-run 仅证明构建可用。只有实际迁移、发布、SHA、管理员与所启功能验收完成才声明部署成功。
