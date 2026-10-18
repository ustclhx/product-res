# 05 · 计费：支付、订阅、积分、权益

## 1. 商业模型

- **订阅套餐**（`plan.type='subscription'`）：按月/年付费，**每月**发放一批积分（年付也按月发放，见 §4「年付按月发放」），并解锁一组权益（可用模型、并发数、席位等）。
- **积分包**（`plan.type='credit_pack'`）：一次性购买，发放一批有效期较长的积分，不改变权益（或只附加少量权益）。
- **免费档**：`plan.key='free'`，无需支付记录；注册赠送积分 `signupBonusCredits`（用户领取时触发邮箱验证，验证完成后才发放，见 §4「注册赠送防刷」）。
- 币种：模板默认单币种（`billing.currency`），多币种作为后续扩展（`plan_price` 已按 currency 建模）。

## 2. 支付 Provider 抽象

```ts
// packages/billing/src/provider.ts
export interface PaymentProvider {
  id: 'stripe' | 'paypal' | 'creem' | 'paddle' | 'polar'
  capabilities: {
    portal: boolean          // 平台是否自带客户自助门户
    changePlan: boolean      // 是否支持订阅内升降级
    refundsViaApi: boolean
    merchantOfRecord: boolean
  }
  createCheckout(input: {
    workspaceId: string
    userId: string
    price: PlanPrice          // 内部价格，含 provider_price_id
    mode: 'subscription' | 'one_time'
    successUrl: string
    cancelUrl: string
    customerEmail: string
  }): Promise<{ url: string; providerRef: string }>

  /** 一次性付款在用户返回后需要显式确认的平台（PayPal capture） */
  confirmCheckout?(providerRef: string): Promise<void>

  /** 返回该次投递的平台事件 ID（去重键）及拆分出的内部事件；一次投递可拆出多个内部事件 */
  verifyWebhook(req: Request, rawBody: string): Promise<{ providerEventId: string; events: NormalizedEvent[] }>
  cancelSubscription(subId: string, opts: { atPeriodEnd: boolean }): Promise<void>
  resumeSubscription?(subId: string): Promise<void>
  changePlan?(subId: string, newPrice: PlanPrice): Promise<void>
  getPortalUrl?(customerId: string, returnUrl: string): Promise<string>
  refund?(paymentId: string, amount?: number): Promise<void>
}
```

### 内部统一事件

```ts
type NormalizedEvent =
  | { type: 'checkout.completed'; ... }          // 用于关联 workspace 与平台客户/订阅
  | { type: 'subscription.activated'; ... }
  | { type: 'subscription.updated'; ... }        // 升降级、cancel_at_period_end 变化
  | { type: 'subscription.renewed'; paymentId; periodStart; periodEnd; ... }
  | { type: 'subscription.past_due'; ... }
  | { type: 'subscription.canceled'; ... }       // 进入终止状态
  | { type: 'payment.succeeded'; kind: 'one_time' | 'initial' | 'renewal' | 'adjustment'; ... }
  | { type: 'payment.refunded'; ... }
  | { type: 'payment.disputed'; ... }
```

每个事件都携带 `provider`、`occurredAt`，以及用于定位本地记录的**平台对象 ID**（`providerSubscriptionId` / `providerOrderId` / `providerPaymentId` 等）。

**Workspace 的解析规则**：
- metadata / `custom_id` 中的 `workspaceId` **只在首次关联时使用**（`checkout.completed`、订阅首次出现），用于建立 `billing_customer` / `subscription` / `purchase` 记录。
- 之后的所有事件（续费、退款、争议、状态变更）一律通过平台对象 ID 查本地表得到 `workspaceId`，不依赖事件里是否带 metadata（PayPal 的续费 `PAYMENT.SALE.COMPLETED` 只保证带 `billing_agreement_id`）。
- 查不到本地记录时：先通过 API 拉取该对象，用其 metadata / `custom_id` 补建；仍无法关联则标记 `webhook_event.status='failed'` 并告警，不静默丢弃。

### 平台事件映射与验证状态

| 内部事件 | Stripe | PayPal |
|---|---|---|
| checkout.completed（仅关联，不发积分） | `checkout.session.completed` | `CHECKOUT.ORDER.APPROVED` / `BILLING.SUBSCRIPTION.ACTIVATED` |
| subscription.activated | `customer.subscription.created`（status=active/trialing） | `BILLING.SUBSCRIPTION.ACTIVATED` |
| subscription.updated | `customer.subscription.updated` | `BILLING.SUBSCRIPTION.UPDATED` |
| payment.succeeded(initial) | `invoice.paid`（billing_reason=`subscription_create`） | 订阅的首笔 `PAYMENT.SALE.COMPLETED` |
| subscription.renewed / payment.succeeded(renewal) | `invoice.paid`（billing_reason=`subscription_cycle`） | 后续 `PAYMENT.SALE.COMPLETED`（带 billing_agreement_id） |
| subscription.past_due | `invoice.payment_failed` | `BILLING.SUBSCRIPTION.PAYMENT.FAILED` / `SUSPENDED` |
| subscription.canceled | `customer.subscription.deleted` | `BILLING.SUBSCRIPTION.CANCELLED` / `EXPIRED` |
| payment.succeeded(one_time) | `checkout.session.completed`（mode=payment, paid） | `PAYMENT.CAPTURE.COMPLETED` |
| payment.refunded | `charge.refunded` | `PAYMENT.CAPTURE.REFUNDED` / `PAYMENT.SALE.REFUNDED` |
| payment.disputed | `charge.dispute.created` | `CUSTOMER.DISPUTE.CREATED` |

