# P2 Stripe：受控应用时间验证

## 证据性质与环境

2026-10-09 在 `p2-stripe` worktree 执行既有测试，执行区间为 **11:07:07–11:07:14 UTC**。测试时 checkout 为 `dad4833846025a004310e3633ee6eee3eb32003b`，已基于 `origin/main` 的 `a978a4d6e2ed0cbc041f376c5591ce033cf929ae` 完成 rebase。

本证据按协调者授权，与另行保存的真实 Stripe 续费回调证据配合验收年付第 2–12 月发放、取消到期与积分批次过期。这里的付款事件是测试构造的 `NormalizedEvent`，Provider 查询/验签为测试替身；测试使用真实本地 PostgreSQL 执行业务事务，并注入应用层 `now` 或调整测试夹具日期。这里没有推进 staging 应用时钟、数据库时钟或真实 Cloudflare Cron，也没有调用 Stripe API。

运行前只读取 `.env.worktree` 核对数据库配置：app 与 migrator 均指向 **localhost:5432 / product_res_wt_p2_stripe**。未读取或 source staging 凭据，未连接或直接修改 staging 数据库。测试进程移除继承的数据库 URL 变量，让既有 Vitest 配置读取 `.env.worktree`；同时移除五项支付凭据变量。连接串、密码和密钥均不写入本证据或测试结果输出。

本地配置读取见 `packages/db/worktree-env.ts:7`；billing/credits 的配对隔离库检查见 `packages/billing/vitest.config.ts:5`、`packages/credits/vitest.config.ts:5`。既有 `packages/db/test/global-setup.ts:11` 使用本地 migrator 应用迁移，测试按自身清理逻辑删除夹具或回滚事务。没有新增测试或修改业务源码。

## 执行命令与结果

下列为实际 CLI 参数；命令由 Node `spawnSync` 按表中工作目录串行执行，`<temporary-file>` 为每组独立的临时 JSON 报告路径。原始测试 stdout/stderr 仅保存到临时目录，对外只输出通过数和 case 名称/状态。

| 工作目录 | 命令 | 通过 | 失败 / 跳过 |
|---|---|---:|---:|
| `packages/billing` | `pnpm exec vitest run src/events.postgres.test.ts src/cron.postgres.test.ts --project=postgres --reporter=json --outputFile=<temporary-file>` | 35（events 24、cron 11） | 0 / 0 |
| `packages/credits` | `pnpm exec vitest run test/lifecycle.test.ts test/credits.test.ts --reporter=json --outputFile=<temporary-file>` | 46（lifecycle 10、credits 36） | 0 / 0 |
| `packages/entitlements` | `pnpm exec vitest run src/selection.test.ts test/workspace-seats.test.ts --reporter=json --outputFile=<temporary-file>` | 11（selection 9、workspace-seats 2） | 0 / 0 |
| `apps/jobs` | `pnpm exec vitest run test/billing.unit.test.ts --config=vitest.unit.config.ts --reporter=json --outputFile=<temporary-file>` | 9 | 0 / 0 |

四个进程退出码均为 0，合计 **101 passed / 0 failed / 0 skipped**。其中 **83 个为本地 PostgreSQL 测试**（billing 35、credits 46、workspace-seats 2）；selection 与 jobs 共 18 个为 unit 测试。这个总数包括上述文件中的其他既有业务用例，不能解读为 101 个独立时间场景。

传给测试子进程的环境从 `process.env` 复制后删除以下变量，以阻止继承环境覆盖本地配置或携带支付凭据：

```text
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED
MIGRATION_DATABASE_URL
BILLING_TEST_DATABASE_URL
CREDITS_TEST_DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_WEBHOOK_ID
```

## 年付第 2–12 月与续费

