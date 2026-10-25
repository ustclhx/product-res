# Proposal

## Why

内测不接邮件服务（`EMAIL_TRANSPORT=log`），模板现有的邮件邀请在内测无法使用：邀请绑定收件人邮箱，接受前还要求邮箱已验证，而验证邮件发不出去。同时 `template.config.ts` 的 `tenancy.multiTenant` 为 `false`，只有个人空间，按 `workspace-tenancy` 规范个人空间不能邀请成员，团队无法共用一个空间的选品数据。

用户决定：开启团队空间（现有个人空间数据保留不动，之后在新团队空间重新配置）；新增可多人使用的邀请链接（默认 7 天有效，可选人数上限，可随时作废），生成时选择加入后的角色（member 或 admin，不能选 owner）。

## What Changes

- `template.config.ts` 设 `tenancy.multiTenant: true`，并处理开启后的影响：
  - 顶栏空间切换器与“创建团队空间”入口改为中文文案（i18n 关闭时默认语言为 zh），收进紧凑的下拉面板，不挤占顶栏。
  - 待开通页面（`credits.requireGrantForAccess`）列出用户的其它空间，避免新建的团队空间尚未开通时用户被困在待开通页。
  - 席位：免费套餐的 `maxSeats` 为 1，没有支付渠道时团队空间无法加人。示例目录与迁移把 `free` 套餐的 `maxSeats` 提到 10（只改 `maxSeats=1` 的行，后台调整过的值不覆盖）。
  - `workspaceReadOnly` 只在 `multiTenant=false` 时对团队空间生效，开启后团队空间可写，无需代码改动；e2e 中依赖开关的分支随之切换，按中文文案更新定位。
- 新增**团队空间邀请链接**：
  - 新表 `workspace_invite_link`（按空间隔离）：token 只存 SHA-256 哈希，记录角色、过期时间、人数上限、已用次数、作废时间与作废人、创建人。
  - 空间设置的成员管理处，owner / admin 可以生成链接（选角色 member / admin、有效期 1 / 7 / 30 天、可选人数上限）、复制、查看列表与使用次数、作废；member 看不到这些操作。个人空间不显示，服务端拒绝。
  - 打开 `/join/<token>`：未登录先登录或注册，完成后回到该链接；已登录显示“加入 <空间名>（角色）”并确认，加入后进入该空间；已是成员直接跳转；过期、作废、达到上限或创建人已无管理权限时给出明确提示。
  - 加入在空间事务锁内校验 `maxSeats` 与人数上限，并发争抢最后一个席位只有一人成功。
  - 安全：256 位随机 token，只存哈希、常量时间比较；加入与预览接口按 IP 与用户限流；请求日志、Sentry 与页面统计中不出现 token；生成、作废、加入写入 `audit_log`。
  - 不要求邮箱验证；风险与控制手段写入 design。现有邮件邀请保留不变。
- 团队空间软删时作废其全部邀请链接（恢复空间后旧链接仍作废，与邮件邀请一致）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `workspace-tenancy`：新增邀请链接的生成、作废、加入、席位与安全要求。

## Impact

- `template.config.ts`；`packages/db`（schema `tenancy.ts`、迁移 `0022`）；`packages/auth`（邀请链接服务、团队空间软删）；`packages/billing`（示例目录 `free.maxSeats`）；`packages/shared`（日志路径脱敏）。
- `apps/web`：`/join/$token` 页面、空间设置成员管理、空间切换器、待开通页面、登录 / 注册回跳白名单、请求日志与 PostHog 路径排除、文案 `messages/{zh,en}/invite-links.json` 与 `workspace.json`。
- e2e：新增邀请链接用例，更新 `workspace.spec.ts`、`deletion.spec.ts` 中开启团队空间后的定位。
- 迁移按 docs/09-parallel-plan.md §6.3 例外随本 PR 提交（集成测试依赖新表），本波次只此一个迁移。
- 无新依赖。
