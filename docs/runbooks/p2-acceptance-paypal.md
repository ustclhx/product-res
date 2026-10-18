# P2 PayPal 沙箱联通验收

本文件对应 `add-billing-and-credits` 的 3.3 与 11.1 的 PayPal 部分。
完成门槛以 [支付联通 runbook](p2-payment-integration.md) §7 为准。
当前状态：**前置核验通过，交易验收待执行，3.3 未完成**。11.1、10.4 由协调者汇总，本 worker 不勾选。

## 2026-10-09 前置核验

操作者：本 worktree Codex；worktree 分支 `ustclhx/p2-paypal`。

| 项目 | 实际结果 | 证据边界 |
|---|---|---|
| staging 探活 | HTTP 200，`status=ok`、`db.status=up`；SHA `3220611c66c644ed83d97c5c2b9921ac4c111195`；`jobs.lastCronAt=2026-10-09T07:50:36.634Z` | SHA 与本 worktree HEAD 一致；两 Worker version 待查询，不沿用旧发布版本 |
| Neon 查询目标 | `current_database()=product_res_staging`、`current_user=readonly` | 从受保护 `.env.staging-neon` source 后，仅经 Docker psql SELECT 核对；未直接写业务数据 |
| Sandbox OAuth | `/v1/oauth2/token` HTTP 200 | 从主 checkout 受保护 `.env.local` source；token 仅在进程内用于 PayPal API，不保存或输出；本机 OAuth 不代表 staging KV 命中 |
| 当前 App webhook | `/v1/notifications/webhooks` HTTP 200；ID `2Y038131HD900422W`；地址为 `https://web-staging.product-res-jobs.workers.dev/api/billing/webhooks/paypal`；12 项订阅事件与 runbook §3 一致 | 本地 `.env.local` 未提供 `PAYPAL_WEBHOOK_ID`；这不能推断 staging secret 缺失或错误，须由真实回调验证 |
| 当前 App 事件列表 | `2026-10-09T07:55:14.012573Z` 起执行 `/v1/notifications/webhooks-events?page_size=100`，`events=[]`、`count=0` | 此次查询未指定日期范围；仅说明默认查询窗口没有事件，不声明历史全部为空 |
| staging CACHE | `2026-10-09T07:55:46.583492Z`，远端 KV key list 中 `paypal:oauth:v1:sandbox:` 前缀计数为 0 | 未读取 token 值；尚无本轮 staging token 缓存成功证据，需交易请求后复查 |
| 买家账号入口 | Developer Dashboard `/dashboard/accounts` 跳转至 `www.paypal.com/signin` 的真实账号登录页 | 按通用规则交用户亲自登录；尚未获取或使用个人沙箱测试买家 |

### 本地报价与远端 Plan

2026-10-09 readonly 查询得到 5 条 PayPal 报价，均 active、USD。随后使用当前 Sandbox App OAuth 逐条 GET 四个 Plan，均 `ACTIVE`、单个 REGULAR 周期、`interval_count=1`、`total_cycles=0`、定价 version 1、setup fee 0；金额与本地一致。

| 本地 plan_price ID | 远端 ID | 周期 | 最小货币单位金额 |
|---|---|---|---:|
| `01a11bac-8ffa-740a-b8e6-0624cd93c617` | `P-5DY311405E0178244NLEERUI` | MONTH | 1900 |
| `01a11bac-9d27-71c5-9d9e-3437f0b3886e` | `P-4LD1389644835684FNLEERVI` | MONTH | 4900 |
| `01a11bac-92e7-72b3-ba1f-0cdb155b8c69` | `P-18T48576JW846782KNLEERUY` | YEAR | 19000 |
| `01a11bac-a018-7367-8674-f78af86ce46a` | `P-5NR306415E2670818NLEGCUY` | YEAR | 49000 |
| `01a11bac-a76a-72f7-ad0f-6b6e73092f2f` | `paypal:credit_pack:01a11bac-a76a-72f7-ad0f-6b6e73092f2f` | 一次性 | 1000 |

积分包没有远端 Plan。本轮只读核对，不重新 seed/sync、不改已共享的远端套餐。

## 续费与应用到期验证方案

以下为 2026-10-09 官方文档核对结论，**尚非当前账号续费实测**：

