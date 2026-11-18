# 共存定价与账单数据接口

`add-billing-coexistence` 提供数据接口；定价页分组与账单页分区由 `add-ui-design-system` 8.7 实现（`features/marketing/pricing-page.tsx`、`features/billing/billing-sections.tsx`）。

## 定价

`features/marketing/pricing-data.ts` 保留公开快照与缓存降级，`marketingPlans(catalog)` 的 `PricingPlan` 保留完整 `features`；调用 `pricingFeatures(plan.features)` 派生权益清单：`maxSeats`、`storageGb`、`maxConcurrentTasks`、`publicApi`、`priorityQueue`、`watermark`、`models`。条目为 `{ key, value }`，由 UI 本地化；不根据套餐名称猜测权益。`groupPricingPlans(plans)` 返回 `subscriptions` / `creditPacks`；`pricingForInterval(plan, 'month' | 'year')` 只切换订阅价格，积分包始终使用一次性价格。目录原始 prices 字段不变。

## 账单

已鉴权的 `getCustomerBilling` 新增 `summary`；owner/admin 可读，member 返回 null 并且不会读取分类余额。已有 `credits`、订阅历史和 owner 支付/退款历史合同不变。

`summary.currentSubscription` 为最高有效套餐对应订阅（id/name/planKey/provider/status/currentPeriodEnd/cancelAtPeriodEnd），生效判断复用共用的 `isSubscriptionEffective`，包含 past_due 宽限与付费重叠期；没有则 null。`nextRenewalAt` 仅当前订阅仍继续续费时返回边界，取消、终止、暂停均为 null。

`summary.credits` 来自 `@product-res/credits` 导出的 `getCreditSummary(db, workspaceId, now?, tx?)` / `CreditSummary`：

- `subscription.total`：全部可用订阅批次，含宽限与结转。
- `subscription.currentPeriod`：依据付款 periodStart/periodEnd、原始 UTC 月锚点和 `{paymentId}:{n}` 归属的当前月度批次，不依据 createdAt 或自然月。
- `purchase`：purchase 来源。
- `free.signup` / `free.daily` / `free.total`：R3 合并前 daily 默认为 0；查询保留按来源文本识别，为 R3 发放接入预留。
- `other`：其余来源；`available = subscription.total + purchase + free.total + other`。

默认使用数据库 `now()`，与 `getCreditBalance` / `hold` 的可用性判断一致；可选 `now` 参数仅用于指定周期锚点时间。一个 SQL 快照统计 active 且尚未到期的 remaining；预扣已经扣减 remaining，因此不会重复扣减 held。撤销与过期批次不计入。所有 grant/payment 关联限定当前空间。年付锚点从付款原始日期计算，Jan 31 → Feb 28 → Mar 31；旧月结转和非 rollover 宽限期批次保留在 `subscription.total` 中，但付款周期结束后不再计入 `subscription.currentPeriod`。

账单页按「订阅（`#subscriptions`，含 `#choose-plan` 套餐选择）/ 积分余额（`#balance`）/ 购买积分包（`#credit-packs`）」分区，分区只在有生效价格或持有记录时渲染，免费积分另需注册赠送或每日领取配置；积分包在 `#credit-packs` 直接结账，套餐下拉只列订阅价格。订阅存在不影响积分包 checkout。无物理 schema、新轮询或新定时任务。R3 合并后需协调者用实际 daily 发放复核。
