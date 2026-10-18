# P2 支付联通与 staging 验收

P2 离线基线：PR #24 / `458fafdef81cf30cc41516eec15fc4d1e7122725`，2026-10-05；staging 状态更新至 2026-10-09 UTC。P2 离线验收为 28/34；本文件记录操作步骤与有限联通证据。1.3、3.2、3.3、10.1、10.4、11.1 在完整门槛经 supervisor 核验前保持未完成；离线结果见 [p2-offline-acceptance.md](./p2-offline-acceptance.md)。

## 1. 当前准备状态与责任边界

### 2026-10-11 PayPal 配置与 checkout 补正

- Developer Dashboard 已登录；复用 Sandbox `Default Application`、既有 business 卖家与不同的 verified personal 买家（测试余额 USD 5,000），未新建 App 或重置密码。
- 05:09 UTC 预检：Sandbox OAuth 与 Webhook 查询均 200，目标 staging URL 的 12 项事件齐全；web/jobs 三项 PayPal secret 名称均存在，5 项 PayPal 报价 active。根目录忽略文件 `.env.local` 已补齐对应 Webhook ID；未把买家密码写入运行时。
- 测试空间 `u-4py7aicz` 购买前余额 1,000、预扣与欠款为 0，仅有既存 Stripe 付款，无 PayPal 付款或订阅。
- $10 / 1,000 积分包 checkout 首次失败的日志为 `billing.action_failed`，request ID `01a1295e-fbb0-764f-8174-bd95253c87e2`。`loadToken` 调用 `options.fetch(...)` 触发 Workers `Illegal invocation`，不是该请求 CPU 超限。transport 改为局部解构 `fetch`，OAuth 与业务 API 均使用普通函数调用。
- 回归用例先复现相同异常，修复后 billing 170 项测试、包 typecheck、定向 Biome、Web staging 构建及 jobs staging dry-run 通过。按 jobs → web 手动发布；jobs version `aeb85b7a-95ec-408c-b6b6-1b468a90f56a`，web version `05c6cc84-e25f-43f8-bcba-b409ae0f1d84`。健康检查为 `ok`、`db.up`，应用版本 `c51c26a-paypal-fetch-fix`：这是 `c51c26a` 加本地未提交修复的明确标记，不代表 main 已包含修复；后续 main 自动发布前应先纳入此修复。
- 已从更新后的 billing 页面创建 Sandbox 积分包订单 `2A672877DY6250409`。Chrome 扩展浮层关闭后继续原订单，使用既有 personal 买家登录，成功到达 USD 10.00 付款确认页，已选择 PayPal 测试余额，最终按钮为“完成购物”。按用户要求停在该按钮前交接，未批准付款；capture、回调验签与积分入账仍待验收，不能据此完成 3.3、10.4、11.1。继续时检查此订单及回跳结果，避免盲目重复创建订单。

以下保留早期联通与部署记录；最新 PayPal 进度以上述记录为准。