| 既有 case 与位置 | 受控输入 | 已验证的重要断言 |
|---|---|---|
| `yearly batches preserve anchor and payment provenance; refund revokes all remaining including held release`，`packages/billing/src/events.postgres.test.ts:461` | 构造年付成功事件，付款周期 `2030-01-31T12:00:00Z` 至 `2031-01-31T12:00:00Z`；首付应用时间固定为周期起点。随后 n=1..11 逐次调用真实 `grantSubscriptionMonth`，将 `now` 注入为原 UTC 锚点对应的月份。 | 首月过期为 `2030-03-01T12:00:00Z`（2 月 28 日周期末加 24 小时宽限）；第二月尚未到期时拒绝发放；逐月发放后恰有 12 批，全部关联原 `payment.id`。同一 case 的模拟退款还验证所有批次剩余积分收回、预扣释放不恢复余额，累计 revoke 为 -118。 |
| `uses historical annual price and retained cancellation; expires late months and repeats without extra ledger`，`packages/billing/src/cron.postgres.test.ts:147` | 夹具付款周期从应用 `now` 前两月起算；将当前订阅价格改为月付、历史年付价格设为 inactive，并保留周期末取消状态；向 `runAnnualGrants` 注入 `now`。 | 按历史付款价格生成 `payment.id:0..2` 三批；一批已过期；n=1 的原始失效时间为下一锚点加 24 小时。并发重复执行后批次与流水完全不变，积分对账无该空间失败。 |
| `uses the injected cron clock for retrospective expiration, independent of the database clock`，`packages/billing/src/cron.postgres.test.ts:177` | 本地数据库时钟保持实际日期；测试付款周期设为 2030 年，向 `runAnnualGrants` 注入 `2030-04-02T12:00:00Z`。 | 补发三批，前两批立即 expired，仅当前月 10 积分可用。证明追溯过期使用注入的应用时钟，不依赖 PostgreSQL 当前时钟追到 2030 年。 |
| `verified renewal ahead of application time records payment and grants its first month once`，`packages/billing/src/events.postgres.test.ts:302` | 应用 `now` 固定为 `2030-01-31`；模拟已验证续费付款周期为 `2030-02-28` 至 `2030-03-31`，经真实 `processWebhook` 和事件处理事务入库。验签替身返回该事件。 | 首次投递 processed，同投递重放 duplicate，另一投递携带同一付款也 processed；总计两笔付款、两批积分，续费仅一批 `renewalPayment.id:0`，amount/remaining 均为 10，过期为 `2030-04-01T12:00:00Z`；订阅已付周期更新为续费周期。该 case 验证的是应用时间落后于已验证付款时仍可入账，不能充当真实验签证据。 |

全年 12 批直接执行的是 Webhook/Cron 共用原语；真实 Cron 服务函数的注入时间、补发、过期与并发幂等由独立 PostgreSQL case 验证。实现连接点可核查 `packages/billing/src/events/grants.ts:24`、`packages/billing/src/cron.ts:148`、`packages/billing/src/cron.ts:162`。这是跨 case 的覆盖组合，不是完整 Worker 全年调度实测。

## 取消与到期权益

| 既有 case 与位置 | 已验证的重要断言 |
|---|---|
| `scheduled annual cancellation keeps prepaid monthly grants until termination`，`packages/billing/src/events.postgres.test.ts:518` | 订阅 `status=canceled` 且 `cancelAtPeriodEnd=true` 时，第 2 月继续发放，总计两批；随后取消保留标志置 false，第 3 月原语调用拒绝并报 `no longer eligible`。这是本地状态夹具，不是向 Stripe 发起取消。 |
| `stops grants for terminated or paused %s`，`packages/billing/src/cron.postgres.test.ts:194` | paused、expired、canceled 三种终止/暂停状态在无保留标志时，经真实 `runAnnualGrants` 均不生成任何批次。 |
| `does not grant a future or refunded paid period`，`packages/billing/src/cron.postgres.test.ts:205` | 付款周期尚未开始时不发放；付款变为 partially_refunded 后也不发放。 |
| `getEntitlements scopes paid subscriptions and rereads time within a transaction`，`packages/entitlements/test/workspace-seats.test.ts:47` | 真实 PostgreSQL 事务中写入已取消且周期末为 `now+1 天` 的订阅：按初始注入时间读取 maxSeats=5，其他空间为 free；同事务再次注入 `now+2 天` 后读取回落 free，无需 Cron 改写订阅状态。 |
| `keeps canceled until the period ends` / `keeps expired until the period ends`，`packages/entitlements/src/selection.test.ts:54` | unit 测试：周期末之前保留 pro；`currentPeriodEnd` 恰等于注入 `now` 时回落 free，补充到期边界的等号条件。 |

