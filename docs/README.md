# product-res 技术设计文档

自用的 AI SaaS 模板。目标：以 Cloudflare 为主要运行平台、自建 Postgres 为数据层，作为后续不同 AI 应用的起点，通过配置开关适配不同业务形态（个人用户 / 团队、订阅 / 积分）。

> 状态：**v0.6（2026-10-07）**。Phase 0 与 Phase 1 已完成、部署到 staging 并归档，验收记录见 `08`。Phase 2（计费与积分）离线开发已完成并部署到 staging，已验收 28/34 项，剩余 6 项待测试 / 沙箱支付凭据联通。其余阶段已用 Orca 并行（Claude 协调、Codex / Claude worker 开发，流程见 `09` §6）完成全部无需凭据的部分：Phase 3（AI 文本）11/15，模型注册表、计费、流式对话与结算、停止 / 检查点 / 超时兜底、对话界面已完成，真实 AI Gateway 调用与 staging 验收待 LLM 凭据；Phase 5（后台）13/14、Phase 6（营销 / i18n / SEO）14/16，均只剩 staging 验收；Phase 7 已完成请求 ID 与结构化日志、脱敏、Web Analytics 与可选 PostHog、通知中心与运营通知、API Key 与兼容 OpenAI 的对话接口及文档、Waitlist / Newsletter、`CLAUDE.md` / `AGENTS.md` 与项目创建脚本，Sentry 待项目凭据；Phase 4（AI 图片 / 视频）尚未开始，按计划在生产迁移之后进行。真实 OAuth 联调与 Resend 发送仍待配置，当前保持 OAuth mock、邮件 log 模式。CI 冒烟 e2e 与按环境切换的支付运行时登记为框架完成后的修补待办（`08`）。下次 staging 部署需应用迁移 0008–0011 并带上新的 RL_AI / RL_API 限流与 jobs 的 EVENTS_QUEUE producer 绑定。基础设施按两个阶段推进，当前为阶段一（数据库在开发者本机，见 `07` §0）。

## 文档目录

