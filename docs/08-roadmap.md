# 08 · 开发计划

每个阶段结束时都应该能部署到 staging 并完成验收。阶段内顺序即建议的实现顺序。

**进度基线（2026-10-18，main `a2381f8` / #242）**：以下状态已核对 `openspec list --json`、各 change 的 `tasks.md`、归档与 main 已合并 PR。功能项勾选表示对应任务的实现与规定验证已完成；阶段整体验收另列，代码合并或本地模拟通过不替代 staging 验收。进行中的其他 worktree 不计入完成项。

每个阶段对应一个 OpenSpec change（`openspec/changes/<name>/`），实现时用 `/opsx:apply <name>` 按其 `tasks.md` 推进，全部验收完成后由协调者归档：

| 阶段 | OpenSpec change | 已验收任务 / 状态 |
|---|---|---|
| Phase 0 | `setup-scaffold-and-infra` | 26/26；已归档：`archive/2026-10-04-setup-scaffold-and-infra` |
| Phase 1 | `add-auth-and-workspaces` | 25/25；已归档：`archive/2026-10-04-add-auth-and-workspaces`（#22） |
| Phase 2 | `add-billing-and-credits` | 32/34；2026-10-15 Cloudflare 部分结项并归档（#215），3.3、11.1 剩余项转入 `add-cloud-acceptance-followups` |
| Phase 3 | `add-ai-text-chat` | 17/17；已归档：`archive/2026-10-15-add-ai-text-chat`（#209） |
| Phase 4 | `add-ai-media-generation` | 22/22；已归档：`archive/2026-10-15-add-ai-media-generation`（#209） |
| Phase 5 | `add-admin-console` | 13/14；2026-10-15 结项并归档（#215），6.1 仅剩失败回调重放，转入 `add-cloud-acceptance-followups` |
| Phase 6 | `add-marketing-i18n-seo` | 16/16；已归档：`archive/2026-10-11-add-marketing-i18n-seo`（#86） |
| Phase 7 | `add-observability-and-optional-features` | 16/16；已归档：`archive/2026-10-14-add-observability-and-optional-features`（#184） |
| 验收承接 | `add-cloud-acceptance-followups` | main 为 0/4；另一 worker 正在处理 staging 支付验收，尚未合并的结果不计入完成项 |
| Cloudflare 生产 | `add-cloud-production-neon` | 模板范围 13/13（本次结项）；演示实例于 2026-10-18 拆除，合并后由协调者同步规格并归档；原 5.1 / 6.1 移交派生项目 |
| 自托管 | `add-selfhost-*`（四个 change） | 116/116；2026-10-17 已同步规格并归档（#239） |

已归档的其他 change：`add-cloud-staging-neon` 29/29（#85）、`add-first-run-admin-setup` 6/6 与 `add-payment-live-mode` 9/9（#184）、`add-text-reasoning-resilience` 9/9（#196）、`add-staging-fault-injection` 20/20（#209）、`add-agent-skills` 8/8（#211）。live 模式只交付代码，生产凭据与外部收款验收见下文「Cloudflare 生产上线」与 Q9。

**自托管形态**（Node + Docker Compose，PG 在 Compose 内）：**2026-10-17 结项并归档**。四个 change 全部完成（foundation 33/33、job-engine 32/32、storage-observability 18/18、delivery 33/33），已同步主 spec 并归档为 `archive/2026-10-17-add-selfhost-*`。服务器验收在新加坡测试主机 `product-res-ecs`（2 vCPU / 3.5 GiB）用正式 release `1888e7d` 完成：真实 ACME（`selfhost.ezarouter.cc`）、R2 外部存储与备份（用户决定单一供应商：同一 R2 账号下独立桶与桶级 token，已记录失去供应商独立性）、两路时间点与逻辑恢复、2 核整机任务预算与真实整机 reboot（21 项恢复检查通过）。证据见 [server-acceptance-1888e7d](./runbooks/evidence/selfhost/server-acceptance-1888e7d/report.md)。

