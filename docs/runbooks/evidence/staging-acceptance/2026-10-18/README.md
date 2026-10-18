# W3 后台重放与 PayPal 沙箱验收

staging health 与远端 main 均为 `a2381f875fbd8b1009e48f7024addcb25285aca9`，数据库正常。复用已登录的真实平台管理员浏览器会话，未执行登录、模拟用户或修改角色。

## 1.1 已通过

管理员在 `/admin/billing/webhooks` 找到受控平台事件 `evt_1URbLcL3UTpBAoXoPo2JjN1L`（持久 UUID `01a14ae5-035b-77c0-b03b-4aa9075d5aa9`），只点击该行一次 `Replay failed event`。页面实际显示 `Replay failed; record remains available for retry.`，attempts 从 3 增至 4。

`w3-admin-replay-before.json` / `after.json` 保存独立只读前后证据。新增 `billing.webhook_replay_requested` 审计 `01a14d88-cd77-764e-98c9-64b3250f8ffc`，付款、订阅、批次、账本、退款、补偿六类业务表的计数与白名单摘要完全不变；两个观察空间的完整付款/批次/账本快照相同，同快照对账差额均为 0。刻意缺少 metadata 的事件仍 failed 是实际结果，不声称成功恢复 processed 或处理真实付款。受控来源及零付款试用资源的取消证据见前一日 W3 记录；没有新增应用失败机制、部署、密钥修改或账务直写。

## PayPal：此前登录阻塞（已解除）

此前进入 Sandbox `/signin` 时按规则停止，历史阻塞记录见 `w3-browser-execution-status.json`。2026-10-18 用户明确授权从已登录的开发者后台读取 Personal Sandbox 测试账号并代为登录后，已解除该阻塞；密码仅用于浏览器登录，未进入终端、文件、证据或 PR。以下记录取代此前的未完成状态。浏览器已释放。

## 2.1 已通过：真实 Sale 首付与退款录制

仅操作 `PAYMENT_MODE=test` / PayPal Sandbox，通过 staging 应用 Checkout 在原来无订阅、无付款的独立空间 `01a12ef0-66cc-75e2-88d0-eac1f1904d3c` 新建两份订阅。Personal 测试买家账号已脱敏，未操作真实钱包。取证前 staging 与冻结 main 版本一致；查询仅用 staging readonly 角色。

| 步骤 | 实际结果 | 证据 |
| --- | --- | --- |
| Pro 月付首付 | USD 19.00，Sale `71D187337X5761003`，一份 initial 付款、1000 积分，余额 90→1090 | `w3-paypal-monthly-initial.json` |
| 月付取消与恢复 | 远端 ACTIVE→SUSPENDED→ACTIVE；本地 canceled/true→active/false，账务与已付权益保留 | `w3-paypal-monthly-{canceled,resumed}.json`；最终远端阶段摘要 |
| 换 Team 年付并批准 | 应用先取消旧月付续费；新 Sale `5ST08785RL1551152` / USD 490.00，一份 initial 付款、首月 5000 积分，余额 6090；重叠期 Team 权益，仅年付续费 | `w3-paypal-annual-overlap.json` |
| 取消新年付续费 | 两笔新订阅均远端 SUSPENDED、本地 canceled/true，账务无变 | `w3-paypal-new-subscriptions-canceled.json` |
| 月付部分退款 | 新 Sale 退款 USD 4.00 / Refund `95R03124HK508535V`，POST 201、GET 200、completed；只回收 211，余额 5879 | `w3-paypal-monthly-partial-refund-{intent,api}.json`、`w3-paypal-monthly-partial-refunded.json` |
| 年付全额退款 | 新 Sale 退款 USD 490.00 / Refund `6JW466111B6808810`，POST 201、GET 200、completed；回收 5000，余额 879 | `w3-paypal-annual-full-refund-{intent,api}.json`、`w3-paypal-annual-full-refunded.json` |

每个阶段付款、订阅、批次、账本、退款和对账数据来自同一只读可重复读事务；差额均为 0，无负批次、负余额、重复付款或重复积分来源。月付部分退款保留 `floor(1000×1500/1900)=789`，不把部分退款当作全额回收。年付全年金额仅发放首月积分，后续月 Cron 未假装已发生。

使用自己的本地 HTTP 接收器和 Docker `cloudflare/cloudflared:2026.9.3` quick tunnel，新增临时 Sandbox webhook；原 staging webhook URL 与 12 项订阅未改。十条真实回调原文均经 PayPal 在线验签 SUCCESS 后才脱敏，元数据与原始正文 SHA256 见 `w3-paypal-callback-recordings.json`。原文与 transmission headers 仅驻留内存，未写盘；夹具在提交前再次移除交易历史 `payer_email`，不含个人邮箱、签名、OAuth、密码或 tunnel URL。

四条新事件与十份 GET 快照见 `packages/billing/src/paypal/fixtures/recorded/w3-provenance.json`；含月付/年付 Sale 首付、Sale 部分/全额退款，离线 recorded 共 15 测试通过。原始 SHA 描述脱敏前数据，fixture SHA 描述脱敏后的映射输入，不能用脱敏正文伪造在线签名。`docs/05-billing.md` 已回写 v1 Sale/Refund 字段与真实周期差异。

临时 webhook 已删除，自己的接收器与 quick tunnel 已停止，18763 端口无监听、对应 Docker 容器未运行；未停止他人的进程，未使用第三方回调接收器或已命名 tunnel。

## 3.2 已通过：重复回调与保护复核

两笔首付和两笔退款各重投两次，目标仅为原 staging endpoint；API 202 只证明重投被接受，须由 `w3-paypal-webhook-http.jsonl` 独立确认 HTTP 200 / duplicate，再比较完整业务快照与持久事件。最终 `w3-paypal-duplicates.json` 为 passed：共八次 HTTP 200 / duplicate，逐次完整业务快照与持久事件不变。另一次全额退款重投仅获 202，未独立观测 HTTP；保留于 `unconfirmedResends`，不计通过。重连自己的日志监听后补做两次有响应证据的重投，没有再次发起退款。监听已停止。

`w3-paypal-protected-records.json` / `w3-paypal-final.json` 核对原付款、原订阅和 pending 申请逐字段不变，两份新订阅均为 SUSPENDED，原 webhook 配置一致；最终余额 879、对账差额 0。`w3-paypal-recorder-cleanup.json` 保存独立清理复核。

本地 Node 22 验证：`pnpm check` 通过（四条既有 warning），`pnpm typecheck` 14/14；`NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @product-res/billing test` 为 24 文件 / 312 测试通过，含隔离 worktree PostgreSQL。脱敏、凭据和连接串扫描及 `git diff --check` 通过。

## 移交派生项目

PayPal 自然月/年续费（既有订阅最早为 2026-11-11T10:00:00Z）、恢复后真实扣款、取消到期终止、年付第 2–12 月真实 Cron 观察，以及真实收款主体、live 配置与受控真实收款验收，按用户决定移交派生实际项目。任务范围与移交门槛见 change 的 tasks；不计为本次沙箱已实测。