后续用户已批准上述沙箱订单，但应用确认失败。05:45 UTC 只读核验：PayPal 订单 `APPROVED`、capture 数 0，本地 purchase 为 pending，PayPal payment 与该订单关联 webhook 均为 0，余额仍为原 Stripe 的 1,000。staging 被 main `04fb16c47cf3d0bcbe2f89bbe7c79f217ba6d131` 的自动发布覆盖；实时回调日志在旧 bundle 中再次报 `Illegal invocation`（request ID `01a1297f-2839-7468-a593-5535a2da4e14`）。已再次按 jobs → web 恢复修复：jobs version `70cdcbc4-b25c-4958-aba7-13ff8fb67a39`，web version `db95e7a0-7c2a-4e5b-a87b-576b919bb04d`，健康检查 `ok` / `db.up`，应用版本 `04fb16c-paypal-fetch-fix`。用户授权后，修复已提交为 `a6566d1` 并创建草稿 [PR #82](https://github.com/ustclhx/product-res/pull/82)，尚未合并；在合入 main 前，自动部署仍可能覆盖临时修复。

05:51 UTC 复核：用户再次确认后，原订单和唯一 Capture `821243239P5069342` 均为 `COMPLETED`，金额 USD 10.00。本地对应 1 条 paid purchase、1 条 succeeded payment、1 条 1,000 积分 grant 和 1 条 +1,000 ledger；余额由 1,000 增至 2,000，与账本及有效批次余额一致。`CHECKOUT.ORDER.APPROVED` 与 `PAYMENT.CAPTURE.COMPLETED` 均为 processed、attempts=1、error=null，capture 完成时间 05:50:09 UTC，完成回调处理时间 05:50:30.848 UTC。只读证据见 [PayPal 积分包 capture](evidence/p2-paypal/credit-pack-capture-2026-10-11.json)。这证明本次实际沙箱积分包购买、验签与唯一入账通过；没有主动重投事件，订阅、续费、取消/恢复、退款和重复回调矩阵仍待验收，3.3、10.4、11.1 不提前勾选。

2026-10-05 本机旧 staging 历史记录：已应用 0002–0007（累计 8 条迁移），seed 为 4 套餐、10 报价且当时全部 inactive；`events-staging` 已有 1 producer / 1 consumer。发布版本：jobs `91bdd92a-1ffd-4fc8-9672-ecec303045f0`，web `6c9cf30a-05fa-4e28-8ab4-976424fee830`；健康检查、定价页和未配置支付时 503 已核验。上述 inactive 与缺少凭据均为历史状态。

当前线上 staging 已由 main 自动部署代码 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`，两个新 Hyperdrive 均连接 Neon `product_res_staging`，不再依赖本机 PG 或 cloudflared。受限角色、12 条迁移、两轮四套餐 seed 与锁探针七场景/49 断言已通过；健康检查 200、db.up、完整 SHA 匹配，Cron 心跳在 10 分钟内更新。Stripe Sandbox account 与 PayPal Sandbox OAuth 已核验，所需 staging secrets 已配置；`staging:check-secrets` 退出 0。两平台价格同步两次成功、10 项映射 active，Stripe Test endpoint 验签通过；原三项 staging 冒烟（6.2）在本机现有 HTTP 代理下退出 0、3 passed、20.2 秒，临时等效配置未改断言或超时，未使用 mock、伪造 Turnstile token 或修改系统设置。版本探活（7.1）正确版本退出 0，错误版本 36 轮约 180 秒后退出 1。Neon change 最终为 28/29，仅24 小时观察（9.2）保持未完成；Stripe Sandbox 小额积分包已付款、余额增加，最小修复后同一原始事件重投返回 200 且无重复入账，购买（9.1）已通过；退款、订阅、PayPal 购买与完整业务回调验收仍待完成。PR #61、#62、#64 均已合并，Neon Hyperdrive、AI Gateway vars 与 observability 配置已在 main；本 PR 3 仅更新文档与任务记录。新旧库为独立数据集，不搬迁旧测试数据；支付验收须匹配实际 Worker 绑定与目标库，计费读写使用不缓存的 `HYPERDRIVE`。无需重做已完成迁移；资源或代码变化后的部署顺序仍是 jobs → web。见 [基础设施](../07-infrastructure.md) 与 [Neon staging 操作记录](staging-neon.md)。

自动发布（7.4）由 [run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572) 验收：2026-10-09 06:36:31–06:38:28 UTC，completed/success，head 为上述完整 SHA，迁移 → jobs → web → 版本探活 → 三项冒烟均 success（3 passed，10.0 秒）。jobs Worker version `38ec01c5-8ced-4173-b478-e2e4f1dc9139`，web `7281e552-88c9-4c40-bfb9-b3ae0c69c83d`；06:41:05.684100 UTC 健康为 ok、db.up、完整 SHA 匹配，`jobs.lastCronAt = 2026-10-09T06:40:35.438Z`。PR #62 初次运行 [37892016841](https://github.com/ustclhx/product-res/actions/runs/37892016841) 在 web 预渲染失败；#64 仅在 Deploy web step 设置两个不可达的 local Hyperdrive 占位连接，构建沿用已有 pricing fallback，不连接真实数据库。成功验收来自补正后的运行，手动部署记录见 §5。

联通需要 Stripe 同一测试环境的 secret key、Webhook endpoint signing secret、Portal 配置权限；PayPal 同一 sandbox REST App 的 Client ID、Client Secret、Webhook ID，以及不同的 business 卖家 / personal 买家测试账号；Cloudflare 两 Worker staging 的 secrets 配置权限；目标 staging 的 app 账号数据库连接、owner 测试用户和平台 admin。当前 API 凭据与 webhook 配置已有核验证据；Portal、买家账号和完整交易场景仍按下文逐项验收。仅汇报准备状态和非敏感对象 ID，不把秘密、数据库密码或买家密码贴进聊天、Git、日志或 shell 命令参数。

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

`pnpm billing:seed`、`pnpm billing:sync` 自动读取根目录 `.env.local`，进程环境优先；数据库连接未填写时回退到 `.env.worktree`。同步 staging 前必须明确填写或注入目标 staging 的 app 连接，核对库名后再执行。每个 Orca worktree 单独创建自己的 `.env.local`；该文件不通过 `.worktreeinclude` 自动复制，避免把 staging 数据库连接带入开发分支。数据库和端口继续由 `.env.worktree` 隔离。

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

2026-10-09 UTC，Stripe CLI 发起 Test `invoice.paid`，经真实 endpoint 投递到线上 staging。Neon `webhook_event` 中 `evt_1UOUaIL3UTpBAoXoYmdX1ucI` 为 `api_version = 2026-09-30.endive`、`status = ignored`、`attempts = 1`、`processed_at = 2026-10-09T03:35:02.565Z`。真实验签通过，事件无订阅，未触发业务动作或发积分；Neon 任务 5.3 通过。该 CLI 事件不能替代真实测试卡结账、购买任务 9.1 或 P2 3.2 / 10.1 / 11.1。

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

2026-10-09 UTC 已在 Neon 完成同步：写入前 guard 核验 `product_res_staging / app`，Stripe API 核验目标 Sandbox account，PayPal Sandbox OAuth 通过。网络失败后安全续跑 `billing:sync` 两次均退出 0；readonly 复核全部 10 项映射 active，UUID 与远端 ID 稳定。此证据供 P2 1.3 完整门槛核验，不代替购买验收。

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

## 5. 真实验收顺序

每个场景使用明确的 workspace / 用户 / provider，记录 UTC 起止时间。先做两平台月付、年付、积分包各一笔；取消、退款、换套餐使用独立订阅，避免污染后续续费。页面路径：`/pricing`、`/app/$slug/billing-return`、`/app/$slug/billing`、`/app/$slug/usage`、`/admin/billing`、`/admin/billing/refunds`。

| 场景 | 操作与通过标准 |
|---|---|
| 首付与回跳 | owner 从定价页选平台/报价并完成批准；Stripe 使用官方测试卡 `4242 4242 4242 4242`、未来有效期、任意合法 CVC，见 [测试支付](https://docs.stripe.com/testing)。保留平台交易与浏览器回跳证据。订阅 checkout/activation 只关联，首付付款才发一份积分；年付只发首月，不一次发 12 倍。付款具备不可变报价和周期快照。 |
| 积分包 | 两平台购买；Stripe `payment_intent` 与 PayPal Capture ID 正确关联。PayPal 返回页执行 Orders capture，刷新返回页与重复回调不重复入账；只批准未 capture 不能记付款或发积分。capture 与 callback 两种先后顺序如未真实观测，保留离线证据并标注缺少真实顺序覆盖。 |
| 月付/年付续费 | 见下文时间约束；新付款 ID、`kind=renewal`、正确 workspace 和服务周期，订阅周期推进，只新增对应付款的一个首月批次。不能根据回调到达顺序判断 PayPal initial / renewal。 |
| 取消与恢复 | Stripe 账单页周期末取消应远端 `cancel_at_period_end=true`；到期前恢复为 false，再观测一次续费。PayPal 周期末取消实为远端 **SUSPENDED**、本地 `canceled + cancel_at_period_end=true`，已付周期内仍有权益；SUSPENDED 回调与每日对账不能变成本地 paused 而丢权益。到期前恢复调用 activate，远端 ACTIVE、本地 active/false；恢复后扣款及交易历史连续性必须实测。已有另一会续费订阅时恢复应被拒绝。 |
| 终止 | 另一个取消订阅到周期末后失去付费权益、停止收款；PayPal 每日对账最终 cancel。已终止订阅不能按“恢复”重启。取消不自动退款。 |
| 换套餐/换平台 | Stripe 升级立即生效，补差 `adjustment` 记录付款但不补发积分；降级由 schedule 在周期末生效。PayPal 同平台换套餐、跨平台更换先取消旧、再付新；旧订阅保留已付期，至多一条会续费，重叠权益取较高套餐，两个真实付款各自发积分。 |
| 退款申请与平台退款 | 用户申请、admin 部分审核，分别验证 Stripe、PayPal Capture 与 PayPal Sale 退款路径；另取付款做平台侧全额退款。审核/API 响应不能代替回调最终入账，见下一节。 |
| 重复/迟到回调 | 同一首付、续费、退款平台事件分别重投至少两次；记录每次状态。付款、退款身份、批次和流水不能增量重复；新旧事件 ID 与相同业务对象的重复也须按业务幂等处理。旧状态回调不能回退较新状态。 |

### Stripe 首付自动化用例（10.1）

`apps/web/e2e-live/` 是真实 Stripe 测试模式的 Playwright 用例（`playwright.stripe.config.ts`），覆盖上表「首付与回跳」的 Stripe 月付：从 `/pricing` 进入、托管结账页测试卡付款、回跳，并核对付款 `initial:succeeded`、唯一的订阅积分批次与订阅 active。托管结账页的操作封装在 `e2e-live/stripe-checkout.ts`，其他 Stripe 场景复用。

- 本地：在 Orca worktree 中执行 `pnpm --filter @product-res/web test:e2e:stripe`。需要根目录 `.env.local` 的测试凭据和已登录的 Stripe CLI，`STRIPE_WEBHOOK_SECRET` 与 `stripe listen --print-secret` 一致；只连接 worktree 隔离库。
- staging：设置 `STAGING_URL` 与 `STAGING_READONLY_DATABASE_URL`（必须是 `readonly` 账号）后执行同一命令。不启动本地服务和 `stripe listen`，回调由 Stripe 投递到 staging 登记的 webhook；用例只读核对数据库。

当前线上 Worker 已连接 Neon，使用同一受保护文件中的 readonly 直连配置执行 staging 用例；以后变更绑定时仍需核对线上 Worker 与只读查询指向同一目标库：

```sh
STAGING_URL=https://web-staging.product-res-jobs.workers.dev \
  STAGING_READONLY_DATABASE_URL="$NEON_READONLY_URL" \
  pnpm --filter @product-res/web test:e2e:stripe
```

**10.1 已通过（2026-10-09 07:4x UTC，staging `ce623ca`）**：上面的命令对 Neon staging 执行 1 passed（35.3 秒）——新用户从 `/pricing` 选 Stripe Pro 月付 → 托管结账页 4242 测试卡 → billing-return，readonly 核对付款 `initial:succeeded:1900`、唯一 `subscription:1000` 积分批次与 active 订阅。首次运行暴露两处 Stripe 页面差异并已在 `stripe-checkout.ts` 处理：已有 Customer 时邮箱只读（不再等待输入框），Link「保存信息」默认勾选时要求手机号（取消勾选）。

**1.3 已通过（同日）**：Codex 两轮 `billing:sync` 均退出 0、映射 ID 稳定、无新增；随后用 readonly 读取 staging `plan_price` 的 10 条映射，逐条经 Stripe `GET /v1/prices/:id` 与 PayPal `GET /v1/billing/plans/:id` 核对，金额、币种、周期与 active 状态全部一致。PayPal 积分包为一次性订单，没有远端 Plan，仅保留本地映射。

Stripe Checkout 首次返回 `BILLING_UNAVAILABLE`，Workbench 400 确认账户默认 Managed Payments 要求 product tax code。用户已批准每次创建 Checkout Session 显式设置 `managed_payments.enabled=false` 的两文件三行补正，已应用为提交 `ab9dc21274291a82a22da67aaa776c6a779dafef`；Stripe operations 回归由 RED（2 fail）转为 GREEN（20 passed）。根目录 `check`、`check:deps`、`check:singletons`、`typecheck`、`test`、`build` 六项均退出 0，日志为 `/tmp/cloud-staging-neon-managed-{check,check-deps,check-singletons,typecheck,test,build}.log`。

历史 Managed Payments 补正后约 2026-10-09 04:58 UTC 再次按 jobs → web 手动部署完整代码版本 `ab9dc21274291a82a22da67aaa776c6a779dafef`，jobs Worker version `172b231b-7ef3-43f0-b677-aafba97c282e`、web `1c4273f4-420e-453c-96e0-fe950447372c`。部署时间仅据脱敏部署日志/文件时间推断，不作为精确时间戳；`2026-10-09T04:59:01.440Z` 健康检查为 200、status ok、db.up、完整 SHA 匹配，`lastCronAt = 2026-10-09T04:55:31.328Z`；随后心跳推进至 `2026-10-09T05:00:53.721Z`。

已在明确的 Stripe Sandbox 中用官方 `4242` 测试卡购买一次 $10 积分包，空间 `u-4py7aicz` 的 UI 余额从 0 增至 1000。`checkout.session.completed` 事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2` 在 `2026-10-09T05:00:14.299Z` 验签处理成功，API 版本为 `2026-09-30.endive`、`status = processed`、`attempts = 1`；付款 `01a11f08-8359-71e9-813e-64beae2501f9` 关联 `pi_3UOVugL3UTpBAoXo0hPVnZJQ`，`one_time / succeeded / 1000 USD`（最小货币单位）。唯一积分批次 `01a11f08-83f6-750c-b841-c10649a02cdd` 为 `purchase`、`amount = remaining = 1000`，`source_ref` 与 `payment_id` 均匹配该付款。

已修复的重投诊断历史：Workbench 原始投递为 200，`05:00:46` 与 `05:01:03` UTC 两次手动投递均为 500；`05:03:19` UTC 的第三次重投在 live tail 中报 `billing.webhook_failed` / `Webhook delivery association mismatch`。当时 `assertAssociation` 比较完整 event payload，已存与重投的顶层 `pending_webhooks` 从 3 变为 1，导致关联检查失败；三次失败均未重复入账。用户已授权最小修复，提交 `433e737b517733553537cfdb7ed9bb9fad6dbe4e` 仅在 Stripe 已存事件与入站事件的关联比较中忽略顶层 `pending_webhooks`；当前投递原始字节的签名验证、业务 payload 及 PayPal 比较仍严格校验。真实 worktree PG 管线回归由 RED 转为 GREEN（10 passed）；根目录六项检查全部退出 0，`typecheck` 13/13、`test` 22/22（802 passed、2 个既有 skip，其中 billing 247 passed）、`build` 2/2。日志为 `/tmp/cloud-staging-neon-duplicate-{check,check-deps,check-singletons,typecheck,test,build}.log`。

历史去重补正后已按 jobs → web 手动部署完整代码 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`，jobs Worker version `e60c6ed2-0f59-4bf8-b245-98e018096bd6`、web `5bfb1235-9cf6-4558-9b88-802938dcfb05`。部署精确时间未留证；`2026-10-09T05:11:05.853Z` 健康观测为 200、status ok、db.up、完整 SHA 匹配，`jobs.lastCronAt` 从 `2026-10-09T05:00:53.721Z` 推进至 `2026-10-09T05:10:39.639Z`。该历史提交的 [CI run 37887162498](https://github.com/ustclhx/product-res/actions/runs/37887162498) 已全部通过，head SHA 为上述完整 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`；CI 通过不代替首次 main 自动发布验收。

修复部署后，使用受保护的测试 key 经 Stripe CLI 重投同一原始购买事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2`；Stripe Workbench 的 `2026-10-09T05:11:10Z` Manual retry 明确返回 200 OK。重投后 readonly 核对付款、积分批次、事件与初始快照完全 deepEqual：各一条，付款仍为 `one_time / succeeded / 1000 USD`（最小货币单位），唯一 `purchase` 批次 `amount = remaining = 1000` 且关联原付款，事件仍 `processed / attempts = 1 / processed_at = 2026-10-09T05:00:14.299Z`；UI 余额仍为 1000。小额测试积分包购买、同事件去重及 Cron 心跳三项均通过，Neon 任务 9.1 已完成，Neon change 最终为 28/29，仅24 小时观察（9.2）保持未完成。

验收汇总为 `/tmp/cloud-staging-neon-purchase-acceptance.json`，只读前后快照为 `/tmp/cloud-staging-neon-payment-before-resend.json`、`/tmp/cloud-staging-neon-payment-result.json`，CLI 重投提交记录为 `/tmp/cloud-staging-neon-stripe-resend-result.json`，当时健康记录为 `/tmp/cloud-staging-neon-final-health.json`。CLI 退出 0 仅证明提交成功；endpoint 200 由 Workbench 独立观测确认。以上证据仅含公开 ID 与测试数据。

本轮不是订阅首付、退款、PayPal 或完整业务回调录制验收，P2 剩余六项不因这笔积分包交易而提前勾选。

### 续费与时间约束

Stripe 当前官方把 Test Clocks 呈现为 **Simulations**。先由本应用 Checkout 建立订阅与本地关联，再在测试 Dashboard 选择该订阅 → Run simulation → Advance time，推进至下一账期并等 simulation 完成与真实签名回调。每次推进遵守官方最多两周期规则；若账号界面或客户不符合条件，记录原因，由 supervisor 安排支持的 clock customer/订阅测试方式并确保绑定真实 workspace/报价，不能把无关联的 Dashboard 订阅当本应用端到端成功。见 [Simulations](https://docs.stripe.com/billing/testing/test-clocks)、[模拟订阅步骤](https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions)。

Stripe 时钟只推进平台对象；应用的 `new Date()`、PG `now()`、jobs hourly/daily Cron 不随之推进。未来回调可能使 `last_event_at` 超前，随后真实时间生成的状态事件可能被视作旧事件：clock 场景用独立 workspace，不将其用于普通取消/恢复结果。平台年续费成功不等于应用年付第 2–12 月 Cron、批次过期或取消到期已完成。应用时间相关验收需等待真实到期，或由 supervisor 另行安排隔离库中可审计的受控时间验证，并明确标注为受控验证；不能改共享 staging 系统时间或伪造付款日期后宣称真实通过。

PayPal 当前代码只接受单个、无试用/无 setup fee、固定 USD 的 MONTH/YEAR 周期，拒绝 DAY 临时加速 Plan、改价方案及无法证明的历史周期。已核对的官方文档没有提供本实现可直接使用的 test-clock 等价操作；实际沙箱续费时机/加速能力须人类账号核对。没有支持的办法就保留月/年续费为待观测，不能把 simulator、手工入库或 `capture` 当订阅续费；11.1 保持未完成。[Subscriptions v1](https://developer.paypal.com/api/subscriptions/v1) 是核对账号可用操作的官方入口。

### 部分退款、重投与录制

1. 从可申请的 succeeded 付款提交退款；admin 批准一个小于付款额的正整数金额（货币最小单位），记录 `approved_amount` 和平台 refund ID。Stripe 对应 PaymentIntent，PayPal 一次性对应 Capture、订阅对应 Sale。保留真实退款响应和回调先后时间。
2. 等待验签成功且 refund ID / 金额匹配：`payment_refund` 新增一个身份，`payment.refunded_amount` 正确、状态 partially_refunded，匹配的申请变 refunded。任何部分退款也会收回该付款的**全部剩余积分**（年付包含已有各月批次，并停止该付款未来月份发放），不是按退款比例收回；已消费不追溯。PayPal 未知累计金额为 null 时按唯一退款 ID 累加，不假装为 0。
3. 同一付款可在平台再做第二笔部分退款，验证累计金额等于唯一已验证退款之和且不超付款额；不能用原申请重复审核发起第二退款。重投第一笔、第二笔事件后金额、revoke 流水不再增加。后台列表的“原始−剩余”还包含 hold/expire/revoke，不能当实际消费。
4. Stripe 在事件详情点 Resend；可由已登录测试 CLI 使用 `stripe events resend evt_实际事件ID --webhook-endpoint=we_实际endpointID`。PayPal 使用当前 sandbox App 的 Webhook Events 重投已有事件，入口不可用时由操作者按官方 resend 操作执行，不能改事件 ID 制造“重复”。平台重投与后台 failed 重放分别记录；后台只对可信已入库 failed 事件重放，不绕过外部验签。[Stripe 重投](https://docs.stripe.com/webhooks)、[PayPal Webhook 管理](https://developer.paypal.com/api/rest/webhooks/)。
5. 每次真实交易从平台事件详情/受控接收记录保存原始 body、必要签名 headers、平台对象响应、投递 HTTP 状态、账号模式/endpoint ID/API 版本及 SHA-256。现有 `webhook_event.payload` 是 JSONB，不能还原原始字节或 headers；它可作业务映射证据，不能单独作 HTTP 验签录制。无需为录制在 Worker 日志公开完整 payload。
6. 原始材料保存在访问受限的位置，脱敏夹具只保留稳定、相互对应的 ID / metadata / 时间 / 金额 / 链接形状，清除邮箱、地址、付款资料、Authorization、token 和 secrets。脱敏后旧签名失效：夹具验证映射，原始受限材料证明在线验签；过期 Stripe 签名不用于普通 HTTP 重放。后续获授权的实现任务才将真实夹具接入测试，此文档任务不写夹具或改测试。

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

## 7. 六项的完成门槛（1.3、10.1 已通过）

| Task | 完成标准 / 必须留下的证据 |
|---|---|
| 1.3（已通过） | 两平台真实 test/sandbox sync 两轮成功，10 个有效本地映射、远端对应金额/周期一致、重复执行无新增；说明 PayPal 积分包无远端 Plan。 |
| 3.2 | 当前锁定版本真实 Stripe 结账、门户、取消/恢复、退款及首付/续费/一次性回调录制；录制夹具映射测试通过，验签与 invoicePayments → PaymentIntent 关联有真实证据，版本差异已处理。 |
| 3.3 | 当前 sandbox App 的 Orders capture、Subscriptions、KV OAuth、远端验签、取消/恢复、Sale/Capture 退款真实成功；录制首付/续费/退款等夹具映射通过，Sale 历史/周期与弃用 API 可用性验证；实际事件差异回写 docs/05。 |
| 10.1（已通过） | 从 `/pricing` 经真实 Stripe 测试卡付款到 billing-return 的端到端记录/断言，数据库付款与唯一积分批次一致；现有 Playwright mock e2e 不抵充。 |
| 10.4 | 联通结论回写 docs/05，docs/08 的 Q4 默认不结转、Q5 升级不补发、Q6 已消费不追溯状态按实际证据更新；标明仍待项，不删除已确认的不确定性。 |
| 11.1 | staging 两平台月付/年付、真实续费、取消/恢复/到期、重叠期、积分包、申请/平台全额与部分退款、重复回调矩阵全部验收；无重复发放/负余额、对账成立，应用时间与平台 clock 验证区分明确，所有失败修复后重验。 |

3.2、3.3、10.4、11.1 在完整门槛核验前保持未完成；已有的同步和 Stripe Test 验签证据见 §3–4，不能据此宣布完整支付验收通过。本文件不勾选 tasks，后续 supervisor 按完整门槛结项。PayPal Sale API/历史形状、沙箱续费时间及应用到期验证方案仍须在联通过程中解决。Neon 注册冒烟（6.2）与版本探活（7.1）已通过，证据分别为 `/tmp/cloud-staging-neon-proxy-evidence.txt` 与 `/tmp/cloud-staging-neon-wrong-timed.log`。自动发布（7.4）已通过，文档与路线图最终结项（8.2）在本 PR 3 完成；24 小时观察（9.2）沿用 2026-10-09 03:38 UTC 切换基线，最早 2026-10-16 同时刻完成，保持未完成；小额测试积分包购买（9.1）已通过；jobs 已仅在 staging 开启日志、采样率 100%、traces 关闭并按 jobs → web 完成重部署。一小时支付日志（5.6）已通过：2026-10-09 03:39–04:39 UTC，48 条 scheduled 记录、13 条心跳、缺凭据告警 0 条；观察期不删除旧资源。

## 8. 代码核对索引

- `packages/billing/src/runtime.ts:22` `createTestPaymentRuntime`；`packages/billing/scripts/sync.ts:9` CLI 门槛；`packages/db/worktree-env.ts:7` `readLocalEnv`。
- `packages/billing/src/stripe/client.ts:4` `STRIPE_API_VERSION`；`stripe/adapter.ts:216` `verifyWebhook` 与版本检查；`stripe/operations.ts` `cancelStripeSubscription` / `resumeStripeSubscription` / `changeStripePlan`。
- `packages/billing/src/paypal/webhooks.ts:67` `payPalWebhookNormalizer`、`:252` `verifyPayPalWebhook`；`paypal/operations.ts:237` suspend/cancel、`:252` activate；`paypal/snapshots.ts:426` `classifyPayPalSale`、`:439` `salePeriod`。
- `packages/billing/src/catalog.ts:8` `EXAMPLE_CATALOG`、`:99` `seedCatalog`、`:134` `syncCatalog`；`services.ts:275` 取消、`:305` 恢复；`events.ts:532` `applyBillingEvent` 的退款身份/累计/收回逻辑。
- `apps/web/src/features/billing/webhook-http.ts:11` `handleBillingWebhook`；`apps/jobs/src/billing.ts:20` Cron 常量与 `runBillingSchedule`；`packages/billing/src/cron.ts:96` `runAnnualGrants`、`:244` `runSubscriptionReconciliation`、`:304` `runCreditReconciliation`。

## 9. PayPal 完整矩阵推进（2026-10-11）

用户要求继续完成完整场景。本轮复用 Stripe 已有证据，保留其 pending 管理员退款申请；PayPal 逐项记录实际结果，不用已实现的离线用例替代真实平台验收。

| 场景 | 本轮状态 |
|---|---|
| 积分包批准、capture、验签、唯一入账 | 已通过，订单 `2A672877DY6250409`，Capture `821243239P5069342`，余额 1,000 → 2,000，见 §1 |
| 同一付款完成事件两次重投 | 两次 resend 均 202；第二次实际接收 HTTP 200，原付款/批次/流水不变、余额仍 2,000。第一次监听目标错误，缺少 HTTP 结果；补做一次被自动审批拒绝，待用户授权。尚不计完整通过，见 [证据](evidence/p2-paypal/credit-pack-duplicate-2026-10-11.json) |
| Pro 月付首付 | 真实 $19 首付成功，Sale `7WT17462SJ5165744`，唯一 initial 付款/1,000 积分批次/流水，余额 2,000 → 3,000；付款周期与平台下次账单时间存在差异，待修复，见 §10 |
| 年付首付、首月发放 | 待独立工作区验收 |
| 取消/恢复、权益保留、旧事件迟到 | 当前月付取消/恢复及其回调已通过，权益保留且付款/积分不变；旧事件迟到与恢复后自然续费仍待验收，见 §10 |
| 换套餐重叠期、至多一条会续费 | 待独立工作区验收 |
| Capture/Sale 申请部分退款、平台全额退款、重复退款回调 | 已通过用户页面提交既有 $10 Capture 的退款申请，原因注明请求 $4 部分退款，状态 pending，未发生退款；当前 staging 无 admin，已请求临时授权，尚未更改角色。Sale 与平台全额退款仍待验收 |
| 月/年真实续费、恢复后续费 | 待真实周期到来或有官方支持的等价时间推进证据 |
| 真实夹具映射、每日对账、应用时间行为 | 待汇总当前录制与已批准的受控时间测试，不能把平台付款时间当应用时间 |

官方能力核查：当前 Subscriptions v1 文档没有可执行的 Sandbox test-clock 操作；`billing_info.next_billing_time` 为只读，PATCH 白名单不包含它。`start_time` 修改面向未来开始时间，不提供提前运行已开始订阅下一周期的保证；`capture` 仅收取已有 `OUTSTANDING_BALANCE`。因此不使用 DAY Plan、欠款 capture、模拟回调或手工写库冒充 MONTH/YEAR 续费。来源：[PATCH subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-patch)、[schema](https://developer.paypal.com/api/subscriptions/v1/schema.json)、[capture outstanding balance](https://developer.paypal.com/api/subscriptions/v1/subscriptions-capture)、[Sandbox 测试](https://developer.paypal.com/platforms/subscriptions/test-subscriptions/)。

安全复用的年付测试账户已只读确认有 credential、无付款/订阅且未封禁，workspace `u-99iringc`；其登录信息沿用既有 E2E fixture，不写入本记录。当前 owner 为普通用户，不因完整验收请求自动提升权限。

2026-10-11 07:18 UTC 补记：用户重新从默认 `stripe` 入口进入 `cs_test_` 结账，页面显示“沙盒”，未提交银行卡付款。切换 `paypal` 后发现 staging 已自动发布至 `6eca0f6`，PR #82 尚未合并，线上再次缺少 fetch 修复。基于该最新主线保留现有修复重新构建，170 个 billing 测试通过；按 jobs → web 恢复部署，jobs version `55567eec-0a5c-4312-95c5-b7581cced1e1`、web version `028d635e-1029-4308-bf5c-2216634e4cc4`。Health 为 `6eca0f6-paypal-fetch-fix` / ok / db up。浏览器已从 PayPal 入口成功跳转 `www.sandbox.paypal.com`，待批准 subscription `I-H2LE38AW7EU4`；买家会话过期，停在既有测试买家登录页，未批准订阅。Developer 后台因重定向真实 PayPal 登录域名被自动审批拒绝，未继续访问。此记录不算月付首付通过；后续主线发布仍可能覆盖未合并的修复。

## 10. PayPal 月付首付与取消/恢复（2026-10-11）

用户随后登录 Sandbox 并批准 subscription `I-H2LE38AW7EU4`。07:21:54–58 UTC 只读核验：远端 ACTIVE、首付 Sale `7WT17462SJ5165744` COMPLETED / USD 19；本地唯一 `initial/succeeded` 付款、唯一 subscription 积分批次及 +1,000 流水，余额 3,000，held/debt 均 0。ACTIVATED 与 SALE 回调均 processed；ACTIVATED 经两次处理后成功，不能声称未出现重试。

通过账单 UI 周期末取消后，远端 SUSPENDED、本地 canceled / cancel_at_period_end=true；SUSPENDED 回调处理完成后仍保留 Pro 权益、已付周期与余额。随后 UI 恢复，远端 ACTIVE、本地 active / false，恢复 ACTIVATED 回调 processed。三个阶段的 payments、grants、ledger 逐字段一致，对账差额均为 0。订阅最终保持 ACTIVE，下一账单时间 `2026-11-11T10:00:00Z`；尚未验收到期终止、自然续费或旧事件迟到。

脱敏证据：[首付](evidence/p2-paypal/monthly-initial-2026-10-11.json)、[取消回调处理后](evidence/p2-paypal/monthly-canceled-settled-2026-10-11.json)、[恢复](evidence/p2-paypal/monthly-resumed-2026-10-11.json)。

发现两项缺陷，完整验收仍不通过：

1. 订阅回跳携带 subscription_id 与 token，页面错误显示 Orders capture 的 Confirm payment。未点击该按钮，直接返回账单；成功状态以平台与入账证据为准。
2. 不可变 payment 首付周期按 `start_time` 推算为 `2026-10-11T07:17:44Z → 2026-11-11T07:17:44Z`，积分到期为 `2026-11-12T07:17:44Z`；最新 subscription 使用实际 last_payment / next_billing_time，为 `07:20:36Z → 11/11 10:00Z`。月付宽限相对实际下一账单时间少 2 小时 42 分 16 秒。修复须保证历史 Sale 重放的周期身份稳定；不能直接用当前 next_billing_time 覆盖所有历史付款，也未改写本次付款/积分记录。

回跳 UI 已修复：接收 subscription_id，并统一处理路由解析后的 boolean/string canceled 参数，避免取消返回抛 schema 错误。类型检查、构建、Biome、Playwright 用例发现通过；新增本地浏览器用例未执行（worktree 无隔离测试库），改由 staging Computer Use 实测三种 URL：订阅无 capture 按钮、订单按钮可用、取消正常提示且无按钮，均通过，未点击 capture。修复已纳入 PR #82 分支提交 `c932b15`。当前 web-staging version `f4f5be8e-40a9-4543-89c7-48e6e234877c`；周期边界缺陷仍未解决，tasks 不勾选。

周期缺陷修复后续：PR #82 提交 `0f5e9c4` 已改为新 Sale 使用实际 next_billing_time、续费起点沿用前笔已记录 period_end、历史 Sale 复用不可变付款或补偿收据。真实时间回归先失败后通过；270 个计费测试（含隔离 PostgreSQL）、全工作区类型检查、web 构建、jobs dry-run、格式和依赖检查通过。业务链路夹具确认账期末 `11/11 10:00 UTC` 对应积分失效 `11/12 10:00 UTC`，续费后重放不重复入账。此代码尚未部署；本次真实沙箱旧付款与积分仍保留原值，没有用重写历史记录掩盖缺陷，也未把本地续费夹具当成自然续费验收。tasks 继续保留未完成。

2026-10-12（Asia/Taipei）人工卡点更新：用户明确授权后，将 staging 测试用户 `01a11ec0-006f-76ef-803e-cd77d1e5f68a`（`neon-credit-pack-1791517145750@example.com`）从平台 `user` 提升为 `admin`。事务内同时核对用户 ID、邮箱、未封禁和对应空间 owner 身份，并追加 `admin.user.bootstrap` 审计 `01a12bfc-2c56-7444-a5ad-6696ed759953`。当前会话实际打开 `/admin/billing/refunds` 成功，Stripe 与 PayPal 两笔退款申请仍为 pending，未审批、未调用退款。Cloudflare Workers Plans 同时实测付费栏显示「当前套餐」（US$5/月 + 用量），原免费套餐 10ms CPU 决策卡点解除；不据此提前认定所有业务场景已验收。