**实例状态（2026-10-18）**：用户确认拆除模板演示的生产实例与自托管测试实例，验收勾选保留为历史交付结果。生产云资源与自托管栈已清理；四个非空 R2 桶待 2026-10-19 核空删除，DNS / Sentry 与桶级 token 手动收尾见[拆除记录](./runbooks/evidence/teardown-2026-10-18.md)。生产配置、workflow、GHCR 镜像与 runbook 保留供派生项目使用；staging 全部资源保留。

各阶段之间与阶段内部的并行拆分见 [09-parallel-plan.md](./09-parallel-plan.md)。

**基础设施节奏**（`docs/07` §0）：阶段二的模板生产与自托管能力已完成验收，演示实例于 2026-10-18 拆除；本地开发继续使用各 worktree 的隔离 Docker PG 数据库，线上 staging 使用 Neon Launch 并部署到 `*.workers.dev`。派生项目保留 **Cloudflare 生产使用 Neon 付费档、不自建 PG** 的路径（2026-10-15 用户决定，原「生产服务器 PG + cloudflared + Workers VPC」方案作废）；**自托管形态使用 Compose 内的 PG**，其备份/PITR/副本由 `add-selfhost-*` 交付。

## Phase 0 · 脚手架与基础设施验证（技术风险最高，优先做）

- [x] pnpm monorepo、Biome、TypeScript、Vitest 基础配置（`setup-scaffold-and-infra` 1.1–1.4）
- [x] `apps/web`：TanStack Start 跑在 workerd（Cloudflare Vite 插件），本地 + 部署各一次（staging：`web-staging.product-res-jobs.workers.dev`；#3、P0 5.5）
- [x] `apps/jobs`：导出一个空 Workflow + Queue consumer + Cron，web 能通过绑定调用（#5）
- [x] 本地 Docker PG + Drizzle + 第一个迁移（#4）
- [x] 本机 PG（TLS）+ `cloudflared` + Tunnel + Workers VPC + Hyperdrive，部署到 `*.workers.dev` 的 Worker 查询成功；记录延迟基线（开/关 Smart Placement 对比，仅验证链路）——复用连接约 160 ms（LAX），Smart Placement 无效果（#9、P0 5.1/5.2；`07` §8）。这是历史链路验证，旧资源已在 Neon 9.2 收尾时删除。
- [x] 验证 Hyperdrive 下的事务 + `SELECT ... FOR UPDATE` + `pg_advisory_xact_lock`——可用，锁在提交 / 回滚 / Worker 中断后都释放（#6；`07` §2）
- [x] 验证跨 Worker（`script_name`）的 Workflow 绑定与 `sendEvent`；确认 Workflow 尚未执行到 `waitForEvent` 时收到的事件是否被缓存——可用，提前发出的事件至少保留 60 分钟；事件类型不能含 `.`（#8；`06` §4）
- [x] 验证流式响应中客户端断开后，`waitUntil(consumeStream())` 能否完成结算——可以，但限于断开后 30 秒，超时静默取消（#7；`06` §3，P3 已接入检查点与兜底）
- [x] 本机两个 `cloudflared` 副本，停掉其中一个时 Hyperdrive 查询不中断——会自动切换，但有约 5–10 秒卡顿与少量失败，不是无感（#10；`07` §2）
- [x] `template.config.ts` + env Zod 校验（#2、#5）

**验收**：staging（`*.workers.dev`）首页 SSR 正常；`/api/health` 返回 DB 往返耗时；jobs 的 Cron 能写库。——已通过（2026-10-03，`web-staging.product-res-jobs.workers.dev`）。CI 自动部署 staging（原任务 6.2）已移到下文「CI 能力建设」。

**Phase 0 实测对后续阶段的影响**：