`packages/billing/src/cron.postgres.test.ts:286` 的 `remote reconciliation runs outside transactions, preserves PayPal cancel intent and creates no payments` 还验证了注入时间越过本地已付周期后调用 Provider 取消替身，以及对账不生成付款/积分。该 case 是 PayPal 夹具，不能归为 Stripe 真实平台取消证据。

## 积分批次过期与账本一致性

| 既有 case 与位置 | 已验证的重要断言 |
|---|---|
| `expiration leaves held allocation for later release without restoring balance`，`packages/billing/src/cron.postgres.test.ts:219` | 本地 10 积分批次预扣 4，将夹具过期时间设为注入 `now-1 秒`；真实 `runCreditExpiration` 重跑不增加流水；释放预扣后 available=0、held=0，积分对账无该空间失败。 |
| `expires zero-remaining grants and appends only unreserved loss once`，`packages/credits/test/lifecycle.test.ts:181` | 8 积分全部预扣，另有 5 未预扣；夹具 `expiresAt` 设为 epoch，让实际数据库时钟判断为已过期。首次过期返回 grants=2/canceled=5，重跑返回 0/0；两批均 expired/remaining=0。释放预扣后余额仍为零，expire 流水为 -5 和 -8，对账始终一致。这里控制的是夹具日期，没有注入 credits 的数据库 `now()`。 |
| `serializes expiry against capture/release with no resurrection or duplicate loss`，`packages/credits/test/lifecycle.test.ts:250` | epoch 过期夹具下，并发运行过期与 capture/release：再次过期不重复损失，available/held/debt 均为零，账本对账一致。两个参数化 case 均通过。 |
| `settles expired reservations with actual %s before expiry cron without resurrection`，`packages/credits/test/credits.test.ts:439` | epoch 过期夹具下，无需先运行 Cron，release 或 capture（实际量 0/3/8）直接使批次 expired/remaining=0；expire 总额为未消费部分，consume 流水为实际消费量；新预扣被拒绝且对账一致。四个参数化 case 均通过。 |
| `two holds touching an expired grant cancel its unreserved remainder exactly once`，`packages/credits/test/credits.test.ts:466` | 两个预扣交替释放/结算到已过期批次，expire 流水分别为 -4/-3/-1，逐步对账一致。 |

## Jobs 调度连接与未覆盖范围

`apps/jobs/test/billing.unit.test.ts:111` 的 `routes hourly, ten-minute and daily jobs and propagates service failures without secrets` 验证 hourly 调用过期和年付服务、daily 调用订阅对账/积分对账/退款联系方式清理，以及服务失败汇总；`:177` 的 `preserves P1 dispatcher schedules and routes both billing queues` 验证 Worker dispatcher 将 hourly 触发器路由到年付服务，并保留原有调度与两种 events 队列。

这两个 Jobs case 使用 mock，未注入未来时钟，也未连接 PostgreSQL。实际受控 `now` 的计费任务 PostgreSQL 测试位于 **packages/billing/src/cron.postgres.test.ts**，不在 apps/jobs。生产连接点见 `apps/jobs/src/billing.ts:137`：hourly 在一次调用内取应用当前时间并传给过期和年付服务（`:166`、`:170`）；daily 调用对账服务（`:182`）。源代码连接属于核查事实，不能扩写为真实 Cron 已运行。

已验证事实：上述既有测试全部通过；全年 12 批共用原语、本地 Cron 服务补发与追溯过期、取消前后权益读取和积分过期账本行为有实际 PostgreSQL 断言。

覆盖组合的推断：结合另行验收的真实 Stripe 付款/续费回调，可以把平台入账证据与这里的应用时间业务验证关联，但这里不能单独证明平台回调、真实平台取消或 staging Cron 调度成功。

未覆盖：没有将同一真实 Stripe 年付订阅在 staging 逐月推进第 2–12 月；没有全年 11 次 Worker→Cron→PostgreSQL 端到端调度 case；既有 `runAnnualGrants` case 直接断言到第 3 批，全年 12 批由共用原语 case 覆盖；本次没有执行 Stripe 真实取消/退款或真实到期。以上限制保留在证据中，不据此宣称 staging 时间或 Cron 已推进。
