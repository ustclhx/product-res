# P2 支付联通与 staging 验收

## 2. 凭据名称与配置

| 用途 | 必须使用的变量 | 来源 / 约束 |
|---|---|---|
| web、jobs 运行时 | `STRIPE_SECRET_KEY` | 测试环境密钥，代码拒绝非 `sk_test_` 前缀 |
| web、jobs 运行时 | `STRIPE_WEBHOOK_SECRET` | staging Stripe endpoint 的 `whsec_…`；不是 CLI 本地 listener secret |
| web、jobs 运行时 | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET` | sandbox REST App；工厂固定 sandbox |
| web、jobs 运行时 | `PAYPAL_WEBHOOK_ID` | 同一 App、同一 staging URL 的已注册 Webhook ID，不是事件 ID |
| 本机 sync CLI | `BILLING_SYNC_MODE=test`、`STRIPE_SECRET_KEY` | 测试开关与同一 Stripe 测试环境的 secret key |
| 本机 sync CLI | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET` | 同一 PayPal sandbox App；CLI 不要求 Webhook ID |
| 本机 seed / sync CLI | `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | 直连目标 staging 的 **app** DML 连接，不能误用本 worktree 开发库或生产库 |

运行时和 CLI 共用同一套支付变量名。在仓库根目录复制模板后，只在本地文件填入真值：

```sh
cp .env.example .env.local
chmod 600 .env.local
```

根目录 [.env.example](../../.env.example) 只含键和空占位符；`.env.local` 已被 `.gitignore` 忽略。填写五个支付变量，保留 `BILLING_SYNC_MODE=test`。无需 Stripe publishable key：当前结账使用服务端创建的托管 Checkout。PayPal 买家密码只用于沙箱登录，不填入 Worker 配置。Webhook secret / ID 必须对应实际接收 URL：本地 Stripe CLI listener 的 secret 与 staging endpoint 的 secret 不能混用。

`pnpm billing:seed`、`pnpm billing:sync` 自动读取根目录 `.env.local`，进程环境优先；数据库连接未填写时回退到 `.env.worktree`。同步 staging 前必须明确填写或注入目标 staging 的 app 连接，核对库名后再执行。每个 Orca worktree 单独创建自己的 `.env.local`；该文件不通过 `项目维护约定` 自动复制，避免把 staging 数据库连接带入开发分支。数据库和端口继续由 `.env.worktree` 隔离。

`pnpm --filter @product-res/web dev` 与 `pnpm --filter @product-res/jobs dev` 启动时，将五个支付变量写入对应 app 已忽略的 `.dev.vars` 管理区块，供 Cloudflare 本地运行时读取；原有认证配置保留。只需维护根目录 `.env.local`，不需要手动重复填写两个 app。进程环境覆盖本地文件；留空会清除旧的管理区块值，删除 `.env.local` 且未显式设置任何支付进程变量时，再次启动会移除该区块。构建/部署不执行此同步，也不会自动上传本地凭据。OAuth mock 与邮件 log 设置保持原配置。

两 Worker 都调用 `createTestPaymentRuntime`；PayPal 还要求 `CACHE` KV。`docs/07` 中的通用 `PAYPAL_ENV` 不控制当前 P2 工厂，设置 live 不会使其变为 live。staging 仍使用下面的 Cloudflare secrets 配置入口。

离线 Playwright 的 dev 子进程把五项支付变量设为空，并强制启动独立服务；不会复用先前启用真实凭据的 Worker。测试父进程仍不得注入支付凭据。该套离线测试不能用于声明真实支付端到端通过。

构建/部署不调用 dotenv 同步；但 Cloudflare Vite 插件会把 app 已有 `.dev.vars` 复制到 SSR 构建目录，供 `vite preview` 读取构建时快照。此文件被 Git 和前端资源忽略，Web 的 Turbo build 也不缓存该密钥快照；不要把整个 `dist` 当作不含密钥的可分享产物。修改根 `.env.local` 后应重启 dev；只修改根文件不会更新既有 preview 快照。

由操作者在 Cloudflare Dashboard 分别选择 `web-staging`、`jobs-staging` → Settings → Variables and Secrets，按上表录入五个运行时名字。也可从对应 app 目录逐项执行交互式命令（值在提示中输入，不拼进命令）；例如在 `apps/web` 和 `apps/jobs` 各执行一次：

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY --env staging
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
pnpm exec wrangler secret put PAYPAL_CLIENT_ID --env staging
pnpm exec wrangler secret put PAYPAL_CLIENT_SECRET --env staging
pnpm exec wrangler secret put PAYPAL_WEBHOOK_ID --env staging
```

