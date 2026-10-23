<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 项目开发约定

## 先读什么

首次修改架构或跨模块行为时，完整阅读 [总体架构](docs/01-architecture.md) 与
[项目结构和配置](docs/02-project-structure.md)，再阅读对应领域文档。
并行工作、共享文件修改、创建或清理 worktree、提交 PR 时，必须阅读
[并行计划 §3 与 §6](docs/09-parallel-plan.md) 并遵守其规则；共享文件规则以该文档为准。

## 模块职责与依赖方向

- `apps/web`：TanStack Start 路由、页面、Server Functions 和 HTTP 接口。
- `apps/jobs`：Cloudflare Workflows、Queue 消费者和 Cron；web 经绑定调用 jobs。
- `packages/shared`：类型、错误、ID、结构化日志；`config`：模板类型、默认值和环境校验；
  `db`：Drizzle schema、迁移、租户查询和运行时设置；`platform`：目标中立能力契约与 Cloudflare/Node 适配。
- `packages/auth`：身份、会话和空间；`billing`：支付、订单和订阅；`credits`：积分账本和预扣结算；
  `entitlements`：套餐权益；`ai`：模型和 Provider；`storage`：R2 与安全下载；
  `email`：邮件模板与发送；`ui`：共享 React 组件。
- `infra`：本地及服务器 Postgres；`scripts`：工程检查、项目生成和 Orca 生命周期。

依赖边界以 `scripts/check-deps.mjs` 为准：packages 不依赖 apps；shared 不依赖其他内部包；
config 只可依赖 shared；db 只可依赖 shared、config；platform 只可依赖 shared、config、db，
config/db 不反向依赖 platform。业务包之间允许依赖，检查器没有规定它们的总顺序。React 仅允许用于 ui，email 可依赖 React / React Email，但不能依赖 ui。
检查器同时检查 manifest 与源码 import。业务平台能力通过 platform 中立入口访问；Cloudflare
导入边界与逐文件过渡清单见 [项目结构 §1](docs/02-project-structure.md#1-monorepo-目录)。

## 编码与配置

- TypeScript strict；使用 Biome 的两空格缩进、单引号和无分号风格，中文注释说明原因。
- UUIDv7 主键、UTC `timestamptz`、整数金额最小单位与整数积分。
- 租户业务查询使用 `scoped(db, workspaceId)`；按请求创建数据库客户端。
  Webhook 按验签、去重、事务处理、异步副作用的顺序处理。
- 后台写入使用 `apps/web/src/features/admin/action.ts` / `action.server.ts` 的 adminAction；
  列表使用 `packages/ui` 的 DataTable 与 `apps/web/src/features/admin/list.ts`。
- 日志使用 `@product-res/shared/log`，业务错误使用 AppError；外部服务调用经过对应 package。
- 模板开关放 `template.config.ts`，运行时设置使用 `packages/db/src/settings.ts`，
  密钥放 Wrangler secrets 或本地 `.dev.vars`。三层配置各自负责，不互相覆盖。
- 根布局和公开页面的数据读取失败时降级；数据库不可达时营销页与构建期预渲染仍应可用。
- 只修改任务所需内容；复用现有实现与测试，为核心行为和真实回归风险增加精简用例。

## 常用命令

在根目录运行，Node >=22 与 package.json 声明的 pnpm 版本为前提。
数据库命令及集成测试需要已启动的本地 PG；Orca worktree 使用自己的 `.env.worktree`。

| 命令 | 用途 |
|---|---|
| `pnpm install --frozen-lockfile` | 安装工作区依赖 |
| `pnpm --filter @product-res/db db:migrate` | 应用现有迁移 |
| `pnpm check` | Biome 与积分写入边界检查 |
| `pnpm typecheck` | 所有包和应用类型检查，生成路由与文案 |
| `pnpm check:deps` | 内部依赖方向检查 |
| `pnpm check:singletons` | 关键依赖唯一实例检查 |
| `pnpm test` | 各包测试；有隔离数据库配置时包含集成测试 |
| `pnpm build` | web 生产构建与 jobs 部署 dry-run |
| `pnpm create-project --help` | 查看生成器的交互和非交互参数 |
| `pnpm test:create-project` | 临时目录中的生成器边界测试 |
| `pnpm test:create-project:verify` | 真实副本改名、类型检查与单元测试验收 |
| `openspec list --json` | 查看当前 change 与项目根 |

持续开发使用根 package.json 的 dev 脚本，启动 web 与 jobs；停止时仅结束自己启动的进程。
新项目生成与自检见 [创建项目](docs/create-project.md)。

## OpenSpec 工作流

需求探索、提案、实施、同步与归档分别使用 `.agents/skills/openspec-*` 中对应的技能。
实施已有 change 时先读 `openspec-apply-change/SKILL.md`，通过 status 与 instructions apply
读取当前状态、上下文路径和任务位置，完整阅读其 proposal、design、specs、tasks。
只实施获分配的编号；全部验收通过后立即勾选对应项，并刷新 apply instructions 确认进度。
遇到设计冲突或范围扩大时向协调者询问。change 的同步与归档遵循并行计划，只在全部任务
合并后由协调者处理。PR 应包含验证结果与未完成验收，不把部署或外部凭据验收提前勾选。

## 开发分工与派发（本项目约定）

- **规划**：新需求先用 OpenSpec（explore → propose）形成 change，实施按其 tasks 编号推进；
  超出 change 的范围先更新 change 再动代码。
- **并行**：一个 change 拆成文件不重叠的任务组，每组派一个 subagent 在独立 git worktree
  中开发；共享文件、PR 与 worktree 清理遵循 [并行计划 §3 与 §6](docs/09-parallel-plan.md)。
- **交给 Orca 派出的 Codex**：简单代码修改（文案、配置、小修复、机械改动）、部署与运维操作，
  以及需要 computer use 或浏览器操作的任务（页面截图验收、后台配置、手工 e2e 核验）。
- **由 Claude supervisor 或其 Claude subagent 执行**：代码 review、复杂开发（跨模块、数据层、
  评分算法、连接器）、需要设计感与审美判断的 UI 任务。
- **supervisor 职责**：拆分与派发、持续监控 worker 是否停住并及时答复、review 后合并、
  验收通过后勾选 tasks、合并后核对 main 的 CI 与发布流水线。Codex 产出同样经 Claude review 后合并。

<!-- BEGIN:flow-managed -->
## Flow 工作区上下文

> 由 `flow agents sync` 生成，请勿手动修改本区块。

- 所属 workspace：`ws/product-res`（product-res，产品）
- 项目卡片：brain 条目 `projects/product-res`（`flow kb get projects/product-res`）
- 关键资源：
  - data-source `resources/data-sources/product-res-health`：product-res 健康检查，GET /api/health，返回数据库状态与版本 SHA
  - domain `resources/domains/product.ezarouter.cc`：product.ezarouter.cc，product-res 的生产域名（ezarouter.cc 的子域名）
  - repo `resources/repos/product-res`：product-res 仓库，product-res 的代码仓库
  - service `resources/services/product-res-selfhost`：product-res 自托管 Compose 实例，web 与 jobs 以 Docker Compose 自托管运行，镜像来自 GHCR
- 访问知识库：MCP 工具 `kb_search`、`kb_get`、`kb_query`、`ws_brief`；或 CLI `flow kb search <词>`、`flow ws brief ws/product-res`
- 写入规则：工作日志用 `kb_journal`；随手记用 `capture`；事实类修改用 `kb_propose` 提交提案，必须附出处；不得直接修改 decision 和 personal 条目。
<!-- END:flow-managed -->