> Stripe 的真实录制见 `packages/billing/src/stripe/fixtures/recorded`。PayPal 已提交此前 8 条及 2026-10-18 新增 4 条真实 Sandbox 回调（Sale 月付/年付首付、部分/全额退款）；自然续费、争议和其他终态事件尚无真实录制，不能视为这些场景已通过。

**订阅积分只由「付款成功」事件发放**：首付与续费都走 `payment.succeeded(initial|renewal)`，`checkout.session.completed` 只负责关联 workspace 与平台客户/订阅，从而避免首付被发两次积分。Stripe 中 `billing_reason=subscription_update`（升级按比例补差价）记为 `payment.kind='adjustment'`，关联原订阅并保留实际付款和退款记录，不发积分；只有 `initial` / `renewal` 付款发放订阅积分，见 §6。

**`payment.provider_payment_id` 的取值**（退款/争议事件靠它找回原付款）：

| 平台 | 取值 | 退款/争议事件中的对应字段 |
|---|---|---|
| Stripe | PaymentIntent ID（`pi_...`） | `charge.payment_intent`、`dispute.payment_intent` |
| PayPal 一次性 | Capture ID | `PAYMENT.CAPTURE.REFUNDED` 中 links 指向的 capture |
| PayPal 订阅 | Sale ID | `PAYMENT.SALE.REFUNDED` 的 `sale_id` |

> Stripe SDK 23.0.0 锁定 API `2026-09-30.endive`；真实 invoicePayments / PaymentIntent 录制和映射已通过 billing 3.2，见 `packages/billing/src/stripe/recorded.test.ts`。

### Stripe 实现要点
- SDK 初始化使用 `httpClient: Stripe.createFetchHttpClient()`；验签使用 `constructEventAsync`（Web Crypto）。
- Checkout Session 的 `metadata` / `subscription_data.metadata` 写入 `workspaceId`、`planPriceId`。
- 自助管理直接用 Customer Portal（`getPortalUrl`）。
- 税务：暂不启用 Stripe Tax；接入 MoR 时由 MoR 处理。
- **限制**：正式收款需要 Stripe 支持地区的主体；无主体阶段仅用测试模式开发与联调。

2026-10-18（Asia/Taipei）补充：按协调者指示，使用已登录 Sandbox CLI 的 Test Clocks，复用已有应用 Checkout 的月付/年付独立订阅，在 staging `a2381f875fbd8b1009e48f7024addcb25285aca9` 各推进一个平台账期。两笔 `invoice.paid` 在 endpoint 中实际为 `2026-09-30.endive`、`livemode=false`，分别入账 renewal / 1900 与 19000（USD 最小单位），各只新增首月 1000 积分；各两次重投的 staging HTTP 200、duplicate 事件 ID 与前后账务快照一致，两个空间同快照对账差额均为 0。证据见 [W3 沙箱验收](runbooks/evidence/staging-acceptance/2026-10-17/README.md)。平台时钟推进不代表应用时间、年付后续月份 Cron 或自然到期已发生；真实主体与 live 收款验收移交派生项目，沿用 §8 清单。

### PayPal 实现要点
- 直接使用 REST（`fetch`），自封装：OAuth token（缓存到 KV，按 `expires_in` 过期）、Orders v2、Subscriptions v1、Webhook 验签。
- 一次性付款：`POST /v2/checkout/orders`（intent=CAPTURE，`custom_id`=workspaceId）→ 用户批准后回到 `successUrl` → 服务端 `capture`（`confirmCheckout`）→ 以 `PAYMENT.CAPTURE.COMPLETED` Webhook 作为最终入账依据（capture 接口与 webhook 谁先到都要幂等）。
- 订阅：预先在 PayPal 创建 Product + Plan（脚本 `pnpm billing:sync` 从 `plan` 表同步），`POST /v1/billing/subscriptions`（`custom_id`=workspaceId）。
- Sale 周期：新付款必须匹配当前 `last_payment`，结束时间取实际 `next_billing_time`，不能用 `start_time + 月数` 推算。首付从 `start_time` 开始，续费从紧邻上一笔已入账付款的 `period_end` 开始。已入账 Sale 重放或退款核验复用原付款的不可变周期；竞争订阅尚未入账时可复用补偿任务保存的收据。缺少历史证据时明确失败，不用当前订阅快照猜测旧账期。HTTP、后台重放、退款与 jobs 入口使用同一数据库查询器。
- 2026-10-11 沙箱首付发现账期推算偏差：订阅开始 `07:17:44 UTC`，实际下次扣款为次月 `10:00 UTC`；旧算法让月度积分宽限少 `2h42m16s`。修复不重写已有付款或积分记录；新收据按实际周期计算完整宽限。离线 API 夹具与隔离 PostgreSQL 联合回归覆盖首付、续费、重放及实际账期末加 24 小时，不能替代自然续费的沙箱验收。
- 验签：调用 `POST /v1/notifications/verify-webhook-signature`（需 `webhook_id`），失败即拒绝。
- 无客户门户：账单页周期末取消调用 `suspend`，恢复调用 `activate`；立即取消调用 `cancel`。Subscriptions v1 没有本实现使用的远端周期末取消字段，因此本地保留已付权益至周期末，SUSPENDED 回调不能覆盖本地取消意图；终止后的订阅不能恢复。首版 `capabilities.changePlan=false`，换套餐使用「取消后重新订阅」，重叠处理见 §6。

### PayPal Sandbox 实测与录制（2026-10-15，Asia/Taipei）

