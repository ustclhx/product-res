# Tasks

## 1. 管理员引导开关

- [x] 1.1 `BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED`：auth 引导条件、AuthEnv、Node / Cloudflare 环境声明、compose 与 `.env.example`；开关开 / 关测试。

## 2. 积分开通门

- [x] 2.1 模板配置 `credits.requireGrantForAccess`（默认 false），本项目设 true 且 `billing.signupBonusCredits: 0`。
- [x] 2.2 `withWorkspace` 与 `/api/ai/chat` 强制开通检查；`getWorkspacePage` 返回待开通状态，`/app/$slug` 渲染待开通页面（zh / en 文案）。
- [x] 2.3 测试：未开通 403 与待开通页面、发放后放行、admin 放行。

## 3. 流水线暂停开关

- [x] 3.1 `DATA_PIPELINE_SCHEDULES=paused` 暂停数据 / 选品定时计划（保留注册与对账计划），Node schema、compose、`.env.example`；单元测试。

## 4. 文档

- [x] 4.1 `deploy/selfhost/README.md` 简述三个开关与使用顺序。
