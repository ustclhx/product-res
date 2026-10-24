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
| [frontend-navigation.md](./frontend-navigation.md) | 前端导航延迟：工作空间页客户端缓存、悬停预加载与 TanStack Router 复用语义 |

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