- [Create plan](https://developer.paypal.com/api/subscriptions/v1/plans-create) 的最短文档周期为 DAY、interval_count 最小 1。当前应用在 `paypal/snapshots.ts` 的 `frequency` 明确只支持 MONTH/YEAR、单个固定 REGULAR 周期，因此不能临时建 DAY Plan 并当作本应用月付/年付续费通过。
- [Subscriptions v1](https://developer.paypal.com/api/subscriptions/v1/) 未列出测试时钟或推进账期操作。[Subscription capture](https://developer.paypal.com/api/subscriptions/v1/subscriptions-capture) 仅处理 OUTSTANDING_BALANCE，金额不得超过欠款；不能把它当作已成功付款订阅的下一周期扣款。更新 outstanding balance 或 start_time 来制造付款不属于当前验收方案。
- [Webhooks simulator](https://developer.paypal.com/api/rest/webhooks/simulator/) 的事件不关联 App/真实交易、不能重投，也不能通过 `verify-webhook-signature` 回传验签。它支持自验签，但本实现使用回传验签；不能以模拟器替代 3.3 的真实续费录制或声明真实验签成功。
- 当前可行方案：真实购买 MONTH/YEAR 后记录 `start_time`、`next_billing_time`，保留独立订阅等待自然续费；另一个订阅取消后等待实际周期末与 daily reconciliation。未观测到真实扣款前保持 pending。登录后再核对当前账号是否提供官方支持的沙箱加速入口，若存在，记录具体操作与真实交易历史后重新评估。
- 应用时间相关的年付第 2–12 月发放、积分过期和取消到期，可由协调者另行安排隔离库中可审计的受控时间验证。不能修改共享 staging 的系统时间或直接写业务表；受控验证必须与自然时间的 staging 结果分别记录，方案未执行前保持 pending。

## 场景矩阵

每项交易都需补全 runbook §6 所要求的 UTC、两 Worker version、workspace/user、报价、订阅/Order/Sale/Capture/退款/事件 ID、金额/周期、投递状态、原文 hash 与受限位置、脱敏夹具位置、余额/批次/流水/权益、Queue/Cron/审计证据。

| 场景 | 状态 | 尚需证据 |
|---|---|---|
| 月付首付、activation 与唯一积分批次 | pending | 沙箱买家批准、Sale 读取、历史与付款周期、验签回调及 readonly 对账 |
| 年付首付只发一个月积分 | pending | 独立订阅、真实付款周期与唯一首月批次 |
| MONTH/YEAR 自然续费 | pending | 新 Sale ID、完整交易历史、renewal 映射与唯一批次；需解决实际等待时间 |
| 取消/恢复与恢复后交易连续性 | pending | suspend/activate、回调、已付期权益、恢复后真实扣款 |
| 到期与最终取消 | pending | 实际周期末、权益失效、daily reconciliation 及远端 CANCELLED |
| 同平台换套餐重叠期 | pending | 两笔真实首付、一条会续费订阅、最高套餐权益、各自唯一批次 |
| 积分包与 Orders capture | pending | 买家批准与返回页 capture、Capture 回调及唯一入账；记录实际到达顺序 |
| 退款申请与 admin 部分审核 | pending | 当前测试平台 admin、申请/API 响应、匹配退款回调、退款身份与收回全部剩余积分 |
| Capture 全额/部分平台退款 | pending | 真正 Capture refund 与回调、累计金额和唯一收回流水 |
| Sale 全额/部分平台退款 | pending | 弃用 v1 Sale/refund API 实际成功、原付款关联、累计金额与回调 |
| 同一首付/续费/退款事件重投两次 | pending | 平台 resend 与每次 endpoint 结果；付款、退款、批次和流水保持不增量重复 |
| KV OAuth 与远端回传验签 | pending | staging 交易后缓存 key/TTL 与真实事件验签成功；不得输出缓存 token |
| 真实回调录制夹具与映射回归 | pending | 当前 App 首付/续费/一次性/退款的受限原文、脱敏夹具、真实快照与测试 |

每个已执行场景均核对 `ledger=expected`、`negative_grants=0`，并核对事件、付款、退款、`(source, source_ref)` 唯一性。尚未执行的场景不以空表对账充当通过。

## 阻塞与继续入口

当前阻塞：用户需亲自完成 PayPal Developer Dashboard 的真实账号登录，之后可按已授权的通用规则读取 Sandbox test accounts 并使用个人测试账号付款。尚无交易回调材料，因此不创建声称为真实录制的夹具、不勾选 3.3、不将卡片置为 in-review 或声称已开验收 PR。

## 本地验证

`pnpm --filter @product-res/billing test -- src/paypal/webhooks.test.ts src/paypal/snapshots.test.ts src/paypal/operations.test.ts` 在 2026-10-09 07:55:56 UTC 开始，退出 0，21 个测试文件、247 个测试通过（8.08 秒）。此次 `--` 之后的参数未限制 Vitest 文件范围，实际运行了整个 billing 包；这只是已有离线/本地回归，不抵充真实沙箱验收。

对 Markdown 执行 `pnpm exec biome check docs/runbooks/p2-acceptance-paypal.md` 返回未处理文件，原因是当前 Biome 不处理该 Markdown 路径；不记录为检查通过。本轮未改生产代码或现有测试，完整 PR 门槛检查尚未执行，待真实验收和夹具实现完成后统一运行。
