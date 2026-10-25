# 工作空间数据流转 e2e（7.3）

在仓库根目录、已完成 setup 的 Orca worktree 中运行。需要本地 PG、现有迁移与 Chromium；
本机容器为 `saas-template-pg`。`.env.worktree` 必须指向独立的 `product_res_wt_*` 数据库，
`apps/web/.dev.vars` 的 `APP_URL` 应与 `.env.worktree` 中的 `WEB_PORT` 一致。
先停止本 worktree 端口上的旧 dev 服务，只结束自己启动的进程。

```sh
env -u STRIPE_SECRET_KEY -u STRIPE_WEBHOOK_SECRET \
  -u PAYPAL_CLIENT_ID -u PAYPAL_CLIENT_SECRET -u PAYPAL_WEBHOOK_ID \
  pnpm --filter @product-res/web exec playwright test -c playwright.transfer.config.ts
```

独立配置只发现 `workspace-transfer.transfer.ts`，普通 e2e 不自动执行它。
Playwright 自动启动并关闭一个 Vite 进程，通过 `auxiliaryWorkers` 装配真实 jobs Worker，
web 绑定其 `WorkspaceTransferWorkflow`。绑定仅存在于 `e2e/transfer.vite.ts`，不修改
生产 Wrangler 配置；`tenancy.dataTransfer` 也仅在此配置的编译图内开启，根默认值仍为 false。
禁止远程环境、远程绑定与构建模式。支付环境沿用普通离线 suite 的五项空值。
配置依据：[Cloudflare Vite plugin API](https://developers.cloudflare.com/workers/vite-plugin/reference/api/)。

三条用例覆盖升级预览与真实移动、两项选择性复制与同名重命名、真实 running 时两边只读
及陈旧表单写入拒绝和结束后恢复。只读测试用数据库事务锁住本测试的源方向，释放后由真实
Workflow 继续；不模拟流转 API、不直接修改任务状态。用例检查已完成批次与执行后的 ID 映射，
夹具只写隔离数据库，不调用外部采集或支付服务。注册用户与业务数据留在此 worktree 库供排查，
重复运行使用随机用户和 slug。

证据位于 `apps/web/test-results/workspace-transfer.transfer.ts-*/`：

- `upgrade-preview.png`、`copy-preview.png`、`running-readonly.png`、每条用例的 `completed.png`
- `trace.zip`（成功也保留；包含测试账号会话，仅限本地验收）

服务日志：`/tmp/transfer-e2e.log`。Workflow 本地状态：`apps/web/.wrangler/transfer-e2e/`。
上述证据和本地状态均不提交。
