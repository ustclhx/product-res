# P2 Stripe 真实联通验收

> Stripe 3.2 门槛已通过。11.1 的 Stripe 平台矩阵与批准的受控时间验证已完成；管理员审核部分退款仍待用户提供会话，11.1 与 10.4 留给协调者汇总，不勾选。

## 环境与证据口径

- 验收日期：2026-10-09 UTC；目标 `https://web-staging.product-res-jobs.workers.dev`。
- 初始健康版本：`3220611c66c644ed83d97c5c2b9921ac4c111195`。修复 #67 / #70 合并后，先确认 main CI [37921394348](https://github.com/ustclhx/product-res/actions/runs/37921394348) 与自动发布 [37922073771](https://github.com/ustclhx/product-res/actions/runs/37922073771) 成功，且 `/api/health.version` 等于完整 `a978a4d6e2ed0cbc041f376c5591ce033cf929ae`，再于 11:12 UTC 开始本轮重验；`status=ok`、`db.status=up`，jobs Cron 心跳推进。开测前的匹配来自当时终端读取；保存的 `post-fixes-health.json` 是重验期间再次采集的健康快照，不能单独证明开测前时间顺序。
- Stripe Sandbox account：`acct_1UMwpCL3UTpBAoXo`；endpoint：`we_1UO7wML3UTpBAoXo3N6XlJhF`；所有录制事件 `livemode=false`。
- 代码及真实 endpoint snapshot 版本：`2026-09-30.endive`，SDK `stripe@23.0.0`。账号 Events GET 返回 `2026-08-26.dahlia`，即使请求使用 endive；因此没有把 Events GET 的版本字段改写成 webhook 版本。
- 账务核对只使用 Neon staging readonly 角色；购买、取消与退款通过应用或 Stripe 测试平台产生，未直接写 staging 数据库。密钥通过指定环境文件加载，未保存在夹具、日志或 PR。

录制夹具位于 `packages/billing/src/stripe/fixtures/recorded/`，来源和摘要见 `provenance.json`。区分三种证据：

1. staging 已验签后存储的 JSONB：保留真实 endive event 形状；摘要是 PostgreSQL JSONB 导出的规范正文摘要，不能作为原 HTTP 字节摘要。
2. Stripe CLI `--latest` 的真实签名本地镜像：在内存中使用该 listener secret 验签并计算原正文、签名摘要；仅保存脱敏正文。它与 staging endpoint 分别接收同一平台事件，不能把本地镜像签名称为 staging 签名。
3. 认证 Stripe API GET：保留查询参数、版本、采集时间及原响应摘要；用于离线重放 invoice payments、PaymentIntent、历史 invoice 和 Checkout 的关联，不作为回调原文。

脱敏会改变正文，录制测试中的离线签名使用测试专用 secret 重新生成；不声称它是 Stripe 原始签名。原始正文含联系方式及带 token 的 URL，未落盘。夹具仍保留对象 ID、金额、USD 币种、业务 metadata、历史周期和退款身份。

可审阅的只读账务快照保存在 [evidence/p2-stripe](./evidence/p2-stripe/)，包含年付首付、积分包、申请 pending、Portal 返回、取消失败后的真实状态、平台退款遗漏及首付两次重投前后比较；仅导出白名单字段。原始 SQL 使用 runbook §6 的对账口径，`monthly-initial-resend-comparison.json` 汇总前后相等结果；平台 HTTP 200 来自 Workbench 独立核对，CLI 接受请求本身不证明目标端点返回 200。

## 已通过与发现的问题

