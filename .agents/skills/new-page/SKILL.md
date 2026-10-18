---
name: new-page
description: 为本模板新增需要登录的 app 空间页面或 admin 后台页面，沿用类型化路由、服务端鉴权、DataTable 和多语言文案。公开静态内容页使用 new-static-page。
---

# 新增应用或后台页面

在含 `package.json` 与 `template.config.ts` 的项目根执行。下文路径均相对项目根；生成器副本已改包 scope，先读 `apps/web/package.json` 的 name/dependencies，示例 `@product-res/*` 替换为实际名称。

## 1. 确定边界与参考

先读 `AGENTS.md`、`docs/01-architecture.md`、`docs/02-project-structure.md`；并行修改导航或文案时读 `docs/09-parallel-plan.md` §3/§6。记录路由、角色、读写行为、数据来源、启用语言和开关，寻找同类页面后再创建文件：

```sh
rg --files apps/web/src/routes apps/web/src/features packages/ui/src
cat apps/web/package.json template.config.ts
```

- **app**：读 `apps/web/src/routes/app/$slug/route.tsx`、`apps/web/src/features/workspace/workspace.functions.ts`、`apps/web/src/server/middleware.ts`。路由放 `app/$slug/<页面>.tsx`；从可信空间上下文取身份，以 slug 作为外部输入，不接收客户端 workspaceId/userId 作为权限依据。
- **admin**：读 `apps/web/src/routes/admin/route.tsx`、`apps/web/src/routes/admin/audit.tsx`、`apps/web/src/features/admin/{admin.functions.ts,action.ts,action.server.ts,list.ts,nav.ts}`。列表导航与 search 参数按现有后台模式接入。

本步完成时，新增文件与共享文件的所有权明确；需要新业务能力时按 `new-module` 实施，优先复用现有表和服务。

## 2. 实现类型化数据入口

在 `apps/web/src/features/<功能>/*.functions.ts` 用 `createServerFn` 与 Zod 输入 schema，数据库操作放独立 service 文件。参考 `apps/web/src/features/notifications/notifications.functions.ts` 与 `service.ts`：GET 用于读取，POST 用于写入，结果类型从实际服务返回值推导。

- app 入口挂 `withWorkspace`（已包含 `withSession`），租户查询使用 `scoped(context.db, context.workspace.id)`；个人数据另加 `context.user.id` 条件。需要套餐权益时用 `withEntitlement`，读取传 `{ access: 'read' }`。写操作在服务端检查 `workspaceReadOnly` 与角色；页面禁用按钮只是交互提示。
- admin 的每个入口挂 `adminMiddleware`，即使布局已有守卫也要保护直接调用。写入在 handler 内调用 `action.server.ts` 的 `adminAction` 或 `withAdminAction`，业务与 `audit()` 同事务；只有现有服务自己管理审计事务时才用 `withDelegatedAdminAction`。
- `*.functions.ts` 会被客户端导入。服务端函数仅在 handler 中引用；勿在顶层执行数据库/运行时初始化或调用 `adminAction`。需要时在 handler 内动态 import 服务端实现，避免 postgres/secret 进入浏览器 bundle。按请求使用运行时提供的 db。

本步完成时，直接调用入口和页面加载具有相同权限边界；业务错误用 `AppError`，外部系统经对应 package 访问。

## 3. 页面、文案与导航

用 `createFileRoute` 的真实路径，`validateSearch` 校验分页/筛选，`loaderDeps` 返回 search，loader 调类型化 server function。列表复用 `packages/ui/src/components/data-table.tsx` 的 `DataTable`；后台复用 `adminListSearch`、`adminListPage`、`offsetOfPage`，筛选改变回第一页，服务端限制查询数量。日期展示确认实际序列化类型后使用 UTC/用户时区格式。

`validateSearch` 仿照 audit 页面显式包装：`(search: Record<string, unknown>) => adminListSearch(filters)(search)`，让路由能推导 offset 和筛选类型；直接传泛型工厂返回值可能使 search/deps 推成 `{}`。

文案放 `apps/web/messages/<locale>/<功能>.json`，从 `template.config.ts` 确定实际启用语言；i18n 关闭仍使用默认语言的 Paraglide 调用。补齐标题、空态、错误、表格列、分页/筛选 `labels` 与导航文案，通过 `src/paraglide/messages.js` 调用。编译入口见 `apps/web/scripts/compile-messages.mjs`，生成目录和 `routeTree.gen.ts` 由 typecheck 更新。

后台导航更新 `features/admin/nav.ts`；空间导航更新 `routes/app/$slug/route.tsx`。使用类型化 Link、正确 params/search 与功能开关。复用现有加载/错误处理，新增公开或根布局数据读取保持数据库不可达时的降级约定。

## 4. 验收与故障处理

在项目根运行；`WEB_PACKAGE` 从当前 manifest 读取，`<相关测试文件>` 替换为实际路径：

```sh
WEB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('apps/web/package.json','utf8')).name")
pnpm check
pnpm check:deps
pnpm typecheck
pnpm --filter "$WEB_PACKAGE" exec vitest run --project unit <相关测试文件>
```

复用相关测试，只为新增权限/复杂交互/业务回归增加精简用例。具备隔离本地数据库时实际验证未登录、无权、跨空间、只读空间、空列表、分页与写入结果；缺少条件则逐项记录未验收，类型检查不能替代这些运行时证据。数据库连接读取 `.env.worktree`，不使用别的 worktree 或线上库。

- 路由或 Link 类型不存在：先运行根 typecheck 生成 route tree，核对文件名和路由字面量；保持生成文件不提交。
- `m.<key>` 缺失：核对所有启用语言文件、重复 key，再运行 typecheck 编译；不要手改 Paraglide 产物。
- 客户端出现 postgres/平台绑定：检查 `*.functions.ts` handler 外的服务端引用和初始化，移动至 handler 或服务端文件后验证构建。
- 写入返回只读/权限错误：检查可信服务端上下文与产品开关，保持守卫，修复调用条件。

交付列出改动路径、路由、权限/开关、检查命令与结果、未做的运行时验收。维护本技能时复制 `.agents/skills/new-page/SKILL.md` 到 `.claude/skills/new-page/SKILL.md`，用 `cmp` 保证字节一致。