- P3（文本对话）：客户端断开后服务端只能再运行 30 秒，长回复可能来不及结算；已决定采用「用量检查点」（`06` §3，已写入 `add-ai-text-chat`），兜底按检查点用量而不是最低费用结算。
- P4（媒体）：事件类型使用 `@product-res/shared` 的 `MEDIA_DONE_EVENT = 'media-done'`；保留等待前 `check-callback` 与超时后 `recheck-callback`，结果以已落库回调为准，事件只用于唤醒（#73；`06` §4）。
- 阶段二：Cloudflare 生产已改用 Neon，不再建设 `cloudflared`；原副本切换建议留作自建 PG 后路。生产延迟放置对比（原 5.1）移交派生项目按用户地域评估，见 `07` §8。

## Phase 1 · 认证与 Workspace

- [x] Better Auth：邮箱密码、邮箱验证、找回密码、Google/GitHub OAuth 接口与模拟回调、Turnstile（#15、#20；真实 OAuth 提供方交换不在 P1 验收声明内）
- [x] KV secondaryStorage；认证接口限流（#15）
- [x] Resend 适配器 + React Email + EMAIL_QUEUE（#11、#14、#21；P1 外部投递仍为 mock/log 验收）
- [x] 注册自动创建个人空间；`withSession` / `withWorkspace` 中间件；`scoped()` 查询工具（#13、#16）
- [x] `multiTenant` 开关：团队空间创建、邀请、成员角色、空间切换器（#20）
- [x] 平台 admin 角色与 `/admin` 入口骨架（#17）
- [x] 用户设置：资料、语言、时区、修改密码、删除账号（软删 + 匿名化；默认不退款与客服入口，退款申请提醒已在 P2 接入；#17、#20、#24）
- [x] 敏感操作直接查库校验会话；席位上限的并发控制（#15、#20）

**验收进度（2026-10-04）**：本地两种开关模式下的注册 → 邮箱验证 → 登录 → 邀请 → 切换空间流程均通过 e2e，包含团队删除、账号匿名化和旧会话吊销；关闭团队为 12 passed / 1 skipped（魔法链接关闭），开启团队与魔法链接为 13 passed。staging 已完成现有认证迁移、测试密钥上传与 web / jobs 部署；线上认证 / 模拟 OAuth 回调为 9 passed / 1 skipped，log 邮件队列、新 Cron 与删除后旧会话拒绝均已验证。邀请邮件队列接线回归也已通过，OpenSpec 为 25/25。OAuth 入口与回调策略通过模拟外部交换验证，尚未使用真实提供方凭据验收。

**P1 阶段边界与后续接入**：三项正式规格已同步，25/25 任务已归档。P1 的真实 OAuth 提供方交换与 Resend 外部发送不在当时 mock/log 验收声明内；后续接入与验收进度分别见 P2–P4。当时 CI 自动部署 staging 仍是单列待办，采用手动部署；当前完成情况见下文「CI 能力建设」。

## Phase 2 · 计费与积分

**进度（2026-10-12；2026-10-15 已归档，剩余项见「Cloudflare 剩余验收」）**：结项时 OpenSpec 32/34。离线实现与组合验收已完成（#24）；两平台测试凭据已配置，10 条报价同步及幂等复验通过（1.3）。Stripe 真实录制夹具、测试卡订阅/积分包、测试时钟续费与平台退款已验收（#63、#71）。PayPal 积分包 capture 与重复事件、月付首付、取消/恢复已取得有限沙箱证据（#82、#90），但自然续费、年付、换套餐、退款及完整录制矩阵仍待办。10.4 文档核对已完成；3.3、11.1 的剩余验收已转入 followups，见 [支付联通 runbook](./runbooks/p2-payment-integration.md) 与 [Stripe 验收](./runbooks/p2-acceptance-stripe.md)。

