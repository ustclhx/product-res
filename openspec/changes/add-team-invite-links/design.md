# Design

## Context

- 团队空间能力（创建、邮件邀请、成员角色、转让、席位锁）已由模板的 `packages/auth/src/team-workspaces.ts` 实现，挂在 Better Auth organization 插件的 `before` 钩子上，所有成员变更都在 `pg_advisory_xact_lock('owner:<user>')` → `pg_advisory_xact_lock('ws:<workspace>')` 之下执行，席位由 `ResolveMaxSeats`（web 的 `resolveWorkspaceMaxSeats`）在同一事务内读取。
- 本项目 `tenancy.multiTenant=false`，上述能力从未在产品中开启；内测不接邮件，邮件邀请要求收件人邮箱已验证，不可用。
- 内测开通门 `credits.requireGrantForAccess` 按空间判断：空间存在管理员发放的积分批次才能使用工作台。团队空间需要管理员发一次积分，开通后成员可直接使用。
- 计费没有支付渠道。`free` 套餐 `maxSeats=1`（`DEFAULT_FREE_FEATURES`），没有订阅的团队空间只能容纳 owner 一人。

## Goals / Non-Goals

**Goals**
- 开启团队空间并处理全部连带影响。
- 可多人使用、可限次、可作废、带角色的邀请链接，不依赖邮件与邮箱验证。
- 席位与人数上限在并发下不超卖；token 不落库、不进日志。

**Non-Goals**
- 不删除、不改变邮件邀请（接邮件后仍可用）。
- 不迁移现有个人空间数据（见 change `add-workspace-data-transfer`，仅规划）。
- 不实施“限定邮箱域名”选项（见风险部分，只记录）。
- 不提供后台修改套餐席位的界面。

## Decisions

### D1 开启 `multiTenant` 的影响清单与处理

| 影响点 | 现状 | 处理 |
|---|---|---|
| 空间切换器 / 创建团队空间 | `WorkspaceSwitcher` 在顶栏渲染原生 `select` 与内联表单，英文文案 | 改为顶栏的“空间”下拉面板（`details`），内含空间列表与创建表单；文案进 `messages/{zh,en}/workspace.json` |
| 空间设置页 | 英文文案；成员管理与邮件邀请表单 | 文案改为中文 messages；邀请链接区块放在成员列表上方；邮件邀请表单保留（标注需要邮件服务） |
| 套餐与席位 | `free.maxSeats=1`，无支付渠道 | 示例目录 `free.features.maxSeats=10`；迁移 `update plan set features = jsonb_set(features,'{maxSeats}','10') where key='free' and features->>'maxSeats'='1'`，只改从未调整过的默认值；`DEFAULT_FREE_FEATURES`（无 `free` 行时的兜底）保持 1，不影响定价页与其它测试 |
| 空间数量 | `maxWorkspacesPerUser=5`，不受权益限制 | 不变 |
| `workspaceReadOnly` | `!multiTenant && !isPersonal` | 开启后团队空间可写；工作台配置写操作仍要求 owner/admin（`assertWorkbenchWriter`），member 只读——因此链接可选 admin 角色 |
| 内测开通门 | 按空间：新团队空间未开通时显示待开通页，页面只有账号设置与登出 | 待开通页列出用户的其它空间（含个人空间）供切换；文案说明团队空间需要管理员发放积分 |
| 删除团队空间 | 仅 owner；软删 | 软删时同时作废该空间全部邀请链接 |
| e2e | `workspace.spec` / `deletion.spec` 按开关分支，开启分支使用英文定位 | 改用 messages 文案定位；smoke 只断言主导航，不受影响 |

### D2 数据模型

`workspace_invite_link`（`packages/db/src/schema/tenancy.ts`）：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | UUIDv7 |
| `workspace_id` | uuid → organization，restrict | 按空间隔离，`scoped()` 可用 |
| `token_hash` | text unique | `sha256(token)` 的 hex；token 本身不落库 |
| `role` | text，check in (`member`,`admin`) | 加入后的角色，数据库层面禁止 owner |
| `expires_at` | timestamptz | 创建时 + 1/7/30 天 |
| `max_uses` | integer null，check > 0 | null = 不限次数（仍受席位约束） |
| `used_count` | integer default 0，check ≥ 0 | 成功加入次数 |
| `revoked_at` / `revoked_by` | timestamptz / uuid → user | 作废时间与操作人 |
| `created_by` | uuid → user，restrict | 创建人 |
| `created_at` / `updated_at` | timestamptz | |

索引：`(workspace_id, id desc)`（列表），`token_hash` 唯一索引（查找）。

状态由字段推导，不存冗余状态列：`revoked`（`revoked_at` 非空）> `expired`（`expires_at <= now`）> `exhausted`（`max_uses` 非空且 `used_count >= max_uses`）> `active`。