| 文档 | 内容 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 总体架构、技术栈、Cloudflare 服务与 Workers 限制 |
| [02-project-structure.md](./02-project-structure.md) | Monorepo 目录结构、模块划分、配置体系、编码约定 |
| [03-data-model.md](./03-data-model.md) | 数据表设计（字段、索引、约束） |
| [04-auth-and-tenancy.md](./04-auth-and-tenancy.md) | 认证、平台角色、可选多租户（Workspace） |
| [05-billing.md](./05-billing.md) | 支付抽象（Stripe / PayPal / 未来 MoR）、订阅、积分、权益 |
| [06-ai.md](./06-ai.md) | 文本 / 图片 / 视频生成、任务模型、Provider 适配、计费结算 |
| [07-infrastructure.md](./07-infrastructure.md) | 自建 Postgres、Hyperdrive + Tunnel、备份、环境、部署、CI |
| [08-roadmap.md](./08-roadmap.md) | 分阶段开发计划与验收标准、待决事项 |
| [09-parallel-plan.md](./09-parallel-plan.md) | 用 Orca 并行开发：worktree 隔离、共享文件规则、并行波次与合并流程 |
| [README.md](./README.md) | product-res 技术设计文档 |
| [create-project.md](./create-project.md) | 从模板创建项目 |
| [frontend-navigation.md](./frontend-navigation.md) | 前端导航延迟：工作空间页客户端缓存、悬停预加载与 TanStack Router 复用语义 |
| [node-jobs-extension.md](./node-jobs-extension.md) | Node jobs 注册与扩展 |
| [plan/blockers.md](./plan/blockers.md) | 待审阅卡点（需要人工介入或决策） |
| [plan/data-sources-design.md](./plan/data-sources-design.md) | 数据源接入设计（讨论稿） |
| [plan/saas-template-selfhost-requirements.md](./plan/saas-template-selfhost-requirements.md) | saas-template 自托管部署模板需求（Docker Compose） |
| [plan/selection-workbench.md](./plan/selection-workbench.md) | 跨境电商选品工作台：流程与实施方案 |
| [platform-capabilities.md](./platform-capabilities.md) | 平台能力与 A/B 接口交接 |
| [platform-node-adapters.md](./platform-node-adapters.md) | Node 基础平台适配器（A 3.1–3.3） |
| [receipts/aisa-dataforseo-2026-10-20.md](./receipts/aisa-dataforseo-2026-10-20.md) | AIsa → DataForSEO Amazon 核验回执（2026-10-20） |
| [receipts/ebay-browse-2026-10-23.md](./receipts/ebay-browse-2026-10-23.md) | eBay Browse 核验回执（2026-10-23） |
| [receipts/fx-ecb-2026-10-18.md](./receipts/fx-ecb-2026-10-18.md) | 核验回执：汇率（欧洲央行） |
| [receipts/m2-acceptance-2026-10-19.md](./receipts/m2-acceptance-2026-10-19.md) | 验收回执：M2 跟卖选品端到端（add-follow-selection 5.1） |
| [receipts/m3-acceptance-2026-10-19.md](./receipts/m3-acceptance-2026-10-19.md) | M3 验收记录：add-costing-decisions 5.1（2026-10-19） |
| [receipts/m4-acceptance-2026-10-19.md](./receipts/m4-acceptance-2026-10-19.md) | M4 验收记录：add-category-insight 4.1（2026-10-19） |
| [receipts/m5-acceptance-2026-10-19.md](./receipts/m5-acceptance-2026-10-19.md) | 验收回执：M5 影子验证流转（add-shadow-validation 5.1） |
| [runbooks/evidence/create-project/2026-10-12/resources.md](./runbooks/evidence/create-project/2026-10-12/resources.md) | product-res-smoke 6.1 临时资源清单 |
| [runbooks/evidence/create-project/2026-10-12/ui-observations.md](./runbooks/evidence/create-project/2026-10-12/ui-observations.md) | 界面观察描述 |
| [runbooks/evidence/marketing/lighthouse-2026-10-11.md](./runbooks/evidence/marketing/lighthouse-2026-10-11.md) | Lighthouse 验收（add-marketing-i18n-seo 5.2） |
| [runbooks/evidence/p2-stripe/controlled-time-tests.md](./runbooks/evidence/p2-stripe/controlled-time-tests.md) | P2 Stripe：受控应用时间验证 |
| [runbooks/evidence/production/release-2026-10-16.md](./runbooks/evidence/production/release-2026-10-16.md) | 生产首次发布与恢复演练证据（2026-10-16） |
| [runbooks/evidence/selfhost/b-1.9-report.md](./runbooks/evidence/selfhost/b-1.9-report.md) | B 1.9：2 vCPU/4GiB 资源预算与选型复核 |
| [runbooks/evidence/selfhost/b-6.1-report.md](./runbooks/evidence/selfhost/b-6.1-report.md) | B 6.1 本地 Docker 调度验收 |
| [runbooks/evidence/selfhost/b-6.2-queues.md](./runbooks/evidence/selfhost/b-6.2-queues.md) | B 6.2 · 本地 Docker 队列验收（2026-10-14） |
| [runbooks/evidence/selfhost/b-6.3-workflow.md](./runbooks/evidence/selfhost/b-6.3-workflow.md) | B 6.3 本地 Docker 长流水线验收 |
| [runbooks/evidence/selfhost/b-accept.md](./runbooks/evidence/selfhost/b-accept.md) | B 6.1–6.3 本地 Docker 验收（2026-10-14） |
| [runbooks/evidence/selfhost/d-bundle-2026-10-14/report.md](./runbooks/evidence/selfhost/d-bundle-2026-10-14/report.md) | D bundle 收尾与 registry 演练（2026-10-14） |
| [runbooks/evidence/selfhost/d-bundle2-2026-10-14/report.md](./runbooks/evidence/selfhost/d-bundle2-2026-10-14/report.md) | D 1.4 第二次正式发布完整 bundle 验收（2026-10-14） |
| [runbooks/evidence/selfhost/d-drill-2026-10-15/report.md](./runbooks/evidence/selfhost/d-drill-2026-10-15/report.md) | D 6.2 正式发布镜像的完整本地 PITR 演练 |
| [runbooks/evidence/selfhost/d-vm-2026-10-15/report.md](./runbooks/evidence/selfhost/d-vm-2026-10-15/report.md) | D 临时 VM 与 B 生命周期验收（2026-10-15） |
| [runbooks/evidence/selfhost/d-vm2-2026-10-15/report.md](./runbooks/evidence/selfhost/d-vm2-2026-10-15/report.md) | D 正式 flock 镜像临时 VM 验收（2026-10-15） |
| [runbooks/evidence/selfhost/external-s3-assembly-2026-10-16.md](./runbooks/evidence/selfhost/external-s3-assembly-2026-10-16.md) | 外部 S3 发布装配验证（2026-10-16） |
| [runbooks/evidence/selfhost/replica-health-2026-10-17/ci-interruption-correction.md](./runbooks/evidence/selfhost/replica-health-2026-10-17/ci-interruption-correction.md) | PR #240 中断复制回归补正 |
| [runbooks/evidence/selfhost/replica-health-2026-10-17/report.md](./runbooks/evidence/selfhost/replica-health-2026-10-17/report.md) | 副本健康告警诊断（2026-10-17） |
| [runbooks/evidence/selfhost/replica-release-9f48968/report.md](./runbooks/evidence/selfhost/replica-release-9f48968/report.md) | 9f48968 正式升级与副本健康验收 |
| [runbooks/evidence/selfhost/server-acceptance-1888e7d/approved-fixture.md](./runbooks/evidence/selfhost/server-acceptance-1888e7d/approved-fixture.md) | 已批准的 sleep 夹具修正 |
| [runbooks/evidence/selfhost/server-acceptance-1888e7d/matrix.md](./runbooks/evidence/selfhost/server-acceptance-1888e7d/matrix.md) | 需求与证据矩阵 |
| [runbooks/evidence/selfhost/server-acceptance-1888e7d/report.md](./runbooks/evidence/selfhost/server-acceptance-1888e7d/report.md) | 新加坡服务器验收：1888e7d |
| [runbooks/evidence/selfhost/server-acceptance-2026-10-16/attempt-aaf8299.md](./runbooks/evidence/selfhost/server-acceptance-2026-10-16/attempt-aaf8299.md) | 正式 aaf8299 部署尝试与后续入口 |
| [runbooks/evidence/selfhost/server-acceptance-2026-10-16/report.md](./runbooks/evidence/selfhost/server-acceptance-2026-10-16/report.md) | 2026-10-16 真实服务器验收预检 |
| [runbooks/evidence/staging-acceptance/2026-10-17/README.md](./runbooks/evidence/staging-acceptance/2026-10-17/README.md) | W3 沙箱验收（2026-10-18 Asia/Taipei） |
| [runbooks/evidence/staging-acceptance/2026-10-18/README.md](./runbooks/evidence/staging-acceptance/2026-10-18/README.md) | W3 后台重放与 PayPal 沙箱验收 |
| [runbooks/evidence/staging-acceptance/README.md](./runbooks/evidence/staging-acceptance/README.md) | Staging 验收证据：2026-10-12 至 2026-10-13 |
| [runbooks/evidence/teardown-2026-10-18.md](./runbooks/evidence/teardown-2026-10-18.md) | 模板生产与自托管测试实例拆除（2026-10-18） |
| [runbooks/hyperdrive-tunnel.md](./runbooks/hyperdrive-tunnel.md) | Runbook · 本机数据库经 Tunnel 接入 Hyperdrive（历史链路与回滚） |
| [runbooks/node-job-engine.md](./runbooks/node-job-engine.md) | Node 任务引擎运维 |
| [runbooks/p2-acceptance-paypal.md](./runbooks/p2-acceptance-paypal.md) | P2 PayPal 沙箱联通验收 |
| [runbooks/p2-acceptance-stripe.md](./runbooks/p2-acceptance-stripe.md) | P2 Stripe 真实联通验收 |
| [runbooks/p2-offline-acceptance.md](./runbooks/p2-offline-acceptance.md) | P2 离线开发验收（2026-10-04） |
| [runbooks/p2-payment-integration.md](./runbooks/p2-payment-integration.md) | P2 支付联通与 staging 验收 |
| [runbooks/p2-staging-preparation.md](./runbooks/p2-staging-preparation.md) | P2 staging 准备记录（更新至 2026-10-09 UTC） |
| [runbooks/production-neon.md](./runbooks/production-neon.md) | Neon production 操作与验收 |
| [runbooks/restore.md](./runbooks/restore.md) | Cloudflare 形态生产数据库恢复与演练 |
| [runbooks/selfhost-a-final.md](./runbooks/selfhost-a-final.md) | A 8/9：Node 认证与 Compose 尾部验收 |
| [runbooks/selfhost-a4-billing.md](./runbooks/selfhost-a4-billing.md) | A 4.2：计费、积分与后台平台迁移 |
| [runbooks/selfhost-a4-storage.md](./runbooks/selfhost-a4-storage.md) | A 4.4：存储、growth 与公开页迁移 |
| [runbooks/selfhost-a46.md](./runbooks/selfhost-a46.md) | A 4.6：平台迁移整合验收 |
| [runbooks/selfhost-a5.md](./runbooks/selfhost-a5.md) | A 5.1–5.3：Node 生产构建、启动与 CI |
| [runbooks/selfhost-a7.md](./runbooks/selfhost-a7.md) | A 7.1–7.4：Dockerfiles 与 Compose 验收 |
| [runbooks/selfhost-backup-retention.md](./runbooks/selfhost-backup-retention.md) | Selfhost 备份保留边界 |
| [runbooks/selfhost-backup.md](./runbooks/selfhost-backup.md) | Selfhost PG17 基础与逻辑备份 |
| [runbooks/selfhost-c-jobs-wire.md](./runbooks/selfhost-c-jobs-wire.md) | C 的 Node jobs 共享接线 |
| [runbooks/selfhost-c-profile.md](./runbooks/selfhost-c-profile.md) | C 1.5/1.6：object-storage profile 与全栈验收 |
| [runbooks/selfhost-c-storage.md](./runbooks/selfhost-c-storage.md) | C 1.4：Node 文件接线验收与 B 交接 |
| [runbooks/selfhost-c-wire.md](./runbooks/selfhost-c-wire.md) | C 共享接线：配置、观测与构建 |
| [runbooks/selfhost-delivery-handoff.md](./runbooks/selfhost-delivery-handoff.md) | D 镜像交付与协调者签收清单 |
| [runbooks/selfhost-deploy.md](./runbooks/selfhost-deploy.md) | 显式部署、health 与兼容回滚（D 2.1–2.3） |
| [runbooks/selfhost-init.md](./runbooks/selfhost-init.md) | 空白服务器初始化（D 2.5） |
| [runbooks/selfhost-proxy.md](./runbooks/selfhost-proxy.md) | 同一 Compose 的外部代理与 Cloudflare Tunnel 接入（D 2.4 / add-tunnel-ingress） |
| [runbooks/selfhost-release.md](./runbooks/selfhost-release.md) | 同 SHA release bundle |
| [runbooks/selfhost-replica.md](./runbooks/selfhost-replica.md) | 第二目标独立恢复副本 |
| [runbooks/selfhost-restore.md](./runbooks/selfhost-restore.md) | Selfhost PG17 指定时间点恢复 |
| [runbooks/sentry-node-adapter.md](./runbooks/sentry-node-adapter.md) | Node Sentry adapter：C 2.1–2.2 模块交付 |
| [runbooks/sentry.md](./runbooks/sentry.md) | Sentry 服务端错误与 source map |
| [runbooks/staging-acceptance.md](./runbooks/staging-acceptance.md) | Staging 验收脚本 |
| [runbooks/staging-neon.md](./runbooks/staging-neon.md) | Neon staging 操作与验收 |

