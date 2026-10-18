# W3 沙箱验收（2026-10-18 Asia/Taipei）

UTC 证据日期为 2026-10-17。目标仅为 `web-staging.product-res-jobs.workers.dev`，main 与 health 完整 SHA 为 `a2381f875fbd8b1009e48f7024addcb25285aca9`；协调者冻结 main 合并。`w3-payment-sandbox-preflight.json` 替换了发布完成前的版本不匹配预检，不保留过时阻塞结论。

## 已通过：Stripe 3.1

`w3-stripe-api-readiness.json` 证明四个既有时钟都关联到已完成、已付款的应用 Checkout；复用其中月付/年付独立空间，不新建 Dashboard 脱离应用的订阅。CLI `whoami`、事件、订阅、invoice 和 endpoint 均核对为 Sandbox / `livemode=false`；数据库只使用 `product_res_staging / readonly`，会话只读，账务快照在同一 repeatable-read 只读事务内取得。

| 场景 | workspace | 新 invoice | 新 payment | 结果 |
|---|---|---|---|---|
| 月付 | `01a11fa8-08da-71f1-9c8d-a0ab10568800` | `in_1URbEGL3UTpBAoXowBkmAaZd` | `01a14ade-2be8-777c-84ed-fc676e33a843` | renewal / 1900，唯一 1000 积分 |
| 年付 | `01a11fac-af11-72da-ad52-0869ceb1c9c9` | `in_1URbEuL3UTpBAoXoQdKwXhJu` | `01a14ade-c7e7-70b6-b022-df117e07856e` | renewal / 19000，仅首月 1000 积分 |

`billing-111-w3-stripe-{month,year}-renewal-intent.json` 保存推进前账务、Checkout 关联和固定时钟目标；`advance` 为实际 API 应答，`settled` 为续费后的 invoice、processed 回调与账务。两个空间账本及 active remaining 均为 3000，held/debt/负批次/重复来源为 0。active remaining 不排除已到期但尚未被 Cron 处理的 active 批次。

`duplicates.json` 保存各两次重投的 CLI 接受结果、按持久事件 UUID 关联的 Worker tail HTTP 200 / duplicate，以及逐字段相同的付款、订阅、批次、账本、退款和对账。`w3-webhook-http.jsonl` 只含白名单日志、路径与状态码，不含请求头、签名或原始请求体；它不是回调原文字节录制。月付在这两次完整记录前另有一次成功重投：本地采集脚本误把 event.data 当列表导致结果解析失败，tail 在 `17:18:21 UTC` 已独立观测 duplicate / HTTP 200；随后与 settled 快照复核完全相同，才执行两次有完整证据的重投。另一次本地比较因 JSON 日期字符串与驱动 Date 类型差异在发请求前停止，统一 JSON 序列化后严格比较通过；没有改业务断言或业务代码。

CLI Events GET 仍报告账号默认 `2026-08-26.dahlia`；实际 staging 已验证事件存储为 `2026-09-30.endive`，没有改写或混淆两者。年付推进的是平台年周期，应用、PG、Cron 仍按自然时间运行，不声称全年月度发放已实测。

## PayPal 非浏览器预检

`w3-paypal-api-readiness.json` 保存 Sandbox OAuth 200、原 staging webhook、四个 ACTIVE Plan 与本地报价、既有订阅/付款/待审申请保护清单和当前事件目录。既有两笔付款及待审申请不退款；新订阅必须与此清单分离。当前事件目录没有 Sale 退款，不能凭旧事件完成 2.1 / 3.2。回调接收器和 quick tunnel 尚未启动。

## 1.1 受控失败准备（后台重放尚未执行）

草稿 [PR #244](https://github.com/ustclhx/product-res/pull/244) 在执行前说明了两种方式。第一种是单次投递本地合成的 `invoice.payment_failed` 测试事件，只引用不存在的测试订阅，以指定本地 secret 在进程内签名。实际 HTTP 400、没有登记事件；确切拒绝原因未独立核实，不猜测密钥内容、不修改 secret、不重复尝试。`w3-controlled-failure-intent.json` 及 `w3-controlled-injection-rejected.json` 保留该未通过尝试；付款、订阅、批次、账本、退款、补偿六类业务表的白名单摘要与计数完全不变。该事件不是 Stripe 平台事件、处理失败或回调录制成功证据。

第二种方式先更新 PR 说明，再通过已登录 Stripe Sandbox CLI 新建无邮箱、无付款方式、无应用 metadata 的独立 customer 和一天免费试用订阅，缺少付款方式时自动取消。使用既有测试报价，发票应付/实付均为 0。平台真实生成并签名投递的 `customer.subscription.created` 因 `Missing or invalid billing metadata` 在现有 prepare 校验失败，持久化 failed；这是真实平台事件，但失败由受控缺少关联条件造成，不能称为自然失败。该资源不是应用 Checkout 或付费订阅验收数据。

`w3-platform-failure-{customer,subscription,ready,cleanup}.json` 保存安全对象 ID、零金额发票、failed 回调、取消结果与同快照业务摘要。只取消这次新建的试用订阅；取消后的回调因同一缺少关联条件也会 failed，明确保留，不删除记录。取消命令的确认提示使本地 JSON 解析停止，随后通过独立只读 GET 确认已 canceled，没有重复取消。

无新应用失败机制、代码、部署、密钥修改或账务直写。与试用有关的 Stripe 对象不含应用空间/用户关联，不进入付款与积分业务事务，也不产生订阅补偿；六类业务表前后摘要一致，月付/年付观察空间对账差额均为 0。原回调待管理员重放的事件 UUID 为 `01a14ae5-035b-77c0-b03b-4aa9075d5aa9`，平台 ID 为 `evt_1URbLcL3UTpBAoXoPo2JjN1L`。

真实管理员仍须在 `/admin/billing/webhooks` 对该 ID 点击重放，保存 `billing.webhook_replay_requested` 审计 ID、attempts 与实际结果。因 metadata 刻意缺失，预计重放仍 failed；只能证明后台重放路径与失败隔离，不能声称恢复 processed 或成功处理付款。未取得后台审计及前后付款/批次/账本快照前不勾选 1.1。

## 移交与待执行

自然续费（既有 PayPal 订阅下一账单时间 2026-11-11T10:00:00Z）、自然取消到期、恢复后扣款、年付后续 Cron 观察与真实收款主体 / live 验收移交派生实际项目，详见本 change tasks 的移交说明。2.1 / 3.2 的沙箱买家批准、新 Sale 及部分/全额退款录制、取消/恢复与重叠期矩阵仍须执行；不能以移交自然时间为由跳过沙箱部分。