| 场景 | 真实结果 | 账务与证据 |
| --- | --- | --- |
| Pro 月付首付 | 已通过，原有真实 Checkout e2e 1 passed | workspace `01a11fa8-08da-71f1-9c8d-a0ab10568800`；invoice `in_1UOYdeL3UTpBAoXoBFsFpO0W` → PaymentIntent `pi_3UOYdfL3UTpBAoXo1TssRKHa`；1900 USD 最小单位，首月 1000 积分；event `evt_1UOYdhL3UTpBAoXoDzgAEbGZ` processed。 |
| Pro 年付首付 | 已通过，新真实 e2e | workspace `01a11fac-af11-72da-ad52-0869ceb1c9c9`；PaymentIntent `pi_3UOYieL3UTpBAoXo13iyAy3V`；19000 USD 最小单位，仅发首月 1000 积分；invoice event `evt_1UOYihL3UTpBAoXoPA5QUWq3` processed；对账成立、无负批次。 |
| 积分包付款 | 已通过 | workspace `01a11fad-54ef-74b1-bb49-26232712dfa4`；PaymentIntent `pi_3UOYjIL3UTpBAoXo1gvunegg`；1000 USD 最小单位，purchase paid，1000 积分；`evt_1UOYjKL3UTpBAoXo6nn8x7at` processed。另一个新用户的退款申请已通过，见下行。 |
| 月付 Test Clock 续费 | 修复发布后重验通过 | clock `clock_1UOYeQL3UTpBAoXoq2VlSbJ7`；invoice `in_1UOYeuL3UTpBAoXoFow1TDQx` → PaymentIntent `pi_3UOYf0L3UTpBAoXo0tcelvaV`；`evt_1UOYf4L3UTpBAoXoqVeBpjfd` 原先投递 500（`Subscription grant month is not due`），事务未产生付款或积分；修复 PR [#67](https://github.com/ustclhx/product-res/pull/67) 先红后绿并已合并。11:12:18 UTC 恢复投递 200，入账 renewal / 1900 与唯一 1000 积分批次；余额/ledger=2000。随后两次 200 且全部账务不变。 |
| 用户申请退款 | 已通过，退款申请为 pending | workspace `01a11fbe-9660-75a3-8bcd-8a217b9a626c`；退款表单等待父页面已就绪控件后提交成功（47.7 秒）；付款、积分和 ledger 与提交前相同；尚未执行管理员审核。 |
| Customer Portal | 已通过，打开并返回应用 | workspace `01a11fc0-e265-74aa-b17a-cd6058f2fd49`；配置为测试模式 default Portal，启用发票历史、付款方式更新和周期末取消；实际打开 Portal 再返回账单页（50.1 秒），账务不变。 |
| 平台部分退款 | 修复发布后重验通过 | refund `re_3UOYjIL3UTpBAoXo1qqwZkZA`，400 USD 最小单位；`evt_3UOYjIL3UTpBAoXo1KA14f1c` 真实 endive `charge.refunded` 不含 `refunds`，被标为 ignored；08:07:29 UTC 只读核对仍无退款记录或积分撤销。修复 PR [#70](https://github.com/ustclhx/product-res/pull/70) 已合并。旧 ignored 事件是终态，未声称重投可重跑；11:13:30 UTC 在同一付款新建 200 退款 `re_3UOYjIL3UTpBAoXo1O6Tc6or`，真实 event `evt_3UOYjIL3UTpBAoXo1APsl6Oi` 经认证退款列表补回 400+200 两身份，累计 600、partially_refunded，全部剩余 1000 积分撤销。余额/ledger=0；两次重投均 200、金额与撤销流水不再增加。 |
| 取消/恢复 | 原用例串行重验通过（56.5 秒） | 先前 08:20:56.735 UTC 操作成功但 5 秒内 Resume 不存在；未改变生产代码、刷新页面或放宽断言，本轮取消 true、恢复 false，原付款周期、积分批次、ledger 均保持不变。两次带诊断 wrapper 的取消 probe 也通过，但 wrapper 会改变时序，不能据此认定原失败原因；普通原用例的重验才计为通过。随后独立 Test Clock 真实续费 1900，见下行。 |
| 升级/降级与实际续费 | 已通过 | workspace `01a11fcd-0b52-75db-bad6-3276f1fa0918`，Pro 首付 1900；升级 Team 后 `pi_3UOZH2L3UTpBAoXo04TeSJAo` 为 adjustment / succeeded / 3000 USD 最小单位，Team 权益立即显示，仍只有初付的 1000 积分，ledger 不增加。降级 schedule `sub_sched_1UOZHFL3UTpBAoXoNT1sOZA4` 保留当前 Team，第二阶段在 `1794213309` 切换 Pro；两阶段 proration none、end_behavior release；预约时付款/积分/ledger 不变。11:16 UTC 平台推进过周期末，订阅实际 price 切回 Pro，`in_1UObn0L3UTpBAoXociLtCGbI` 为 paid / subscription_cycle / 1900，`pi_3UObn3L3UTpBAoXo17Ou3tME` renewal 且只增 1000 积分，余额/ledger=2000。 |
| 换套餐重叠期 | 单场景重验通过（约 1.1 分钟） | Pro 周期末取消后新购买 Team，两个订阅均保留已付周期，Pro cancel true、Team cancel false；仅 Team 会续费，当前权益 Team，两个真实初付分别发 1000、5000 积分，余额/ledger=6000、held=debt=0。此前矩阵在初始 Checkout 前停于 `Something went wrong!`；保留失败及 CPU 超限证据，重验未改变断言。 |
| 首付重复投递 | 已通过，平台两次 HTTP 200，账务不变 | `evt_1UOYdhL3UTpBAoXoDzgAEbGZ` 两次 CLI resend 被平台接受；Workbench 显示 08:20:05、08:20:06 UTC 两次手动重试均 200 OK，原投递为 07:54:52 UTC 200 OK。08:23:20 UTC 只读核对前后付款、订阅、退款、grant、ledger 完全相同；ledger=expected=1000，负批次 0。 |
| 年付 Test Clock 续费 | 已通过 | clock `clock_1UOYzzL3UTpBAoXoMAu8qO78` 推进到 `1823075995`；真实 invoice `in_1UObkvL3UTpBAoXobV0VR57D` → PI `pi_3UObkxL3UTpBAoXo0sXqeehl`，19000 / renewal / succeeded；event `evt_1UObl2L3UTpBAoXoIhWrCL6T` processed，仅发新周期首月 1000，余额/ledger=2000。两次重投 200 且账务不变。 |
| 恢复后续费 | 已通过 | workspace `01a11fca-f8b5-71ac-91cb-2e556301a8e5`；clock 推进到 `1794220373`，cancel false / active；invoice `in_1UObltL3UTpBAoXoqApKqHfU` → PI `pi_3UOblwL3UTpBAoXo1HK8kMdS`，1900 / renewal，event `evt_1UObm1L3UTpBAoXoS3GRbNMi` processed / HTTP 200，新增唯一 1000，余额/ledger=2000。 |
| 平台全额退款 | 已通过 | 使用没有退款申请的独立积分包 workspace `01a11fbb-3dbe-7372-94d7-9d180ead531d`；PI `pi_3UOYxzL3UTpBAoXo0kFoYJrn` 真实退款 `re_3UOYxzL3UTpBAoXo07mx1Eox` 1000，event `evt_3UOYxzL3UTpBAoXo0y6M4huF` processed / HTTP 200，付款 refunded / refunded_amount=1000、唯一退款、批次 revoked / remaining=0。余额/ledger=0，两次重投 200 且账务不变。 |

## 平台时钟与应用时间

月付平台从 `1791532535` 推进到 `1794218086`，续费周期 `2026-11-09T07:54:46Z`–`2026-12-09T07:54:46Z`。年付从 `1791533872` 推进到 `1823075995`，续费周期 `2027-10-09T07:59:55Z`–`2028-10-09T07:59:55Z`，付款时间为 `2027-10-09T08:59:55Z`。恢复后续费与降级续费各使用独立 clock；最终 ready 状态、付款原因与真实价格见 `*-platform-final.json`。

这些 event 的真实 HTTP 投递都在 2026-10-09 UTC，应用 `Date`、PostgreSQL `now()` 和 Cron 没有推进。PR #67 允许已验证成功付款发放其首月，后续月仍由应用时间判断。两年付付款各只有首月 1000，不能把平台年续费称为 staging 已按月发放全年积分。

按协调者 2026-10-09 的明确决定，应用到期门槛采用「真实平台续费回调 + 既有 PostgreSQL 测试注入 now / 控制夹具日期」组合。详细命令、case 与限制见 [受控时间验证](./evidence/p2-stripe/controlled-time-tests.md)：101 passed，其中 83 个本地 PostgreSQL case；全年 12 批由共用发放原语验证，Cron 服务独立验证前三批补发、追溯过期与并发幂等；取消到期读取回落 free、积分过期与 hold/capture/release 对账均通过。付款事件与 Provider 为测试替身，此证据不声称 staging 真实全年 Cron 或应用时钟已推进，也不要求等待真实到期。

## 重投与对账

Workbench 独立只读核验目标 staging endpoint（UTC）：

| event / 场景 | 原投递或恢复 | 两次手动重投 |
| --- | --- | --- |
| `evt_1UOYf4L3UTpBAoXoqVeBpjfd` 月续费 | 11:12:18 / 200（之前 07:56、08:57 为真实 500） | 11:12:29、11:12:30 / 200 |
| `evt_1UObl2L3UTpBAoXoIhWrCL6T` 年续费 | 11:14:38 / 200 | 11:15:22、11:15:23 / 200 |
| `evt_3UOYjIL3UTpBAoXo1APsl6Oi` 部分退款 | 11:13:33 / 200 | 11:14:19、11:14:20 / 200 |
| `evt_3UOYxzL3UTpBAoXo0y6M4huF` 全额退款 | 11:17:02 / 200 | 11:17:23、11:17:26 / 200 |

CLI 请求时间与接受结果在 `*-resend-requests.jsonl`，不能单独证明 HTTP 200；上述状态来自 Workbench 可见投递历史，整理为 `post-fixes-platform-deliveries.json`。各 `*-duplicate-comparison.json` 对应完整白名单快照，逐字段比较 subscriptions、payments、payment_refunds、refund_requests、grants、ledger 与对账数值全部相等。每个场景 ledger=active remaining+held−debt；新历史快照只含汇总 expected，不倒填 held/debt。11:24 UTC 另行只读采集 `post-fixes-reconciliation.json`，独立核对六个空间 available、held=debt=0 及身份唯一性：无负批次、重复 PaymentIntent、退款身份或积分来源。年/月续费 ledger=2000，退款 ledger=0。

## 门槛与剩余事项

- 3.2：当前 endive 真实结账、Portal、取消/恢复、部分/全额退款、首付/续费/一次性回调及录制映射全部通过；真实镜像验签摘要、staging processed 和 invoicePayments→PaymentIntent 的认证 GET/离线重放证据齐备。只勾选 3.2。
- 11.1 Stripe 平台矩阵和批准的受控应用时间门槛已通过。用户申请 pending 已通过，管理员审核部分退款仍待用户会话；保留 workspace `01a11fbe-9660-75a3-8bcd-8a217b9a626c` 的 pending 申请，不通过平台直接退款消耗它、不授予管理员权限。此附加后台流程没有宣称通过，协调者负责推进。
- 11.1 尚须 PayPal 一起验收，10.4 为协调者汇总；本分支不勾选这两项、不归档 change。

## 修复集成检查

本分支先 rebase 到线上实测的 `a978a4d6e2ed0cbc041f376c5591ce033cf929ae`，移除已合并 #67 / #70 的重复修复提交；提交验收时 main 又合并 #69，因此最终 rebase 到 `e9f1e39f8b548cc67498d553ca6f49812281bdca` 并安装 frozen lockfile、复跑根检查。只包含验收代码/夹具/证据和 3.2 勾选，不把最终分支基线冒称线上实测版本。新增年续费与累计部分退款录制映射后，定向测试 6/6 通过。根目录 `pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均退出 0；类型检查 13/13、测试任务 24/24（billing 258 tests）、构建 2/2。新夹具仅做 Biome 格式化，不改变平台记录的业务字段。

## 平台资源限制

2026-10-09 08:33:46.660 UTC、08:34:16.536 UTC，任务内只读 `wrangler tail --env staging --status error` 捕获 `web-staging` 的 `outcome=exceededCpu`，CPU 为 66ms、10ms，wall time 为 1527ms、100ms；请求路径由平台显示为 `/_serverFn/REDACTED`。这证明该轮是 CPU 超限，不能推定早先每个失败均为同一原因。

Cloudflare 当前账号 Workers Plans 页面明确显示「免费」为当前套餐，每请求最多 10ms CPU；[官方 CPU 限制说明](https://developers.cloudflare.com/workers/platform/limits/) 与此一致。任务规范要求任何付费或绑卡交给用户，因此未升级计划或修改计费；CPU 套餐与管理员会话由协调者转用户处理，本 worker 不因 CPU 改业务代码。遇到超限先记录，再串行单场景重验；11:12–11:19 UTC 本轮回调验收 tail 未记录新的 error outcome。没有通过减少业务断言、模拟平台回调或手动部署规避限制。