## 本地配置入口

支付配置使用根目录 [.env.example](../.env.example) / `.env.local`：前者提交占位符，后者填写真值且被 Git 忽略。Web、Jobs 和 billing seed/sync 共用五项支付变量名，配置步骤见 [支付联通 runbook](./runbooks/p2-payment-integration.md)。认证仍使用 `apps/web/.dev.vars.example` / app `.dev.vars`；Orca 数据库与端口使用生成的 `.env.worktree`。线上继续用 Cloudflare secrets，不自动上传本地文件。

## 已确定的关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 运行平台以 **Cloudflare** 为主（Workers / R2 / KV / Queues / Workflows / AI Gateway） | 成本低、全球边缘、服务齐全 |
| D2 | 框架使用 **TanStack Start**（非 Next.js） | 对 Workers 一等支持，本地开发即 workerd 运行时，包体更小 |
| D3 | 数据库使用 **自建 Postgres**，经 **Hyperdrive + Cloudflare Tunnel（Workers VPC）** 访问，ORM 为 **Drizzle**；最小原型前数据库在本机，之后迁移到生产服务器（`07` §0） | D1 能力不足；Tunnel 避免数据库暴露公网；只用标准 PG 以便迁移到托管服务 |
| D4 | 模板**不绑定地区与时区**：数据库地区为部署参数，时间一律 UTC 存储，展示时按用户时区换算 | 面向不同应用需求 |
| D5 | 支付先接 **Stripe + PayPal**，通过 `PaymentProvider` 抽象，后续扩展 MoR（Creem / Paddle / Polar）；不做中国大陆境内支付 | 暂无主体；PayPal 可个人跨境收款，Stripe 先做测试模式开发 |
| D6 | **多租户为可选项**，采用「个人空间」模型：所有数据归属 Workspace，开关只控制是否允许团队 Workspace | 一套代码适配 B2C / B2B |
| D7 | AI 同时支持 **文本、图片、视频**；文本走流式同步，图片/视频统一为异步任务（Cloudflare Workflows） | 三者耗时差异大 |
| D8 | 计费同时支持 **订阅 + 一次性积分包**；积分按「批次」管理，预扣-结算模型 | 两种商业模式都要支持 |
| D9 | 认证使用 **Better Auth**（organization / admin / api-key 等插件） | 开源、数据自持、插件完善 |
| D10 | 仓库采用 **pnpm monorepo**：`apps/web`（TanStack Start）+ `apps/jobs`（后台 Worker）+ 共享 packages | Workflows / 队列消费者 / Cron 与 Web 解耦 |

## 参考对象

ShipAny、MkSaaS、TanStarter（功能清单参考）、Aceternity UI / Magic UI（营销页组件参考）。不购买、不复制其代码。

## Agent Skills

模板提供项目启动、Cloudflare/自托管部署准备、页面/模块/静态内容扩展、AI 模型配置与安全审查技能。
完整清单、调用示例、默认只读部署边界与双目录维护规则见
[创建项目 · Agent Skills](create-project.md#agent-skills)。
Codex 从 `.agents/skills/` 读取，Claude 从 `.claude/skills/` 读取；可直接指定技能文件执行。
