---
name: new-module
description: 为本模板增加后端业务能力或领域模块，复用现有表、features/package、权限与租户隔离，并完成类型化入口和核心行为验证。适用于新增服务、Server Function 或 HTTP 业务接口。
---

# 新增后端业务模块

在含 `package.json` 与 `template.config.ts` 的项目根执行。所有路径相对项目根；生成器会改包 scope，先读相关 manifest，命令和 imports 中的 `@product-res/*` 使用副本实际名称。

## 1. 确定最小业务切片

先完整读 `AGENTS.md`、`docs/01-architecture.md`、`docs/02-project-structure.md` 和对应领域文档；并行开发读 `docs/09-parallel-plan.md` §3/§6。明确一个可观察的业务行为、输入、角色、租户、写入/返回结果和幂等需求，再查现有实现：

```sh
rg --files apps/web/src/features packages
cat package.json apps/web/package.json
cat apps/web/src/features/notifications/notifications.functions.ts apps/web/src/features/notifications/service.ts
```

页面专属编排放 `apps/web/src/features/<领域>`，共享领域能力优先扩展现有 `packages/<领域>`。只有确有独立职责和多个调用方时才建新 package，并按相邻 manifest 的 exports、workspace 依赖、tsconfig 与测试配置接入。优先复用现有表；完成标准是业务入口可调用且有真实行为，不是只有空目录、类型或转发函数。

## 2. 服务与数据边界

实现小型 service 接收可信上下文或显式 db/空间/用户参数，参考通知 service 的读取、条件更新和结果。业务 SQL 使用 `scoped(db, workspaceId)`，按用户的数据追加 userId 条件；使用 scoped.findById/updateById 保持不存在和跨空间记录均为 NOT_FOUND。join 其他租户表时追加 scoped.filter，事务使用同一租户范围。运行时 db 按请求创建，服务不保存跨请求全局客户端。

业务拒绝使用 `@product-res/shared` 的 `AppError`（稳定 code/status），日志使用 `@product-res/shared/log` 的结构化 `log`，只记录必要 ID/状态而非输入全文或凭据。外部调用经对应 package 的能力接口；中立业务依赖 `packages/platform` 中立入口，目标适配器只在明确装配入口使用。

新增 schema 前说明现有表不足与领域文件所有权，读 `docs/03-data-model.md`。主键 UUIDv7，时间 UTC timestamptz，金额最小单位整数、积分整数。并行 worker 只改自己的领域 schema，按 §3 在自己的隔离本地库 `db:push` 验证；迁移由协调者汇总生成。单人非并行变更按现有 `db:generate`/`db:migrate` 流程生成并验证迁移，不手写或抢占迁移序号。

## 3. 入口、权限与配置

在 `apps/web` 接入实际 Server Function 或 HTTP 路由：

- Server Function 仿照 `notifications.functions.ts`，Zod 验证客户端输入；GET 读取、POST 写入，`.middleware([withWorkspace])` 从实时成员身份取得空间。`*.functions.ts` 的服务端实现只在 handler 使用，必要时 handler 动态 import，避免浏览器打包数据库。
- app 写操作服务端检查 `workspaceReadOnly` 和所需 member.role；敏感真实登录操作参考 `withRealSession`。需权益则使用 `withEntitlement`，读取显式 `{ access: 'read' }`。来自客户端的 workspaceId、userId、role 不能代替可信上下文。
- admin 入口挂 `features/admin/admin.functions.ts` 的 `adminMiddleware`；写入在 handler 内使用 `action.server.ts` 包装并在同事务 `audit()`。保持角色撤销复核与未审计回滚。
- HTTP 入口先阅读同类 `apps/web/src/routes/api` 与相关鉴权实现，使用已有会话/API key/权限流程，不直接把 Server Function 中间件当 HTTP 函数调用。Webhook 按验签→去重→事务→异步副作用顺序处理。

配置按用途归属：产品开关 `template.config.ts`；不发版的设置 `packages/db/src/settings.ts`，缺失时用代码默认值；凭据使用已有 secret/本地示例入口。服务遵守已关闭的功能开关。

涉及积分时调用 `packages/credits` 已导出的 grant/hold/capture/release 等领域 API，遵守整数与事务/幂等要求；不直接修改余额/账本表。平台依赖方向、Cloudflare 例外和积分写入由现有检查器验证，不为新增业务扩大豁免。

## 4. 验证与交付

从实际 package manifest 获取名称，在项目根运行：

```sh
WEB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('apps/web/package.json','utf8')).name")
pnpm check
pnpm check:deps
pnpm typecheck
pnpm --filter "$WEB_PACKAGE" exec vitest run --project unit <相关测试文件>
```

package 业务使用该包已有 `test` 脚本或 Vitest 项目名，先读配置再指定命令。只为核心业务行为与真实风险写精简测试：正常效果、权限/只读拒绝、跨租户边界、重复操作等按本次行为选取。复用已有测试，不测试简单转发或第三方内部行为。有 schema/复杂数据库行为时用隔离本地 PG 验证；缺数据库则记录未验收，mock 不能宣称数据库集成成功。

常见故障：租户隔离相关测试失败时检查 scoped 与接收者/join 条件；积分写检查失败时回到 credits API；check:deps 失败时核对 manifest 与 imports 的职责方向；服务直接调用权限失效时在入口恢复可信身份与权限校验；缺配置/功能关闭时报告具体 key/开关，不吞异常伪造成功。数据库连接问题先核对自己的 `.env.worktree` 和本地 PG，再重试相关检查。

交付说明可调用入口、业务效果、修改文件、权限/租户/幂等边界、检查结果与剩余验收。维护本技能时复制 `.agents/skills/new-module/SKILL.md` 到 `.claude/skills/new-module/SKILL.md`，用 `cmp` 保证字节一致。
