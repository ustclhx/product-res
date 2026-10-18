# 01 · 总体架构

## 1. 架构图

```
                        ┌──────────────────── Cloudflare ─────────────────────┐
 浏览器 / API 客户端 ──► │  apps/web  (Worker, TanStack Start: SSR + API)       │
                        │    ├─ HYPERDRIVE / HYPERDRIVE_CACHED ──┐             │
                        │    ├─ R2 (FILES)                       │             │
                        │    ├─ KV (CACHE: 会话二级存储/配置)      │             │
                        │    ├─ Rate Limiting 绑定               │             │
                        │    ├─ Queue producer (EMAIL, EVENTS)   │             │
                        │    └─ Workflow 绑定 (AI_MEDIA → jobs)  │             │
                        │                                        │             │
                        │  apps/jobs (Worker)                    │             │
                        │    ├─ Workflows: AiMediaWorkflow ...   │             │
                        │    ├─ Queue consumers: email, events   │             │
                        │    └─ Cron Triggers: 积分过期/对账/清理 │             │
                        │                                        │             │
                        │  AI Gateway ──► OpenAI / Anthropic / Google / fal.ai │
                        │  Turnstile · Web Analytics · Workers Logs            │
                        └────────────────────────────────────────┼─────────────┘
                                                                 │ Cloudflare Tunnel
                                                     ┌───────────▼───────────┐
                                                     │ VPS: Postgres 17       │
                                                     │  + cloudflared         │
                                                     │  + 备份(WAL-G → R2)    │
                                                     └────────────────────────┘
 外部服务：Resend（邮件）· Stripe / PayPal（支付，Webhook 回调 apps/web）
          fal.ai 等（媒体生成，Webhook 回调 apps/web）· Sentry（错误）
```

**原则**：Cloudflare 只承载无状态计算与对象/缓存存储；**Postgres 是唯一的事实来源（source of truth）**，也是唯一需要自行运维的组件。

## 2. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript（strict） | |
| 包管理 | pnpm workspaces（+ Turborepo 可选） | |
| Web 框架 | TanStack Start（Router + Server Functions） | 已实测可用（P0 4.1）：`@cloudflare/vite-plugin` 置于 `tanstackStart()` 之前并设 `viteEnvironment: { name: 'ssr' }`，`wrangler.jsonc` 的 `main` 指向 `@tanstack/react-start/server-entry`、开 `nodejs_compat`；`vite dev` 与 `vite preview` 的 SSR 均在 workerd 中执行，`vite build` 产出 `dist/server/wrangler.json` 供部署。注意：pnpm 需在 `allowBuilds` 中放行 `workerd`、`esbuild` 的安装脚本；`routeTree.gen.ts` 不提交，typecheck 前用 `vite.resolveConfig()` 触发 Start 插件生成（`tsr generate` 缺少 Start 的 `Register` 声明） |
| 数据请求 | TanStack Query | |
| 表单 | TanStack Form 或 react-hook-form + Zod | 脚手架阶段二选一 |
| 校验 | Zod | 前后端共享 schema |
| UI | Tailwind CSS v4 + shadcn/ui | 营销页动效参考 Aceternity / Magic UI，用 `motion` |
| 表格 | TanStack Table | 管理后台 |
| i18n | Paraglide JS | 编译期生成，按需打包 |
| 内容 | MDX + content-collections | 博客、法律页、可选文档站；构建期校验 frontmatter 并渲染为静态 HTML，文档搜索索引也在构建期生成（Q2，`apps/web/content-collections.ts`） |
| ORM | Drizzle ORM + drizzle-kit | |
| DB 驱动 | postgres.js（`postgres`） | Cloudflare 推荐配合 Hyperdrive |
| 认证 | Better Auth | organization / admin / api-key / two-factor 插件 |
| 支付 | Stripe、PayPal（REST） | 抽象为 `PaymentProvider` |
| AI 文本 | Vercel AI SDK + Cloudflare AI Gateway | |
| AI 媒体 | 自定义 `MediaProvider`，首个实现 fal.ai | |
| 后台任务 | Cloudflare Workflows、Queues、Cron Triggers | |
| 邮件 | Resend + React Email | 通过 Queue 异步发送 |
| 人机验证 | Cloudflare Turnstile | |
| 监控 | Sentry（`@sentry/cloudflare`）、Workers Logs、Web Analytics | PostHog 可选 |
| 测试 | Vitest（`@cloudflare/vitest-plugin`）、Playwright | |
| 代码规范 | Biome | |

## 3. Cloudflare 服务用途

| 服务 | 绑定名（建议） | 用途 |
|---|---|---|
| Workers | — | `apps/web`、`apps/jobs` |
| Hyperdrive | `HYPERDRIVE`（关缓存）、`HYPERDRIVE_CACHED`（开缓存） | 连接自建 Postgres |
| R2 | `FILES` | 用户上传、AI 产出、（另一个桶）数据库备份 |
| KV | `CACHE` | Better Auth 会话二级存储、系统配置缓存、功能开关 |
| Rate Limiting | `RL_AUTH`、`RL_AI` | 登录、AI 接口限流（按数据中心计数，只用于防刷，不用于配额） |
| Queues | `EMAIL_QUEUE`、`EVENTS_QUEUE` | 异步发邮件、内部事件（通知、审计、Webhook 后续动作） |
| Workflows | `AI_MEDIA_WORKFLOW` | 图片/视频生成的多步骤持久任务 |
| Cron Triggers | — | 积分过期、年付按月发放积分、hold 超时回收、订阅与积分对账、未确认上传/软删数据清理、卡住任务回收 |
| AI Gateway | — | LLM 统一出口：日志、缓存、限流、重试、成本统计 |
| Turnstile | — | 注册/登录/找回密码防刷 |
| Web Analytics | — | 免费流量统计 |
| Workers AI | `AI`（可选） | 低成本模型（如轻量图片模型） |

