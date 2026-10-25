# Tasks

## 1. 开启团队空间

- [x] 1.1 `template.config.ts` 设 `tenancy.multiTenant: true`；示例目录 `free.features.maxSeats=10`。
- [x] 1.2 顶栏空间菜单（切换 + 创建团队空间）与空间设置页改用 `messages/{zh,en}/workspace.json` 文案。
- [x] 1.3 待开通页面列出用户的其它空间，可切回个人空间。
- [x] 1.4 团队空间软删时作废其邀请链接。

## 2. 数据层

- [x] 2.1 schema `workspace_invite_link`（`packages/db/src/schema/tenancy.ts`），迁移 `0022`（含 `free.maxSeats` 条件更新）。

## 3. 服务

- [x] 3.1 `packages/auth/src/invite-links.ts`：生成、列表、作废、预览、加入；锁协议与席位校验同 `team-workspaces.ts`；审计。
- [x] 3.2 集成测试：生成、过期、上限、作废、重复加入、个人空间拒绝、member 无权生成、角色正确、owner 角色拒绝、创建人失权、并发席位、token 只存哈希。

## 4. Web

- [x] 4.1 server functions：真实会话、限流、`ResolveMaxSeats` 装配；错误码映射文案。
- [x] 4.2 空间设置的邀请链接区块（生成、复制、列表、作废），`messages/{zh,en}/invite-links.json`。
- [x] 4.3 `/join/$token` 页面；登录 / 注册回跳白名单。
- [x] 4.4 token 脱敏：请求日志、Sentry、PostHog 路径排除、`no-referrer`。

## 5. 验收

- [x] 5.1 e2e：owner 生成链接 → 另一账号注册 → 打开链接加入 → 看到团队空间；更新 `workspace.spec.ts`、`deletion.spec.ts`；smoke 通过。
- [x] 5.2 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、相关包测试（含集成测试）通过。