复用当前 Sandbox App 的 2026-10-11 真实交易，在 2026-10-14 UTC 将既有 webhook URL 临时改为自建本地接收器的 Cloudflare quick tunnel，并通过 Webhooks Management API 重投 6 条既有事件。随后按协调者指示，使用 [PayPal 官方 Sandbox 测试卡](https://developer.paypal.com/sandbox-testing/card-testing) 与 Orders v2 `payment_source.card` 创建独立 USD 0.01 订单，创建接口直接返回 COMPLETED 与 Capture；全额退款也为 COMPLETED，再录制这笔交易的两条回调。既有 staging Capture / Sale 和待审退款均未改动。8 条回调全部收到原始 body 与 transmission headers，回传 `/v1/notifications/verify-webhook-signature` 得到 `SUCCESS`，接收器返回 200。两轮录制后均已恢复原 staging URL 与原 12 项事件订阅，并停止接收器和 quick tunnel；未修改命名 tunnel、staging secrets 或部署。本次接收器只录制和验签，不写应用账务，不能代替 staging 11.1。

脱敏夹具与逐项原文 SHA-256、接收时间、API GET 记录见 [`provenance.json`](../packages/billing/src/paypal/fixtures/recorded/provenance.json)。原始字节与签名仅保留在受限本地目录，提交夹具删除个人资料和签名，统一替换 payer / checkout UUID；脱敏正文只验证映射，不能重新验证原签名。

| 实际事件 | 录制结论 |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | 订单批准只关联空间，不确认付款或发积分；Orders capture 仍由返回页的服务端动作执行。 |
| `PAYMENT.CAPTURE.COMPLETED`（两条） | 既有 USD 10.00 付款的 Capture / Order GET 关联一致；独立 USD 0.01 订单快速退款后，完成事件的正文已为 REFUNDED。Mapper 接受完成后的已退款状态，并以 GET 快照保留 refunded / 实际退款金额，不把迟到完成事件当作重新付款。 |
| `PAYMENT.CAPTURE.REFUNDED` | 独立 USD 0.01 全额退款；`resource.id` 是 Refund ID，唯一 `rel=up` 指向原 Capture，GET Refund 的累计退款为 USD 0.01；真实字段符合现有退款映射。 |
| `BILLING.SUBSCRIPTION.ACTIVATED`（首付、恢复各一条） | 两次均发出同名 ACTIVATED；只关联并更新订阅，不把恢复视为新付款。 |
| `PAYMENT.SALE.COMPLETED` | Subscriptions v1 首付实际使用 Sale（不是 Capture），USD 19.00，`billing_agreement_id` 关联订阅；Sale GET 和交易历史均可读。交易金额使用 `total/currency`，Capture 使用 `value/currency_code`。 |
| `BILLING.SUBSCRIPTION.SUSPENDED` | 周期末取消实际发出 SUSPENDED（不是 CANCELLED）；Provider 映射 paused，业务层根据本地 `cancel_at_period_end=true` 保留 canceled 与已付权益。 |

首笔 Sale 的真实付款时间为 `2026-10-11T07:20:36Z`，订阅 `start_time=2026-10-11T07:17:44Z`，实际下一扣款为 `2026-11-11T10:00:00Z`；付款周期取 `start_time → next_billing_time`，不按付款时刻加一个月推算。历史 Sale 重放复用已保存的不可变账期，新续费必须有前笔收据与真实扣款证据。独立测试卡探针不关联应用空间，不用于 staging 账务验收；取消/恢复的操作证据来自 [此前沙箱实测](./runbooks/p2-payment-integration.md#10-paypal-月付首付与取消恢复2026-10-11)。

### PayPal 补充实测（2026-10-18，Asia/Taipei）

通过应用 Checkout 新建 Pro 月付 USD 19.00（`I-PE4VWXLXB1XP`）和 Team 年付 USD 490.00（`I-TKG3FMFU9BEN`）。两笔首付均为 `PAYMENT.SALE.COMPLETED`，各关联唯一付款与首月积分批次（1000 / 5000），年付未一次发放全年积分。首付周期分别为 `2026-10-18T06:06:16Z → 2026-11-18T10:00:00Z` 与 `2026-10-18T06:09:14Z → 2027-10-18T10:00:00Z`，仍以真实 `start_time / next_billing_time` 为边界，不能从扣款时间推算。

月付经应用取消后远端 SUSPENDED、本地 canceled / cancel_at_period_end=true，已付权益保留；恢复后远端 ACTIVE，账务未变。应用换套餐流程先取消旧月付续费，再由买家批准年付，重叠期有效权益为 Team，只有年付继续续费。随后也取消新年付续费，两笔均为 SUSPENDED，避免后续测试扣款。

仅退款本轮新建付款：月付 Sale `71D187337X5761003` 部分退款 USD 4.00，Refund `95R03124HK508535V`；年付 Sale `5ST08785RL1551152` 全额退款 USD 490.00，Refund `6JW466111B6808810`。两次 POST Refund 返回 201/completed，GET Refund 返回 200/completed。真实 `PAYMENT.SALE.REFUNDED` 的 `resource.id` 是 Refund ID，`sale_id` 才是原 Sale；金额为 `amount.total/currency`，状态小写 `completed`。本次 v1 响应另有顶层 `total_refunded_amount.value/currency`，不能套用 v2 的 `seller_payable_breakdown` 累计 Capture 语义；现有映射保留 `refundedAmount=null`，由账务按唯一退款 ID 累加。

月付退款后按比例保留 `floor(1000 × 1500 / 1900)=789` 积分，回收 211；年付全额退款回收其 5000。余额从原 90 经首付变为 6090，再为 5879、879；各阶段无负批次、重复付款或重复积分来源，对账差额为 0。既有验收付款、订阅与待审退款未变。

四条新增录制及十份 GET 快照位于 `packages/billing/src/paypal/fixtures/recorded/w3-*.json`；原始回调先在线验签 SUCCESS，再脱敏，离线 recorded 测试验证月付/年付历史分类、不可变账期和部分/全额退款关联。使用额外临时 webhook 经自建接收器 + Docker quick tunnel 录制，原 staging webhook 未改动；清理与重复回调结果见 [W3 补充验收证据](runbooks/evidence/staging-acceptance/2026-10-18/README.md)。

**移交派生项目**：按 2026-10-18 用户决定，PayPal 自然月/年续费（含恢复后续费）、取消到期终止及年付第 2–12 月真实 Cron 观察按实际账期执行。既有订阅下一扣款为 `2026-11-11T10:00:00Z`；不能用模拟器、DAY Plan、欠款 capture 或隔离库时间夹具替代。Capture 部分退款、争议及其他未录制终态不在本次四项任务已通过证据内。OAuth KV 缓存仍有离线测试，本次不证明线上 KV 命中。

### 未来 MoR
Creem / Paddle / Polar 各实现一个 Provider，`capabilities.merchantOfRecord=true`；结账、Webhook、门户均映射到同一套内部事件，业务层无需改动。

## 3. Webhook 处理流程

去重粒度是**一次平台投递**（`providerEventId`），不是拆分后的内部事件；同一投递拆出的多个内部事件在同一事务内一起处理。

```
1. 读取 raw body（验签必须用原文）
2. provider.verifyWebhook() → { providerEventId, events }；验签失败返回 400
3. 事务 A（登记，独立提交）:
     INSERT webhook_event (provider, provider_event_id, payload, status='received')
       ON CONFLICT (provider, provider_event_id) DO NOTHING
   若已存在且 status IN ('processed','ignored') → 返回 200
4. 事务 B（处理）:
     BEGIN
       SELECT ... FROM webhook_event WHERE id=? FOR UPDATE      -- 串行化同一事件的并发重投
       若 status 已为 processed → COMMIT，返回 200
       for event of events: applyEvent(event)  // 更新 subscription / purchase / payment，发放或回收积分
       UPDATE webhook_event SET status='processed', processed_at=now(), error=null
     COMMIT
5. 事务后投递 EVENTS_QUEUE（发邮件、站内通知、审计）
6. 事务 B 异常：ROLLBACK 后另起事务
     UPDATE webhook_event SET status='failed', error=?, attempts=attempts+1
   返回 500，让平台重试（重试时从第 4 步继续）
```

- 失败记录必须在**独立事务**中写入：事务 B 回滚会撤销其内部的所有写入，若登记与处理放在同一事务里，`failed` 状态和错误信息永远写不进去。
- 管理后台的「重放」= 对 `failed` 的记录用保存的 `payload` 重新执行第 4 步。

**乱序处理**：订阅状态更新以 `occurredAt` / 平台对象的最新状态为准；收到较旧事件时不覆盖较新状态。必要时通过 API 拉取最新对象（`reconcile`）。

**对账 Cron（每日）**：拉取有效订阅在平台侧的最新状态，修复遗漏的 Webhook。

## 4. 积分

### 发放
| 场景 | source | source_ref（幂等键） | 过期 |
|---|---|---|---|
| 订阅首付 / 续费（月付） | `subscription` | `{payment.id}:0` | 当前周期结束 + 宽限（`rollover=false`）或 `credit_expiry_days` |
| 年付：首月 | `subscription` | `{payment.id}:0` | 发放日 + 1 个月 + 宽限（`rollover=false`） |
| 年付：第 2–12 月 | `subscription` | `{payment.id}:{n}`（n=1..11） | 同上；由 Cron 发放 |
| 购买积分包 | `purchase` | `payment.id` | `credit_expiry_days`（如 365 天）或永久 |
| 注册赠送 | `signup` | `sha256(规范化邮箱)` | 配置项；领取并完成邮箱验证后发放到个人空间 |
| 管理员调整 | `admin` | `audit_log.id` | 管理员指定 |
| 退款返还（AI 失败以外的人工返还） | `refund` | 关联 id | 同原批次 |

发放 = 插入 `credit_grant` + 插入 `credit_ledger(type='grant', delta=+amount)`，同一事务。若空间存在欠费，同一事务内先偿还（见「超额容忍」）。

- **宽限**（`billing.subscriptionCreditGraceHours`，默认 24h）：月度批次的过期时间比周期末多留一段，避免续费 `invoice.paid` 晚到时出现积分空窗；`rollover=false` 时旧批次仍会在宽限结束后过期。

### 年付按月发放
- `plan.credits` 表示**每月**积分；年付付款成功时只发首月（`n=0`）。
- **平台字段缺失**：未付款订阅的服务周期允许为空，未确认周期前不授予付费权益；付款快照仍必须给出可验证的付款周期。平台不提供累计部分退款金额时，Provider 返回 `null`，业务层按唯一平台退款 ID 累计本地已验证退款，不把未知值当作零。
- **付款来源保存**：入账时保存付款对应的 `plan_price_id` 与服务周期（一次性付款无周期），后续换套餐或续费不会改写历史付款的年付发放依据。每个已验证退款记录到 `payment_refund`，以平台退款 ID 去重后累计，跨回调与人工审核使用同一身份。
- Cron `subscription-grants`（每小时）：使用已付款的历史 `payment.plan_price_id` 与 `period_start/end` 作为年付依据，按原 UTC 月日锚点计算 n=0..11。active/trialing 与仍在已付周期内的周期末取消订阅均继续发放；暂停、欠费、立即取消、已退款或空间删除时停止。补发缺失的 `{payment.id}:{k}`，迟到月份保留原失效时间并在同一事务中过期，`unique(source, source_ref)` 保证幂等。
- 订阅取消（周期末生效）期间照常按月发放，进入终止状态后停止；退款时按 §「退款与争议」处理该 `payment.id` 下的批次：全额退款回收剩余积分并停止后续发放，部分退款按未退款份额保留并按该份额继续发放。

### 注册赠送防刷
- **领取触发验证**：注册时不强制验证邮箱（04-auth「登录方式」）。未验证的用户在应用内看到「验证邮箱领取 N 积分」入口，点击后发送验证邮件；在**邮箱验证完成**时发放（Better Auth `emailVerification.afterEmailVerification`）。OAuth 账号的邮箱已验证时，注册后直接发放，无需领取。站点开启 `auth.requireEmailVerification` 时，注册即验证，验证完成后直接发放。
- 一次性邮箱域名黑名单（`setting` 表可维护），命中则不发赠送积分（仍允许注册）。
- 同一邮箱规范化（小写、去掉 Gmail 的 `.` 与 `+tag`）后只发一次：`source_ref` 使用规范化邮箱的哈希而非 `user.id`，删号重注册不会再次领取。

### 消费顺序
按 `expires_at asc nulls last, created_at asc` 依次扣减——先用快过期的（通常是订阅积分），再用积分包。

### 预扣-结算（hold → capture / release）

所有 AI 消费都走该模型，文本也一样（先按上限预扣，再按实际结算）：

```ts
// packages/credits
hold(ws, userId, amount, ref, opts?: { expiresAt?: Date }): Promise<Hold>  // 余额不足抛 INSUFFICIENT_CREDITS
capture(holdId, actualAmount): Promise<{ captured: number; absorbed: number; debited: number; debt: number }>  // 超出部分见下文；差额自动退回
release(holdId): Promise<void>                      // 全额退回
```

各计费方式（按次 / 按 token / 按用量单位，见 06-ai §2）在这一层没有区别：调用方用 `estimateCredits` 算出预扣额，用 `actualCredits` 算出实际额，`packages/credits` 只处理积分数量。按次计费时两者相等，不会产生超额。

**状态机**：hold 只允许 `held → captured` 或 `held → released` 两种转换，`capture` / `release` 均以 `UPDATE credit_hold SET status=? WHERE id=? AND status='held'` 开头，影响行数为 0 即抛 `HOLD_NOT_ACTIVE`（调用方据此判断已被其他路径结算，不得重复扣减或退回）。

### 超额容忍（actual > held）

按 token 计费时输入 token 是估算值，按用量单位计费时以服务商回报的 usage 为准，二者都可能超出预扣。原则：**为保证输出完整，不因超额中断生成；平台只在有限额度内承担超出部分，超出额度的由用户承担。**

超出部分 `excess = actual - held` 按以下顺序处理：

| 顺序 | 处理 | 额度（`billing.overage`） |
|---|---|---|
| ① 平台承担 | `absorbed = min(excess, 单次额度, 空间当日剩余额度)`，不扣用户积分 | 单次额度 = `min(held × maxRatio, maxCredits)`，如 `min(held × 20%, 50)`；空间当日额度 `dailyBudgetPerWorkspace`，如 200 |
| ② 从余额补扣 | 剩余部分 `excess - absorbed` 按正常消费顺序从 active 批次扣除，写 `consume` 流水 | — |
| ③ 记为欠费 | 余额仍不足的部分记入 `credit_debt`，写 `credit_ledger(type='debt', delta=-x)` | — |

- **欠费的偿还与限制**：空间存在欠费（`credit_debt.amount > 0`）时，`hold()` 直接抛 `CREDIT_DEBT`，不再允许新的消费；之后任何一次 `grant`（续费、购买积分包、管理员调整）在同一事务内优先偿还欠费：新批次的 `remaining` 直接少计偿还额，`credit_debt.amount` 同步减少；流水照常写 `grant(+amount)`，另写一条 `debt_repay(delta=0)` 记录偿还额供审计（欠费产生时的 `debt` 流水已经计入了负数，偿还不再改变流水总和）。因此平台的损失上限就是 ① 的额度，③ 只是延后收回。
- **把超额控制在额度内**：超额应该是少见的估算误差，而不是常态：
  - 按次计费：不会超额。
  - 按 token 计费：输出被 `maxOutputTokens` 硬性限制，只有输入估算会偏差，估算宁高勿低（见 06-ai §3）。
  - 按用量单位计费：预扣按请求参数计算（张数、时长），服务商回报的 usage 超出参数上限时按参数上限结算，并记录异常。
- **每日承担额度**：按 captured 预扣的结算 `updated_at` 在 UTC 自然日内汇总；创建于昨天、今天结算的预扣计入今天，结算与汇总使用同一事务的 SQL `now()`，同一空间锁保证并发不超额。
- **监控**：`credit_hold` 记录 `overage_absorbed` / `overage_debited` / `overage_debt`；管理后台按模型统计平台承担的总量，持续偏高说明该模型的 `estimateCredits` 需要调整。

`hold` 的实现（单事务）：
```sql
SELECT id, remaining FROM credit_grant
 WHERE workspace_id = $ws AND status = 'active'
   AND (expires_at IS NULL OR expires_at > now()) AND remaining > 0
 ORDER BY expires_at ASC NULLS LAST, created_at ASC
 FOR UPDATE;
-- 应用层依次分配，直到满足 amount；不足则 ROLLBACK
UPDATE credit_grant SET remaining = remaining - $x WHERE id = ...;   -- 每个被分配的批次
INSERT INTO credit_hold (...), credit_hold_allocation (...);
```

- `capture`：hold 置为 captured，写 `credit_ledger(type='consume', delta=-(captured + debited))`（一条汇总）；`captured` 是预扣内消费量，`absorbed` / `debited` / `debt` 为互斥的超额分量，四项之和等于实际消费量。差额按 allocation 消费顺序退回对应批次（退回规则同 `release`）。
- `release`：按 allocation 原路退回 `remaining`。
- **退回到非 active 批次**：若被退回的批次已是 `expired` / `revoked`（或 `expires_at <= now()`），不改动其 `remaining`，而是在同一事务内立即写一条 `credit_ledger(type='expire' 或 'revoke', delta=-退回量, grant_id=该批次)` 抵消。
  - 原因：过期 / 收回任务只处理 `status='active'` 的批次，若把积分加回已失效批次的 `remaining`，就再也不会有对应的 expire 流水，`credit_ledger` 与批次余额会永久对不上。
  - 对账不变式：`sum(credit_ledger.delta) = sum(active 批次 remaining) + sum(held 状态的 hold.amount) - sum(credit_debt.amount)`，由对账 Cron 每日校验并告警。

**超时回收（Cron，每 10 分钟）**：按 `ref_type` 区分，不做一刀切的全额释放：

| ref_type | `expires_at` | 超时处理 |
|---|---|---|
| `ai_message` | 创建后 10 分钟（流式请求不可能更久） | 视为结算丢失，按计费方式兜底：按 token → **有用量检查点时按检查点用量 capture**（06-ai §3「用量检查点」），没有检查点才按最低费用（输入 token 计费或 `minCharge`），余量退回；按次 → 消息已有输出（或 `chargeOn='any_output'` 且上游已调用）时 capture 全额，否则 release。全额 release 会让中断请求变成免费使用 |
| `ai_task` | 不设（`null`），生命周期跟随任务 | 不由 hold 超时触发；由「卡住任务回收」Cron 查询 Workflow 实例状态：实例已结束但 hold 仍为 held → 按任务结果补做 capture / release；实例仍在运行且超过任务硬超时（如 2 小时）→ 先 `terminate` 实例，再将任务标记 failed 并 release |

因为 capture / release 都有状态机校验，Cron 与 Workflow 即使同时结算同一个 hold，也只有一方生效。

### 过期（Cron，每小时）
`status='active' AND expires_at <= now()` 的批次：写 `credit_ledger(type='expire', delta=-remaining)`（`remaining>0` 时），置 `remaining=0, status='expired'`。被 hold 占用的部分不在此时过期，之后的 capture 正常消费，release 按「退回到非 active 批次」处理。

### 退款与争议
- 订阅/积分包退款：通过 `payment.id` 找到对应批次（年付为 `{payment.id}:*` 的所有批次）。
  - **全额退款**：回收全部**剩余**积分（`type='revoke'`，置 `status='revoked'`），被 hold 占用的部分结算时退回到非 active 批次。
  - **部分退款按比例回收**（Q6，2026-10-15 起）：每个批次只保留未退款份额 `floor(amount × (付款金额 − 累计退款) / 付款金额)`，超出部分从剩余积分中收回（`type='revoke'`，批次仍为 active）。目标按累计退款与该批次已收回总量计算，重放与多次部分退款不会重复收回；hold 释放回来的积分在下次回收时一并计入。年付后续月份的批次仍记录原始积分，发放后立即按同一份额保留。
  - 已消费部分不追溯：剩余积分不足目标时只收回剩余部分，不产生欠费。
- 争议（chargeback）：同退款处理，并可将 workspace 标记为受限。

### 退款申请（人工审核）

模板**默认不主动退款**（包括取消订阅和删除账号），用户如有诉求通过退款申请提出，管理员审核通过后才退款：

1. **发起**：账单页的「申请退款」入口，以及删除账号流程中的提醒（见 04-auth-and-tenancy「删除账号」）。用户选择要申诉的付款（只列出 `refundWindowDays` 内、状态为 `succeeded` 的 `payment`），填写理由，创建 `refund_request(status='pending')`。同一笔付款同时只能有一个 pending 申请。
2. **审核**（`/admin/billing/refunds`）：页面展示该付款对应批次的原始 / 剩余积分，供管理员参考；两者之差包含预扣、过期或收回，不能直接当作已消费用量。
   - 管理员决定全额或部分退款金额；通过后调用 `provider.refund(paymentId, amount)`（`capabilities.refundsViaApi=false` 的平台转为线下处理并手动标记）。
   - 驳回需填写原因。
   - 两种结果都写 `audit_log`，并邮件通知申请人。
3. **入账**：积分回收不在审核时做，而是等平台的 `payment.refunded` Webhook 到达后，按上面的「退款」规则处理，与用户在平台侧直接退款走同一条路径；申请置 `status='refunded'`。
4. **联系方式**：申请时记录 `contact_email`，因为删号后 `user.email` 会被匿名化；申请结束（退款完成或驳回）后 30 天清空该字段。

## 5. 权益（Entitlements）

`plan.features` 示例：

```json
{
  "models": ["*"],               // 或允许的模型 key / 标签列表
  "maxConcurrentTasks": 3,
  "maxSeats": 1,
  "storageGb": 5,
  "publicApi": false,
  "priorityQueue": false,
  "watermark": true
}
```

- 平台管理员在 `/admin/billing/plans` 维护 `features.models`：多选现有模型 key 或 `*`，
  保留并警告不存在的历史 key，其他权益和价格不变；写入经过实时鉴权并记录前后审计。
  下一次权益读取即生效，无跨请求权益缓存。首次 seed 的 free 默认 `models=[]`；
  重跑 `billing:seed` 保留既有 models（包括空列表），其他示例配置仍按 seed 更新。
- 当前权益 = 所有**生效中**订阅对应 plan 中 `sort` 最高者的 features，否则取 `free` plan；可叠加积分包附带的权益（首版不做）。同一空间可能短暂存在两个生效订阅（换套餐重叠期，见 §6）。
- 使用方式：`await can(ctx, 'ai.useModel', { modelKey })`、`limit(ctx, 'maxConcurrentTasks')`。
- 「生效中」在**读取时计算**，不依赖定时任务改状态：
  - `trialing` / `active`：生效。
  - `past_due`：在 `past_due_since + billing.pastDueGraceDays` 之前生效，之后视为 free。
  - `canceled` / `expired`：`now() < current_period_end` 时生效（周期内取消保留权益）。
  - `paused`：不生效。

## 6. 升降级策略（首版）

| 场景 | 行为 |
|---|---|
| 升级（Stripe） | 立即生效，平台按比例计费；权益立即切换；积分在下一次 `invoice.paid` 按新套餐发放，当前实现不提供立即补发差额开关（Q5） |
| 降级（Stripe） | 周期结束时生效（schedule） |
| PayPal | 首版不支持订阅内升降级：取消当前（周期末生效）+ 新订阅，重叠期见下 |
| 月付 ↔ 年付 | 同升降级 |

### 「一个空间一个订阅」约束与重叠期

数据库约束（见 03-data-model §7）：同一空间最多一个「**会续费的**」订阅，即 `status IN ('trialing','active','past_due','paused') AND cancel_at_period_end = false`。已设置周期末取消的旧订阅不计入，因此允许：

- PayPal 换套餐：旧订阅 `cancel_at_period_end=true` 持续到周期末，新订阅立即 active，二者并存至旧订阅到期。
- 跨平台更换支付方式（Stripe → PayPal 或反之）：同上，先取消旧的（周期末），再新建。

重叠期的规则：
- 权益取较高套餐（§5）。
- 积分各自按自身付款发放，不做互相抵扣（新订阅即时付全款，旧订阅已付款的周期正常用完）。
- 账单页提示「旧套餐将于 X 日结束」。

**结账前置检查**（`createCheckout` 之前，mode=subscription）：
- 已有「会续费的」订阅且与目标是同一 provider、该 provider 支持 `changePlan` → 拒绝新建，引导走升降级。
- 否则若已有「会续费的」订阅 → 要求用户确认，服务端先调用 `cancelSubscription(old, { atPeriodEnd: true })`，成功后再创建结账。
- 即使检查通过，Webhook 写入时仍可能因并发（两个标签页同时结账）撞上唯一约束：此时保留先到的订阅，对后到的订阅调用 `cancelSubscription(atPeriodEnd: false)` + 全额退款，并写 `audit_log` 告警。

## 7. 页面

- `/pricing`：订阅套餐 + 积分包，选择支付方式（按 `billing.providers` 展示）。
- `/app/$slug/billing`：当前套餐、下次扣费、积分余额与批次明细、账单记录、取消/恢复、（Stripe）打开门户。
- `/app/$slug/usage`：积分流水、按模型/成员的用量统计。
- `/admin/billing`：付款、订阅、Webhook 事件（可重放）；手动调积分和完整管理能力在 P5。

## P2 离线开发与联通边界（2026-10-04）

当前离线开发不需要支付密钥。缺失凭据或未同步价格时，定价和账单页面显示支付不可用，不能伪装支付成功。Stripe 使用 SDK 23.0.0 与固定 API 版本 `2026-09-30.endive`；支付工厂按 `PAYMENT_MODE` 选择 test/live，本地与 staging 保持 test（PayPal Sandbox），token 缓存到 CACHE KV 并按环境隔离。Stripe 3.2 已有真实 Test 录制；PayPal 的 12 条真实 Sandbox 回调录制及补充矩阵见 §2。自然时间和真实收款主体验收移交派生项目。

- 公开入口：`POST /api/billing/webhooks/{stripe|paypal}` 保留原始请求体验签；无效签名返回 400，业务或远端暂时失败返回 500，已提交的付款在队列投递失败时仍返回 200，由 Jobs 扫描持久化记录恢复通知。错误诊断会去除凭据、URL 与控制字符。
- 后台：`/admin/billing` 列表与 failed 回调重放，`/admin/billing/refunds` 全额/部分审核、驳回与独立邮件重试。所有 server function 均重新验证平台 admin。审批或平台 API 响应不等于退款最终入账，只有匹配的已验证退款 ID 才完成申请和积分回收。
- 并发订阅：事务回滚后持久化 `billing_compensation`，取消后到订阅并退款，租约/稳定幂等键允许重试。删除后的迟到订阅回调写入取消任务，保留真实付款凭据、禁止积分和权益恢复，并且不自动退款。
- 删除：认证每次请求注入 billing 删除步骤；取消已知订阅在数据库事务外执行，剩余积分收回与账号/空间匿名化共享原事务。退款使用申请时保存的联系邮箱，删号后仍可审核和通知；驳回或已确认退款 30 天后清理，pending/approved 不清理。
- Jobs：每小时过期和年付发放，每 10 分钟预扣回收框架、回调通知恢复、订阅补偿及退款邮件恢复，每日订阅/积分对账与联系邮箱清理。未注册的 AI 预扣处理器明确告警并保留预扣，P3/P4 注册相应处理器。
- 队列：web 为 EVENTS_QUEUE producer，jobs 消费 events（staging 为 events-staging），仅发送持久化回调 UUID，不传原始载荷或支付密钥。失败重试和 Cron 从库恢复不重新入账。

`pnpm billing:seed` 只写当前数据库的示例套餐，未同步价格保持 inactive。示例金额与积分量并非最终商业定价；AI 模型价格仍由 P3 定义。`pnpm billing:sync` 要求显式 `BILLING_SYNC_MODE=test`、Stripe 测试凭据与 PayPal 沙箱凭据，仅在下一联通阶段执行。Web/Jobs 与同步脚本共用根目录 `.env.local` 的五项支付变量名，参照已提交的 `.env.example`；`seed` / `sync` 自动读取该文件，进程环境优先、未指定数据库时回退到 `.env.worktree`。本地 dev 入口生成 app `.dev.vars` 支付管理区块，线上仍使用 Cloudflare secrets。离线 Playwright 会清空五项支付绑定并启动独立服务，不使用真实支付凭据。密钥不进入模板配置、Git 或日志；完整配置与联通步骤见 [支付联通 runbook](./runbooks/p2-payment-integration.md)。

已完成两平台价格同步与幂等复验（1.3）、Stripe 真实录制与 Provider 验收（3.2）、规定页面验收（10.1–10.3）。本文与路线图的策略及实测证据更新归 10.4；后续 change `add-cloud-acceptance-followups` 承接 PayPal Sale 录制和 staging 沙箱矩阵，并单列自然时间与真实主体移交，范围及逐项证据以其 tasks 为准。

## 8. 支付模式与生产切换清单

`createPaymentRuntime` 是 Web、Jobs 和认证删除步骤共用的支付工厂。非敏感 Worker var `PAYMENT_MODE` 只接受 `test` / `live`，两端 Wrangler 顶层与 `env.staging` 均显式设为 `test`；仓库不提供 production 环境配置。只有 `SENTRY_ENVIRONMENT=development` 缺少模式时默认 test，staging、production 和未知环境缺失模式时关闭支付：HTTP 支付入口返回 503，Jobs 事件失败并交给既有重试机制。结构化日志 `billing.runtime_invalid` 只包含安全字段名与模式，公开营销定价降级为支付不可用。

| 模式 | Stripe Secret Key | PayPal API origin |
|---|---|---|
| test | 仅 `sk_test_` | `https://api-m.sandbox.paypal.com` |
| live | `sk_live_` 或 `rk_live_` | `https://api-m.paypal.com` |

模式与 Stripe key 错配时在远端请求前返回 503，绝不自动切换；后台显示实际模式。Stripe 已验签事件和后台重放的 `livemode` 也必须匹配当前模式，在平台快照查询和账务写入前拒绝跨模式事件。`STRIPE_WEBHOOK_SECRET` 与 PayPal Client ID / Secret / webhook ID 本身无法通过前缀判断 test/live，必须由部署配置提供同一模式的完整一组；PayPal OAuth、业务请求及验签始终只访问选定 origin，失败不重试另一环境。

生产切换前逐项完成以下清单；本 change 只交付代码与离线验证，未配置 live 凭据或执行真实收款：

- [ ] 解决 [路线图 Q9](./08-roadmap.md#待决事项)：确认 Stripe 正式收款主体及支持地区、账户归属；若选择仅 PayPal 或 MoR，按最终方案配置启用的 provider。代码支持 live 不代表主体已获批准。
- [ ] 为生产配置独立数据库、KV、队列、域名与价格对象。不要复用测试数据库的 customer、subscription、payment、price ID；现有 `billing:sync` 仍要求 `BILLING_SYNC_MODE=test`，不能用它创建 live 价格。
- [ ] 在生产 web **和** jobs 配置 `SENTRY_ENVIRONMENT=production`、`PAYMENT_MODE=live`；staging 继续 `PAYMENT_MODE=test`，不修改 staging secrets。生产配置由上线任务单独建立。
- [ ] 分别为两个 Worker 配置生产 `STRIPE_SECRET_KEY`（优先有足够业务权限的 `rk_live_`）与 `STRIPE_WEBHOOK_SECRET`。密钥通过 Wrangler secrets 安全写入，不写模板、Git、PR 或日志。
- [ ] 在 Stripe live 环境登记 `https://<生产域名>/api/billing/webhooks/stripe`，订阅 §2 的事件并匹配固定 API 版本；取此 live endpoint 的 signing secret。不要复用 test endpoint 或本地 `stripe listen` secret；签名不通过或事件模式错配都会拒绝入账。
- [ ] 在 PayPal live 应用取得生产 `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`，登记 `https://<生产域名>/api/billing/webhooks/paypal` 并订阅 §2 所需事件，将此 live webhook ID 配到两个 Worker 的 `PAYPAL_WEBHOOK_ID`。Sandbox 应用、账号、ID 与当前验收 runbook 保持独立。
- [ ] 上线负责人完成受控真实付款、订阅、退款、回调和 Jobs 对账验收，核对后台 live 标识、账务幂等和积分。回滚到已验证部署；已有 live 账务的数据库不能直接切回 test。
