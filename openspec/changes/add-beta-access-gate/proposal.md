# Proposal

## Why

生产（自托管 Node）进入内测：不接邮件服务（`EMAIL_TRANSPORT=log`），用户以邮箱 + 密码注册且无法完成邮箱验证。现状有三个阻碍：运维邮箱无法经 `BOOTSTRAP_ADMIN_EMAILS` 成为管理员（引导要求已验证邮箱）；任何注册账号都能直接使用工作台并领取注册赠送积分；数据源凭据验收前，定时数据 / 选品流水线仍会按计划运行。

## What Changes

- 新增环境变量 `BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED`：取值 `true` 时管理员引导不再要求邮箱已验证（仍要求名单内、未封禁）；其它取值、空串或未设置保持现有行为。
- 模板配置新增 `credits.requireGrantForAccess`（默认 `false`）：开启后，空间存在管理员发放的积分批次（`credit_grant.source = 'admin'`）或用户为平台 admin 时才能使用工作台；未开通时工作台 server function 返回 403 `ACCOUNT_NOT_ACTIVATED`，`/app/$slug` 显示“账号待管理员开通”页面。本项目设为 `true`，并将 `billing.signupBonusCredits` 设为 `0`。
- 新增环境变量 `DATA_PIPELINE_SCHEDULES`：取值 `paused` 时数据层每日流水线与选品相关定时计划仍注册，但处理函数直接返回并记录 `pipeline.paused`；空串或未设置照常运行。手动触发入口不受影响。
- 自托管 compose、`.env.example` 与运维文档同步三个开关。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `admin-bootstrap`：新增显式开关允许未验证邮箱的名单账号被提升。
- `credits`：新增管理员发放积分作为工作台开通条件。
- `job-scheduling`：新增数据流水线定时计划暂停开关。

## Impact

- `packages/auth`（引导条件、环境类型）、`packages/config`（Node 环境 schema、模板配置类型与默认值）、`packages/credits`（开通查询）。
- `apps/web`：`withWorkspace` 中间件、AI 对话入口、`/app/$slug` 布局、文案、Cloudflare 环境声明。
- `apps/jobs`：Node 调度装配。
- `deploy/selfhost/compose.yaml`、`deploy/selfhost/.env.example`、`deploy/selfhost/README.md`。
- 无数据库迁移、无新依赖。