- [x] `plan` / `plan_price` 种子数据与同步脚本（Stripe、PayPal；billing 1.3，两平台同步两次、映射稳定且 active，证据见支付联通 runbook）
- [x] `packages/credits`：grant / hold / capture / release / expire，含并发测试（#24、#27）
- [x] Stripe Provider：订阅 + 积分包 Checkout、Webhook、Portal（#71；billing 3.2）
- [ ] PayPal Provider（剩余录制转入 followups 2.1）：Orders capture、Subscriptions、Webhook 验签、自建取消；代码已合并，8 条真实 Sandbox 回调录制已覆盖一次性付款、月付首付、暂停/恢复及独立测试卡 Capture 全额退款；自然续费、Sale 退款与 Capture 部分退款录制等仍待办（#82、#90；billing 3.3；见 [05 §2](./05-billing.md#2-支付-provider-抽象)）。
- [x] Webhook 通用管线（按投递去重、登记/处理分事务、失败记录、重放；#24、#28）
- [x] 权益 `can()` / `limit()`（读取时计算生效状态）；free 档与注册赠送（验证后发放、防刷；#24）
- [x] 结账前置检查；换套餐 / 换平台的订阅重叠期（#24；完整平台验收见 11.1）
- [x] 超额容忍与欠费（`credit_debt`）；只处理积分数量，AI 的 estimate / actual 已在 P3 实现（#24、#32）
- [x] 退款申请：用户发起、后台审核、调用平台退款、Webhook 回收积分（#24；真实管理员审核验收仍见 11.1）
- [x] Cron：积分过期、年付按月发放、hold 超时回收、订阅对账、积分对账不变式校验（#24）
- [x] 页面开发与规定验收：定价/回跳、账单/用量、最小计费后台；Stripe 测试卡支付已通过（#24、#63、#71；billing 10.1–10.3）
- [x] 支付实测文档与 Q4/Q5/Q6 实现核对（billing 10.4，2026-10-15）：记录真实 Sandbox 事件差异、录制来源、已通过与仍待验证的边界；Q4/Q5/Q6 的已实现策略不等于完整平台矩阵通过。协调者继续负责 3.3 与 11.1。
- [ ] **阶段验收（billing 11.1；剩余转入 followups 3.1/3.2）**：两家测试环境下完成订阅（月付、年付）、续费（测试时钟 / 沙箱）、取消、积分包购买、退款；重复投递 Webhook 不重复发积分；首付只发一次积分；并发扣减不出现负数；PayPal 换套餐期间新旧订阅可并存；hold 在批次过期 / 被收回后释放，积分对账不变式仍成立。Stripe 管理员部分退款审核与 PayPal 完整矩阵仍待验收。

## Phase 3 · AI 文本

- [x] AI Gateway 接入；`ai_model` 注册表与后台编辑；三种计费方式的 estimate / actual（#32、#33、#91；DeepSeek 真实本地调用通过）
- [x] `/api/ai/chat` 流式 + hold/capture；按余额压低 maxOutputTokens；定价快照；中断结算（#38、#40、#84、#89）
- [x] 对话列表、对话页（`useChat`）、模型选择（#36、#41）
- [x] 权益检查与 AI 限流（#33、#38）
- [x] 决策 12：结算使用「流内最终 usage → 预扣额封顶的估算」；被中断流在 Gateway 不产生日志，不做日志回查（#98；chat 2.9，2026-10-12 已决）。
- [x] **阶段验收（chat 5.1）**：staging 对话、停止、关页与服务商报错、账本不变式及 Gateway 可比用量核对已通过（#205），change 已归档（#209）；证据见 `docs/runbooks/evidence/staging-acceptance/`。

## CI 能力建设

从 Phase 0 移出（原 `setup-scaffold-and-infra` 任务 6.2），由 `add-cloud-staging-neon` 建设：