### D3 服务位置与锁

邀请链接逻辑放在 `packages/auth/src/invite-links.ts`，与 `team-workspaces.ts` 共用锁协议，web 只做会话、限流和 HTTP 适配：

- 生成 / 作废：`owner:<actor>` → `ws:<workspace>` 锁内复核会话与封禁、空间存在且非个人空间、`multiTenant` 开启、操作者为 owner/admin。
- 加入：`owner:<joiner>` → `ws:<workspace>` 锁内复核会话与封禁，按 hash 取链接行，复核状态、创建人仍是该空间 owner/admin、是否已是成员，再调用 `ResolveMaxSeats` 与 `count(member)` 校验席位，最后插入 member、`used_count + 1`、写审计。与邮件邀请接受、直接加成员持有同一把 `ws:` 锁，所以三条入口之间也不会超卖；`member (organization_id, user_id)` 唯一约束兜底重复加入。
- 创建人失去管理权限（被移出、降为 member、删号）后其链接自动失效，无需额外清理；团队空间软删在 `softDelete` 同一事务内批量作废。

### D4 Token 与比较

- 32 字节 `crypto.getRandomValues` → base64url（43 字符），URL 为 `/join/<token>`。
- 库中只存 `sha256(token)`；查找时先按 hash 走唯一索引，取出后再用常量时间比较复核 hash（时间只取决于 hash 长度，与 token 前缀无关）。
- 完整链接只在生成成功时返回一次；列表只显示状态与使用次数，不能再次复制旧链接（只存哈希的直接结果），需要时重新生成。

### D5 token 不进入日志与第三方

- 请求日志（Cloudflare 与 Node 入口的 `http.request`）记录路径前经 `redactUrlPath` 把 `/join/<token>` 改为 `/join/[REDACTED]`；`sentryBeforeSend` 同样处理 `request.url`。
- PostHog 页面统计排除 `/join` 路径；页面设置 `referrer` 为 `no-referrer`。
- 预览与加入使用 POST server function，token 在请求体中，不进查询串；业务日志与审计只记 `linkId`。
- 登录 / 注册回跳使用 `?redirect=/join/<token>`（查询串不进请求日志，Sentry 去掉查询串），回跳白名单只接受 `^/join/[A-Za-z0-9_-]{43}$`。

### D6 限流

加入与预览共用 `RL_AUTH` 策略（每分钟 10 次）：键 `invite-link:ip:<ip>` 与 `invite-link:user:<userId>`，超限返回 429 `RATE_LIMITED`。生成 / 作废只有 owner/admin 可调用，沿用会话校验，不额外限流。

### D7 会话

生成、作废、加入要求真实会话（`withRealSession`，模拟登录不可用）；预览只需登录。未登录访问 `/join/<token>` 不查询链接，只显示登录 / 注册入口，不泄露空间名。

### D8 审计

`audit_log`：`workspace.invite_link_created`（meta：role、expiresAt、maxUses）、`workspace.invite_link_revoked`、`workspace.member_added`（与现有成员加入事件同名，meta 带 `inviteLinkId`、`newRole`），`target_type` 分别为 `invite_link` / `member`。

### D9 迁移

按 docs/09-parallel-plan.md §6.3 例外随 PR 生成 `0022`（集成测试依赖新表）。迁移内追加 `free` 套餐 `maxSeats` 的数据更新语句。

## Risks / Trade-offs

- **持有链接即可加入**：不验证邮箱，链接被转发或泄露时任何能登录的人都能加入（受席位约束）。控制手段：默认 7 天、可选 1 天；可设人数上限；可随时作废；创建人失权即失效；审计可追溯加入者；owner/admin 可移除成员。生成时提示“只发给需要加入的人”。
- **后续**：正式产品接邮件后，可给链接加“限定邮箱域名”选项（加入时校验已验证邮箱的域名），本 change 只记录，不实施。
- **免费席位提到 10**：任何团队空间不付费即有 10 席；没有支付渠道的内测阶段可接受。接入支付后应重新规划套餐席位（届时 `free` 回落需要显式迁移，现有超员空间按“降级后超员”规则保留成员、禁止新增）。
- **只能复制一次**：生成后关闭页面就无法再复制；以“重新生成 + 作废旧链接”替代。
- **新团队空间需要开通**：团队空间首次使用需要管理员在后台为该空间发放积分，否则所有成员看到待开通页。

## Migration Plan

1. 部署包含迁移 `0022` 的版本（迁移幂等：建表 + 条件更新 `free.maxSeats`）。
2. 用户在顶栏“空间”菜单创建团队空间；管理员在 `/admin/workspaces` 找到该空间 ID，到 `/admin/credits` 发放积分开通。
3. owner 在空间设置生成邀请链接发给成员。
回滚：回退应用版本即可，新表无人读取；`free.maxSeats` 需要时手动改回。