Cloudflare secrets 按环境配置，不应假设从顶层继承；`secret put` 会更新已部署 Worker，纳入发布记录。需要资源/代码发布时使用现有 `pnpm --filter @product-res/jobs deploy:staging`、`pnpm --filter @product-res/web deploy:staging`。不要打印 secret 内容验证配置。官方依据：[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

Stripe 账号应选择专用 sandbox / 测试模式，密钥、事件 destination、价格、客户和 Portal 配置保持在同一测试环境。用 sandbox 买家登录 PayPal，不用真实钱包；账号与 App 准备见 [PayPal sandbox](https://developer.paypal.com/sandbox-testing/overview)。

## 3. 平台 Webhook

### Stripe

当前测试环境的既有 HTTPS destination 已经 API 核对；新环境需在 Workbench / Webhooks 创建，已有匹配 endpoint 时直接复用：

`https://web-staging.product-res-jobs.workers.dev/api/billing/webhooks/stripe`

选择当前账号的 **snapshot** 事件，API 版本必须为代码锁定的 `2026-09-30.endive`（SDK `stripe@23.0.0`）。当前既有 endpoint 配置已通过 API 核对，CLI 触发后 Neon 记录的实际事件版本也是 `2026-09-30.endive`；这不是控制台选版操作证据。新环境不可选时记录界面/版本差异并交 supervisor 处理，不直接改代码锁定或升级全账号。SDK 请求版本不等于 destination 版本；代码对收到的 `event.api_version` 严格相等校验，版本不匹配会 500，且可能在登记前失败。

按 `normalizeStripeEvent` 配置这些事件：

```text
checkout.session.completed
checkout.session.async_payment_succeeded
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
charge.refunded
charge.dispute.created
```

复制该 endpoint 的 signing secret 到运行时，完成一笔真实测试卡交易后检查投递状态、HTTP 200 和数据库 `processed`，同时核对实际 `api_version`。原始请求体与 `Stripe-Signature` 用于 Web Crypto 验签，不能先重排 JSON。Stripe 官方说明版本、重复事件及重投规则见 [Webhooks](https://docs.stripe.com/webhooks)。另在同一测试环境启用 Customer Portal，账单页打开门户并返回应用也须实测。


### PayPal

当前 Sandbox App 的既有 Webhook 地址与 12 项事件已通过 API 核对。新环境在 Developer Dashboard → Apps & Credentials → **Sandbox** → 当前 REST App 下创建，已有匹配 Webhook 时直接复用：

`https://web-staging.product-res-jobs.workers.dev/api/billing/webhooks/paypal`

保存该 URL 的 Webhook ID，并选择代码支持的事件：

```text
CHECKOUT.ORDER.APPROVED
BILLING.SUBSCRIPTION.ACTIVATED
BILLING.SUBSCRIPTION.UPDATED
BILLING.SUBSCRIPTION.CANCELLED
BILLING.SUBSCRIPTION.EXPIRED
BILLING.SUBSCRIPTION.SUSPENDED
BILLING.SUBSCRIPTION.PAYMENT.FAILED
PAYMENT.SALE.COMPLETED
PAYMENT.CAPTURE.COMPLETED
PAYMENT.SALE.REFUNDED
PAYMENT.CAPTURE.REFUNDED
CUSTOMER.DISPUTE.CREATED
```

官方 [事件目录](https://developer.paypal.com/api/rest/webhooks/event-names/) 仍列出订阅 Sale 完成/退款事件，但不能由此认定当前 App 与适配器字段完全匹配。当前实现将五个 `paypal-*` transmission headers、Webhook ID 与事件回传 `/v1/notifications/verify-webhook-signature`，必须返回 `SUCCESS`；订阅首付/续费还会读取 Sale、订阅交易历史及 Plan 来证明付款身份和周期。官方 [Webhook 集成](https://developer.paypal.com/api/rest/webhooks/rest/) 明确：模拟器事件不支持该回传验签方式。因此必须由当前 App 的 sandbox 交易产生回调，模拟器成功/失败都不能代替 3.3 验收。

特别核对订阅路径使用的 `/v1/payments/sale/{id}`、Sale refund 和 `/v1/payments/refund/{id}`：官方 [Payments v1](https://developer.paypal.com/api/deprecated/payments/v1) 已标记弃用，当前账号能否读取/退款须实际验证。如接口拒绝或真实字段、历史分页、时间锚点无法证明周期，应保存失败证据并修复后重测；不要改成猜测 payment ID、伪造历史或以 Capture ID 代替 Sale ID。

### HTTP 判定

未知 provider 404；未配置 provider 503；非法 JSON / 验签失败 400；超过 1 MiB 413；业务、远端请求或数据库失败 500。已提交付款即使队列发送失败仍返回 200，由 jobs 恢复通知。200 只说明接收成功：不支持的事件可以 `ignored`，必须同时检查事件和付款/积分记录。当前处理包含同步远端读取和事务，不是收到即异步入账；记录实际延迟和平台重试，勿把超时当作一定未付款。

## 4. 价格同步与幂等复验（1.3）


以下为后续重验命令，从受保护 `.env.staging-neon` 加载连接，核对目标 Neon staging / app，并保存原报价快照。命令在仓库根目录执行，前提是上述支付 CLI 变量已在根目录 `.env.local` 配置，或通过安全方式注入进程环境；明确覆盖数据库连接，避免回退到 worktree 开发库：

```sh
set -a
. ./.env.staging-neon
set +a
psql "$NEON_APP_URL" -X -v ON_ERROR_STOP=1 \
  -c 'select current_database(), current_user'
# 当前 Neon 库已 seed；仅重建验收库时才需这一条。
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" BILLING_SYNC_MODE=test pnpm billing:sync
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" BILLING_SYNC_MODE=test pnpm billing:sync
```

seed 会 upsert 示例套餐，不能当成不会覆盖配置的只读操作。默认 USD 最小货币单位：Pro 月 1900 / 年 19000、每月 1000 积分；Team 月 4900 / 年 49000、每月 5000 积分；积分包 1000、1000 积分、365 天；free 没有远端价格。

预期每次 sync 报 10 个映射，本地有效报价不再 `unsynced:*`。Stripe 5 个 Price；PayPal 4 个 recurring Plan/Product 映射，积分包是本地 `paypal:credit_pack:{plan_price.id}` 标识，按金额创建 Order，**不会出现 PayPal 积分包 Plan**。第二次成功执行前后本地 ID、远端 ID、金额/币种/周期以及远端对象数量不变，保存两轮快照。平台幂等请求保留时间不能代替本地持久化映射；远端创建成功但本地保存失败时，先人工对账，不删库映射盲目重跑。

## 6. 可审计验收数据

每个场景记录：场景编号、操作者、UTC、Git SHA、两 Worker version、平台测试环境/App/endpoint ID、workspace/user ID、plan_price ID、subscription/order/invoice/payment/refund/event ID，付款额/退款额/币种/周期，事件名与 Stripe api_version、每次投递状态/耗时，录制原文 hash/受限位置、脱敏夹具位置、前后余额/批次/流水/权益、Cron/Queue/审计结果、pass/fail/pending 和原因。公开报告不包含凭据或个人信息。

在已经安全连接目标库的只读 psql 会话中设置实际 workspace UUID 后执行（`\set workspace_id '实际UUID'`），输出只保存必要字段；不导出全量 payload 或 contact_email：

```sql
SELECT current_database(), current_user;
SELECT id, provider, provider_price_id, interval, amount, currency, active
FROM plan_price ORDER BY provider, id;
SELECT id, provider, provider_subscription_id, status, cancel_at_period_end,
       current_period_start, current_period_end, last_event_at
FROM subscription WHERE workspace_id = :'workspace_id';
SELECT id, provider, provider_payment_id, kind, plan_price_id, amount,
       refunded_amount, status, period_start, period_end
FROM payment WHERE workspace_id = :'workspace_id';
SELECT payment_id, provider, provider_refund_id, amount, currency
FROM payment_refund WHERE workspace_id = :'workspace_id';
SELECT source, source_ref, payment_id, amount, remaining, status, expires_at
FROM credit_grant WHERE workspace_id = :'workspace_id';
SELECT type, delta, grant_id FROM credit_ledger WHERE workspace_id = :'workspace_id';
SELECT
  (SELECT coalesce(sum(delta), 0) FROM credit_ledger
   WHERE workspace_id = :'workspace_id') AS ledger,
  (SELECT coalesce(sum(remaining), 0) FROM credit_grant
   WHERE workspace_id = :'workspace_id' AND status = 'active')
  + (SELECT coalesce(sum(amount), 0) FROM credit_hold
     WHERE workspace_id = :'workspace_id' AND status = 'held')
  - (SELECT coalesce(sum(amount), 0) FROM credit_debt
     WHERE workspace_id = :'workspace_id') AS expected;
SELECT count(*) AS negative_grants FROM credit_grant
WHERE workspace_id = :'workspace_id' AND remaining < 0;
```

`ledger = expected`、negative_grants 为 0；同一 `(provider, provider_event_id)`、付款身份、退款身份和 `(source, source_ref)` 不重复。以实际事件 ID 定位 `webhook_event` 的 status/attempts/error/processed_at，以实际目标 ID 定位 `audit_log`；事件表没有 workspace_id，不能套用空间过滤。记录退款申请 status/approved_amount/provider_refund_id 与 `billing.payment_refunded`、`billing.webhook_postprocessed` 审计。Cron 为 UTC 每小时、每 10 分钟、每日 04:00；daily 对账结果需真实观测，不能靠 HTTP 200 推断。邮件保持 log 时只验队列和模板处理，不声明邮件已送达。

## 8. 代码核对索引

- `packages/billing/src/runtime.ts:22` `createTestPaymentRuntime`；`packages/billing/scripts/sync.ts:9` CLI 门槛；`packages/db/worktree-env.ts:7` `readLocalEnv`。
- `packages/billing/src/stripe/client.ts:4` `STRIPE_API_VERSION`；`stripe/adapter.ts:216` `verifyWebhook` 与版本检查；`stripe/operations.ts` `cancelStripeSubscription` / `resumeStripeSubscription` / `changeStripePlan`。
- `packages/billing/src/paypal/webhooks.ts:67` `payPalWebhookNormalizer`、`:252` `verifyPayPalWebhook`；`paypal/operations.ts:237` suspend/cancel、`:252` activate；`paypal/snapshots.ts:426` `classifyPayPalSale`、`:439` `salePeriod`。
- `packages/billing/src/catalog.ts:8` `EXAMPLE_CATALOG`、`:99` `seedCatalog`、`:134` `syncCatalog`；`services.ts:275` 取消、`:305` 恢复；`events.ts:532` `applyBillingEvent` 的退款身份/累计/收回逻辑。
- `apps/web/src/features/billing/webhook-http.ts:11` `handleBillingWebhook`；`apps/jobs/src/billing.ts:20` Cron 常量与 `runBillingSchedule`；`packages/billing/src/cron.ts:96` `runAnnualGrants`、`:244` `runSubscriptionReconciliation`、`:304` `runCreditReconciliation`。