- [x] main 上 CI 成功后自动部署 staging：`deploy-staging.yml` 按迁移 → jobs → web → 版本健康检查 → Chromium 冒烟的顺序执行；PR #62 与预渲染补正 PR #64 已合并，[Deploy staging run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572) 全部成功，健康版本匹配 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`、数据库正常、三项冒烟通过，任务 7.4 已验收。
- [x] staging 迁移通过 Neon 直连以 `migrator` 自动执行；Neon 建库、受限角色与权限、12 条迁移实测及切换已完成，GitHub staging 三项 secrets 已配置；上述成功自动发布已验证迁移后按 jobs → web 发布。阶段二 Neon 生产迁移已随 tag 发布流水线完成，见下文「Cloudflare 生产上线」。
- [x] Neon 9.2：观察期由七天缩短为 24 小时，2026-10-10 用户决定测试阶段保持 Free、接受计费周期后段 compute 暂停，上线时再升级；旧 Hyperdrive、Tunnel 与 Workers VPC 已删除，本机 `cloudflared` 容器已停止（#79）。2026-10-13 用户决定 staging 使用 `CRON_PROFILE=reduced`，将五分钟心跳与十分钟维护合并为半小时执行，小时和每日调度不变；生产默认、顶层/本地及 Node 五项调度保持原频率。预计约 48 次唤醒/天 × 5.5 分钟 × 0.25 CU，约 1.1 CU-hours/天、35 CU-hours/月；实际请求与任务耗时会影响用量，合入 main 自动发布后再复核缩容及用量。

发布使用 GitHub `staging` environment 的三个 secrets，PR CI 不获取这些凭据；发布串行且不取消进行中的运行。`add-cloud-staging-neon` 已完成 29/29，并于 2026-10-11 同步规格及归档（#85）。操作与验收证据、2026-10-13 staging 降频决定及半小时心跳核验窗口见 [Neon staging runbook](./runbooks/staging-neon.md) §6。

## 框架完成后的修补

开发中发现的两项缺口均已完成实现与规定验证，真实支付平台与生产上线验收仍按各自清单执行：

- [x] **已完成（`ci-e2e-smoke`，#102）**：`.github/workflows/ci.yml` 的独立 `e2e-smoke` job 使用临时 Postgres 与本地 fake 支付 Provider，覆盖注册进入个人空间、真实退出后密码登录、购买积分包、付款回调入账与重复回调不重复发放。仅安装并缓存 Chromium，无外部服务请求、PR secrets 或 trace/video；PR CI 冒烟已通过，#102 于 2026-10-12 合并。本地命令见 [07 §5](./07-infrastructure.md#5-部署与-ci-github-actions)，真实支付平台验收仍按既有 runbook 执行。
- [x] **已完成（`payment-live-mode`，#104）**：[add-payment-live-mode](../openspec/changes/add-payment-live-mode/proposal.md) 提供统一 `createPaymentRuntime` 工厂，按 `PAYMENT_MODE` 切换 test/live，并迁移 Webhook、Jobs、后台/客户/退款、认证删除与营销定价入口。9/9 任务完成，#104 于 2026-10-12 合并；本地和 staging 保持 test，live 上线清单见 [05 §8](./05-billing.md#8-支付模式与生产切换清单)。生产凭据、外部收款验收与正式收款主体（Q9）移交派生项目上线时执行，模板不处理。

## Cloudflare 剩余验收（`add-cloud-acceptance-followups`）

不新增行为，只承接需外部资源或自然时间的验收；main 当前为 0/4，另一 worker 正在处理 staging 支付验收，合并前保持以下状态。全部完成后由协调者归档。

- [ ] 1.1 失败回调后台重放：等待 staging 自然失败事件；若改用受控失败机制，先单独评审。
- [ ] 2.1 PayPal 订阅 Sale 付款与部分/全额退款录制：需已登录的 PayPal Sandbox personal 买家会话。
- [ ] 3.1 Stripe 续费：需 Stripe Dashboard 登录，用 Simulations 推进本应用 Checkout 建立的订阅。
- [ ] 3.2 PayPal 完整矩阵：需买家会话；既有订阅自然续费最早 2026-11-11 后才能观察。

## Cloudflare 生产上线 · 进入阶段二（Neon 付费档）