## 4. Workers 运行时约束（设计时必须遵守）

| 约束 | 影响与对策 |
|---|---|
| 需要 **Workers Paid 套餐** | 免费套餐 10ms CPU 无法承受密码哈希（scrypt）等操作；Paid 默认 30s CPU/请求（可调高） |
| 打包体积上限（Paid 压缩后 10MB） | 控制依赖；重型逻辑放 `apps/jobs`；选库前确认 edge 兼容 |
| 无原生 Node 模块 | 不用 sharp / bcrypt(native) / canvas；图片处理用 Cloudflare Images 或服务商 |
| 需开启 `nodejs_compat` | postgres.js、Better Auth 依赖部分 Node API |
| **DB 客户端不能跨请求复用** | 每个请求创建 Drizzle 实例（Hyperdrive 负责真正的连接池） |
| 请求有墙钟/CPU 限制 | 长任务一律进 Workflows / Queues，不在请求里同步等待 |
| 边缘到数据库有网络延迟 | 合并查询、减少请求内串行查询；保持 `prepare: true`；营销页预渲染；可缓存的读走 `HYPERDRIVE_CACHED`。**不依赖 Smart Placement**：实测它不会因 Hyperdrive 访问而把 Worker 移到数据库附近（7.4，`docs/07` §8），阶段二按需评估显式放置 |

## 5. 数据库访问策略

- **两个 Hyperdrive 绑定**：
  - `HYPERDRIVE`：**关闭查询缓存**，用于一切业务读写（账户、积分、订单、任务）。默认使用它。
  - `HYPERDRIVE_CACHED`：开启缓存，仅用于允许短暂陈旧的公开数据（定价方案、模型列表、公开内容）。
- 事务：积分扣减、Webhook 处理等必须在显式事务中完成；事务内避免外部网络调用。
- 读写模式：单主库起步；未来可加只读副本并新增一个指向副本的 Hyperdrive。

## 6. 请求链路示例

**文本对话（同步流式）**
```
POST /api/ai/chat → 鉴权 + 权益检查 → 限流 → 按余额确定 maxOutputTokens → 预扣积分(hold)
  → AI SDK streamText (经 AI Gateway) → 流式返回；waitUntil(consumeStream) 服务端读完模型流
  → onFinish: 按实际 token 结算 hold（capture 实际值，release 余量），保存消息
  （客户端断开不影响结算；结算丢失时 Cron 按最低费用兜底）
```

**视频生成（异步）**
```
POST /api/ai/tasks → 鉴权 + 权益 → 单事务[空间锁 + 并发数检查 + 创建 ai_task(定价快照) + hold]
  → 启动 AiMediaWorkflow(taskId) → 立即返回 taskId
Workflow: 幂等提交 fal.ai(带 webhook，记录 jobId) → 查已落库回调 → waitForEvent(超时则轮询)
  → 下载结果写 R2 → capture / release → 更新任务状态 → 发站内通知
fal.ai webhook → apps/web → 验签 → 结果写 ai_task.callback_payload → workflow.sendEvent(taskId)
前端：轮询 GET /api/ai/tasks/:id
```

**支付 Webhook**
```
POST /api/webhooks/{stripe|paypal} → 验签 → 转换为内部统一事件
  → 事务 A：登记 webhook_event（按平台投递去重）
  → 事务 B：更新订阅/订单 + 发放积分 + 标记 processed（失败则另起事务记录 failed）
  → 返回 200（失败返回 5xx 让平台重试）→ 投递 EVENTS_QUEUE（邮件、通知）
```

## 7. 可选运行时的平台边界

契约、适配器用法与 A/B 签收接口见 [平台能力与交接](platform-capabilities.md)。

`packages/platform` 提供目标中立的 env、db、KV、限流、后台延续和请求元数据，以及 queue/workflow/scheduler 契约；通过显式 `./cloudflare` 与 `./node` 入口按目标装配。业务包与 apps 使用中立契约。Cloudflare 仍是默认部署目标，Node 基础能力及业务迁移由 `add-selfhost-foundation` 分批实施，持久任务引擎由 B 交付；未装配的能力明确报告 unavailable。

platform 仅可依赖 shared/config/db，config/db 不反向依赖 platform。shared 无内部依赖、config 仅依赖 shared、db 仅依赖 shared/config；业务包之间允许依赖，检查器没有规定总顺序。`pnpm check:deps` 对 apps/packages 的 Cloudflare 导入执行目标边界检查，入口与目标测试规则见 [项目结构 §1](02-project-structure.md#1-monorepo-目录)。A 4.6 已清除业务导入的过渡清单，业务源码与中立 web 类型检查不依赖 Workers 全局声明。
