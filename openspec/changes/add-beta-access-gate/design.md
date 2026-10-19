# Design

## D1 未验证管理员引导

`adminBootstrap(db, emails, { allowUnverified })` 在 `allowUnverified` 为真时从资格条件中去掉 `email_verified = true`，名单、未封禁、只提升与审计逻辑不变。`AuthEnv` / `parseAuthEnv`、Node 环境 schema 与 Cloudflare web 环境均声明 `BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED`（字符串，可选），只有 `'true'` 生效；Node 端空串按未设置处理，与 Compose `${NAME:-}` 透传一致。

风险：开关打开时，谁先以名单邮箱注册谁就是管理员。运维须同时把 `SIGNUP_ALLOWED_EMAILS` 设为只放行运维邮箱，完成提升后关闭开关并按需放开白名单。

## D2 积分开通门

- 开通条件（不新增迁移）：`credit_grant` 中存在 `workspace_id = 当前空间` 且 `source = 'admin'` 的行。后台“发放积分”经 `adjustAdminCredits → grant(source: 'admin')` 写入，数额恒为正；之后撤销该批次不会取消开通（开通是一次性准入，余额由积分规则继续约束）。
- 平台 admin（`user.role` 逗号分隔角色含 `admin`）始终放行；模拟登录时以被模拟用户判断。
- 强制点：`withWorkspace` 中间件在解析空间后检查，未开通抛 `AppError('ACCOUNT_NOT_ACTIVATED', status 403)`；`withEntitlement` 与文件中间件继承它。另提供不检查开通的 `withWorkspaceMembership`，仅供 `/app` 重定向和 `getWorkspacePage` 使用，后者返回 `activation: 'pending' | 'active'`。
- `/api/ai/chat` 不经 `withWorkspace`，在解析空间后调用同一检查。
- 页面：`/app/$slug` 的 `beforeLoad` 读到 `pending` 时抛 `notFound({ data: { reason: 'account-not-activated' } })`，这样子路由 loader 不会执行（否则子 loader 的 403 会让 SSR 返回 500）；该路由的 `notFoundComponent` 按 `data.reason` 渲染待开通页面（含账户设置与退出入口）。响应状态为 404，页面只对登录用户可见，可接受。
- `/account`、登出、`/admin` 不经过 `withWorkspace`，不受影响。

## D3 流水线暂停

`DATA_PIPELINE_SCHEDULES` 在 Node 环境 schema 中为 `'paused' | 'running'` 可选枚举（空串按未设置）；拼写错误在启动时失败，避免误以为已暂停。

`pausePipelineSchedules(scheduler, paused)` 包装 `Scheduler`：注册 ID 属于暂停集合的计划时，处理函数改为记录 `log.info('pipeline.paused', { scheduleId })` 后返回；计划本身仍注册，调度器健康检查与就绪门不变。暂停集合：`datasources-daily-v1`、`selection-daily-v1`、`selection-label-v1`、`selection-readiness-v1`、`selection-review-v1`。

`datasources-reconcile-v1` 不暂停：它只把超时的额度预留置为过期，维护配额一致性，不访问外部数据源。数据同步队列、Keepa 回放队列等手动 / 队列入口不变。Cloudflare jobs 没有这些计划，不做处理。