2026-10-15 用户决定：生产数据库使用 Neon 付费档，不自建 PG，不再建设 Tunnel / Workers VPC。设计与任务见 OpenSpec change [`add-cloud-production-neon`](../openspec/changes/add-cloud-production-neon/proposal.md)。1.1 历史验收：Launch 组织下 `product-res-production`（`aws-us-west-2`，0.25–1 CU，PITR 7 天），该演示项目已于 2026-10-18 删除，见 [production-neon runbook](./runbooks/production-neon.md)；staging 随组织升级改为 Launch 计费、上限 2 CU。

- [x] Neon 生产项目：独立项目与付费计划、PG 17、受限 `migrator` / `app` / `readonly` 角色（沿用 [staging-neon runbook](./runbooks/staging-neon.md) §1–2），确认计划的 PITR 保留窗口
- [x] Cloudflare production 环境：web / jobs 的 `env.production`（Hyperdrive 缓存/非缓存、KV、Queues、Workflows、R2）与 Wrangler secrets
- [x] 域名：production 选定 `app.ezarouter.cc`（2026-10-15，绑定在首次部署时完成），staging 保持 workers.dev
- [x] 备份：Neon PITR + 每日逻辑备份到独立对象存储（R2 Bucket Lock 或非 Cloudflare 存储）；恢复演练用 Neon 时间点分支 + 校验脚本，写 `docs/runbooks/restore.md` 并记录 RTO/RPO
- [x] 发布流水线：GitHub `production` environment 的 Neon 直连迁移凭据；tag 触发 生产迁移 → jobs → web → `/api/health` 完整 SHA → 冒烟
- 移交派生项目（原 5.1，非模板验收任务）：保留健康探测基线；按真实用户地域执行 Hyperdrive → Neon 区域与 Smart Placement / 显式放置对比，方法见 [07 §8](./07-infrastructure.md#8-延迟基线phase-0-实测-742026-10-03)。
- 移交派生项目（原 6.1 / Q9，非模板验收任务）：正式收款主体由派生项目决定，live 付款、退款与对账按 [05 §8](./05-billing.md#8-支付模式与生产切换清单) 和 [production runbook](./runbooks/production-neon.md) 执行。

**验收**：production 绑定域名可访问；tag 发布全流程自动化且健康 SHA 匹配；从 Neon 时间点与逻辑备份各恢复一次并通过校验。

**进度（2026-10-18）**：生产演示实例已拆除；拆除前 **v0.1.3** 的完整 SHA 为 `54c537542ad0f2033628c136a7057a705c6d0218`（[发布 run 38910072786](https://github.com/ustclhx/product-res/actions/runs/38910072786) 成功）。seed、每日加密备份、两路恢复演练、Sentry source map / 可读堆栈与健康监控均有[历史证据](./runbooks/evidence/production/release-2026-10-16.md)。本次核对 1–5 的模板范围并完成 7.1，13/13；change 保持活动状态，待合并后由协调者归档。2026-10-18 用户决定：原 5.1、6.1 与 Q9 不在模板内验收，移交派生项目上线清单；派生项目开放注册前还需重建自身资源和凭据、按 production runbook 恢复默认 Cron 并复核费用。

## Phase 4 · AI 图片 / 视频

- [x] `MediaProvider` + fal.ai 实现与真实录制夹具；媒体服务商注册表与 Workers AI 图片（#68、#81、#93）
- [x] R2 预签名上传（上传后确认大小与配额）、`file` 表、鉴权下载与清理（#69）
- [x] `AiMediaWorkflow`：提交身份复用 → 等待回调/轮询 → 转存 R2（大文件分片）→ 结算 → 通知；fal.ai 不承诺幂等提交，提交响应不确定时不重试，失败退款（#73、#93）。
- [x] 媒体回调入口（HMAC + 服务商验签 + 先落库再 sendEvent；#73）
- [x] 任务列表/详情页、参数表单（由 params_schema 渲染）；后台模型参数 schema 编辑（#72、#75、#96）
- [x] 并发数限制（空间级事务锁）；DB-only 超时回收，Workflow 自检终态停止（#73；media 4.7，不依赖查询 Workflow 状态）
- [x] **阶段验收（media 7.1/7.2）**：staging 媒体矩阵（含 `add-staging-fault-injection` 的受控故障）与 fal 视频真实产出已通过（#200、#209），change 已归档；证据见 `docs/runbooks/evidence/staging-acceptance/`。

## Phase 5 · 管理后台

- [x] 用户：搜索、封禁、模拟登录、调整积分（#47、#49）
- [x] 空间、订阅、订单、支付、Webhook 事件（查看/重放）、退款申请审核（#47、#49）
- [x] 模型与定价、系统设置（`setting` 表；#51、#96）
- [x] 审计日志；业务指标看板（注册、付费、MRR、消耗、任务成功率；#54、#59）
- [x] 首次管理员引导与套餐模型权限编辑（`add-first-run-admin-setup`，#101，6/6）：可选 web Worker secret `BOOTSTRAP_ADMIN_EMAILS` 仅提升已验证且未封禁的名单用户；`/admin/billing/plans` 编辑 `features.models`，seed 重跑保留授权。移除名单不自动降权。
- [x] 首次运行 staging 配置：`add-first-run-admin-setup` 已归档（#184），staging 管理员会话已用于 admin 6.1 验收；配置方式见 [staging 验收 runbook](./runbooks/staging-acceptance.md)。
- [ ] **阶段验收（admin 6.1）**：搜索/封禁、模拟登录、补发积分、退款审核（#205）、设置审计及次日指标已通过；仅失败回调重放因 staging 无自然失败事件未完成，转入 followups 1.1，change 已归档（#215）。

## Phase 6 · 营销、内容、国际化、SEO

- [x] 落地页区块：Hero、功能、定价、FAQ、评价、CTA、页脚（预渲染；#44、#45）
- [x] Paraglide 多语言（页面、邮件、错误码；#35、#50）
- [x] content-collections 博客（MDX）、法律页、可选文档站（#44；Q2 已决定）
- [x] SEO：metadata、sitemap、robots、构建期 OG 图片、JSON-LD、hreflang（#53）
- [x] 暗色模式与主题定制（#37）
- [x] **阶段验收（marketing 5.2）**：2026-10-11 staging 首页、定价页、博客中英文共六页 Lighthouse SEO / 可访问性均为 100；16/16 任务已同步并归档（#86；[验收证据](./runbooks/evidence/marketing/lighthouse-2026-10-11.md)）。

## Phase 7 · 打磨与可选功能

- [x] 请求 ID、结构化日志与脱敏过滤器、Cloudflare Web Analytics / 可选 PostHog（#42、#56）
- [x] Sentry 与 CI source map 上传（#94；observability 1.2 staging 可读堆栈已验收，change 已归档），见 [Sentry runbook](./runbooks/sentry.md)。
- [x] 站内通知中心；内部通知（新订单 → Telegram/Discord；#58）
- [x] 公开 API（API Key、OpenAI 兼容对话、媒体任务接口与文档；#57、#60、#77）
- [x] Waitlist、Newsletter（#46）
- [x] `CLAUDE.md` / `AGENTS.md`：模块说明、约定、常用命令（#52）
- [x] 「从模板创建新项目」的清单与脚本（改名、换配置、初始化基础设施；#52、#92、#100）
- [x] **新项目阶段验收（observability 6.1）**：#100 从模板生成独立文本 AI 项目，配置新 Neon / Cloudflare staging，健康、注册到首次 AI 调用、精确积分结算和 Sentry 源码堆栈均通过；临时资源已清理（2026-10-12；[脱敏证据](./runbooks/evidence/create-project/2026-10-12/acceptance.json)）。原 staging 的 Sentry 1.2 已另行验收。

## 待决事项

| # | 问题 | 决定 / 待选方案 | 决定日期 / 剩余验收 |
|---|---|---|---|
| Q1 | 表单库 | 已决定并接入：TanStack Form + Zod（#20、#22） | 2026-10-04，P1 验收确认 |
| Q2 | 内容方案 | 已决定并接入（#44、#76）：content-collections。博客、法律页与可选文档站都是 `apps/web/content/<集合>/<locale>/<slug>.mdx`，frontmatter 用 Zod 校验；MDX 在构建期渲染为静态 HTML（Worker 不允许执行 MDX 编译结果），文档搜索使用构建期生成的纯文本索引。不引入 Fumadocs：它的路由与 UI 体系对博客和法律页过重；个别站点需要重型文档站时再单独引入 | 2026-10-10 决定；2026-10-11 P6 验收并归档（#86） |
| Q3 | 产品分析 | 已决定并接入（#56、#60）：默认只用无 Cookie 的 Cloudflare Web Analytics（配置公开 token 后在公开页面加载）；PostHog 为可选接入点，由 `features.analytics` 控制且默认关闭，开启后须用户同意（`saas.analytics.consent`）并尊重 DNT，后台不加载；不做 Umami | 2026-10-07 |
| Q4 | 订阅积分是否结转 | 已按设计确定：按套餐配置，默认不结转（#24） | 2026-10-04 策略确定；2026-10-15 文档核对 `grantSubscriptionMonth` 与账期过期测试：月付默认周期末 + 24h，不结转；staging 时间与年付完整验收仍待 11.1 |
| Q5 | 升级时是否立即补发积分差额 | 已按设计确定：默认不立即补发（#24）；Stripe 升级链路已实测（#71） | 2026-10-04 策略确定；2026-10-15 文档核对 `payment.kind=adjustment` 不发积分，仅 initial/renewal 发放；PayPal 换套餐完整验收仍待 11.1 |
| Q6 | 退款时已消费积分的处理 | 已决定：已消费不追溯；全额退款收回全部剩余，部分退款按未退款份额比例保留并收回超出部分，年付后续月份按同一份额发放 | 2026-10-04 不追溯策略（#24）；2026-10-15 用户决定部分退款改为按比例回收；Stripe 管理员部分退款已在 staging 实测（admin-61-2026-10-15a，为旧规则下的全部剩余收回）；PayPal 真实退款仍待 3.3/11.1 |
| Q7 | 文本中断时的最低计费 | 已决定：优先流内最终 usage；无 usage 时按检查点估算，无检查点按估算输入、输出为 0 计算，应用 `minCharge ?? 1` 下限后再以 `hold.amount` 封顶。按次有输出才扣费；不做 Gateway 日志回查（决策 12，#98），详见 chat design 与 `06` §3 | 2026-10-11 取值确认（#84）；2026-10-12 封顶与决策 12（#89、#98）；staging 5.1 已验收并归档（#209） |
| Q8 | 是否启用 RLS 加固 | 已决定：默认否；P1 使用 scoped() + lint + 实时成员校验（#13、#22） | 2026-10-04，P1 验收确认 |
| Q9 | Stripe 正式收款所需主体 | **模板不处理，派生项目决定**：注册海外主体 / 仅 PayPal 上线 / 接 MoR；测试账号联通与 test/live 工厂完成（#104）不代表正式收款资格已解决 | 2026-10-18 用户决定移出模板验收，移交派生项目上线清单（05 §8） |
| Q10 | 超额容忍的默认额度（`billing.overage`） | 已按 `template.config.ts` 确定：单次平台承担上限为预扣额的 20% 与 50 积分的较小值（向下取整），每空间每 UTC 日累计最多 200 积分；剩余超额从余额补扣，不足记欠费。只适用于真实 usage 超额，估算结算受预扣封顶；上线后观察两周 `overage_absorbed` 再调整 | 2026-10-11 取值确认（#84）；2026-10-12 明确估算封顶（#89）；真实误差数据校准待办 |
