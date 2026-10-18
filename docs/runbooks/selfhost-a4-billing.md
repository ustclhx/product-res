# A 4.2：计费、积分与后台平台迁移

本批只实施 `add-selfhost-foundation` 4.2。支付 Provider、账本和 adminAction 的事务规则保持原样；没有新迁移、真实支付请求或 staging 部署。

## 请求装配

计费与后台 Server Functions/API 使用 `getWebRuntime()` 的数据库、认证、缓存、标量配置及可信请求 IP。Cloudflare 入口显式挑选支付配置，装配中立邮件/事件队列；密钥不随页面数据返回。支付模式仍由 `createPaymentRuntime` 延迟校验，错误配置不会阻断普通认证或公开页面的降级。

`WebRuntime.emailQueue/eventsQueue` 使用 `Capability<QueueProducer<...>>`。Webhook 处理、回调重放和退款通知相关写入在副作用前要求能力可用；Node 尚无 B 时返回 503，不提供临时队列。只读账单/退款查询不要求队列。现有 CF 队列发送仍保留 JSON 消息、requestId 和原有提交后通知规则。

`features/billing/deletion.server.ts` 提供中立 `createBillingDeletionSteps(config, db, cache)`。共享 `server/auth.ts` 保留旧 `billingDeletionSteps(env, db)` 包装供未分配的删除入口使用，由 4.6 清理；本批计费和后台业务不调用旧 `getAuth`，不读取客户端 CF/XFF 头。

## 本地验证

在本 worktree 的隔离 PG17 上运行；Node 项目缺资源立即失败，不能退化为跳过集成。数据库配置从 `.env.worktree` 读取，测试 URL 必须指向同一 `product_res_wt_*` 数据库（CI 为 `product_res_ci`）。仅后台 Node 项目还需要独立测试 Valkey：

```sh
pnpm --filter @product-res/billing exec vitest run --config vitest.node.config.ts
pnpm --filter @product-res/credits exec vitest run --config vitest.node.config.ts
pnpm --filter @product-res/entitlements exec vitest run --config vitest.node.config.ts
TEST_VALKEY_URL=<隔离测试缓存> pnpm --filter @product-res/web exec vitest run --config vitest.billing.node.config.ts
```

前三包复用原有原生 Node/PG 业务用例，分别通过 296、50、14 项。后台 Node 项目精确替换目标资源夹具，复用 CF 的 7 文件、34 项断言，覆盖实时权限、审计失败回滚、封禁/模拟会话、席位、设置和账单；缓存实际经 Valkey。CF 和 Node 不同时跑同库后台测试，以免全局设置/指标相互影响。

Web 入口单元测试覆盖支付配置失败的 503、普通认证延迟初始化、缺少邮件/事件能力时无退款或账本写入、可信 IP 和配置的回跳 URL。依赖检查移除本批 10 个 transition 条目，仅登记准确的 CF/Node 后台资源夹具。

根 `pnpm check`、`check:deps`、`check:singletons`、`dedupe --check`、`typecheck`、`test` 和 `build` 全部通过；完整测试为 1,175 项。默认 CF 构建完成 18 页预渲染；本地 `test:e2e:smoke` 1/1 通过，验证注册、退出/登录、积分包购买和重复回调只入账一次。未修改冒烟夹具或流水线。

## 剩余验收

Node 真实退款邮件、Webhook 后处理与运营通知的持久投递/重试等待 B 的任务引擎装配（9.1/9.2），完整 Compose 认证邮件链路等待 9.3；本批捕获式发信或能力缺失测试不替代它们。现有 CF CI、e2e-smoke 和 main 自动 staging 发布流程未修改。合入后 staging 验收由协调者执行，本 worker 不手工部署。
