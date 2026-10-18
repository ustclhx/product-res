# P2 staging 准备记录（更新至 2026-10-09 UTC）

用户已同意进入真实支付联通阶段。P1 归档保持完成；P2 仍为 28/34，本文记录部署准备与有限联通证据，不作为剩余六项全部完成的验收结论。

## 发布基线与结果（2026-10-05 历史记录）

- [PR #24](https://github.com/ustclhx/product-res/pull/24) 已 squash 合并，main 为 `458fafdef81cf30cc41516eec15fc4d1e7122725`；[合并后的 CI](https://github.com/ustclhx/product-res/actions/runs/37259755499) 通过。
- staging 数据库 `product_res_staging` 应用 0002–0007，共 8 条迁移记录；新增 `payment_refund`、`billing_compensation` 等表已确认。共享开发库、生产库未迁移。
- `billing:seed` 写入 free/pro/team/credit_pack 四个模板套餐，两家平台各 5 条报价。10 条报价全部 inactive，尚未同步平台价格。
- 创建 `events-staging`（ID `79fc85a8db4843d89c3068cce811df76`），发布后有 1 个 producer / 1 个 consumer；保留已有 `email-staging`。
- 按 jobs → web 发布；Jobs 版本 `91bdd92a-1ffd-4fc8-9672-ecec303045f0`，Web 版本 `6c9cf30a-05fa-4e28-8ab4-976424fee830`。
- 已移除合并后的 `p2-integration` Orca worktree 与 `product_res_wt_p2_integration` 测试库。联通文档子任务完成整合后同样清理。

下列为 Neon 准备/发布命令参考；2026-10-05 上述结果来自本机旧 staging。当前 Neon 迁移与 seed 已完成，Worker 已由 main 自动发布并切换绑定；无需重做已完成的准备步骤。后续执行前从受保护 `.env.staging-neon` 加载变量并确认目标库，不使用本机同名库连接串：

```bash
set -a
. ./.env.staging-neon
set +a
psql "$NEON_MIGRATOR_URL" -X -v ON_ERROR_STOP=1 \
  -c 'select current_database(), current_user'
MIGRATION_DATABASE_URL="$NEON_MIGRATOR_URL" pnpm --filter @product-res/db db:migrate
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
pnpm --dir apps/web exec wrangler queues create events-staging --env staging
pnpm --filter @product-res/jobs deploy:staging
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @product-res/web deploy:staging
```

队列已存在后跳过 create；发布顺序与配置见 [Cloudflare 官方 Queues 配置说明](https://developers.cloudflare.com/queues/configuration/configure-queues/)。

## 冒烟验证（2026-10-05 本机链路历史结果）

- `/api/health`、`/pricing`、`/login` 均返回 200，数据库 up；新 Jobs 心跳为 `2026-10-05T03:35:26.799Z`，晚于本次 Jobs 发布。
- 实际浏览器显示四个套餐和“Payments are currently unavailable”；Stripe、PayPal 两个选择项均禁用，没有公开 checkout/pay now 按钮。
- 匿名访问客户账单和用量页跳转登录；后台计费页返回 404，未渲染计费后台。
- 无凭据时 POST 两家 webhook 入口返回 503，未知 provider 返回 404；探测后 `webhook_event` 仍为 0。没有伪造已验签平台事件或付款记录。
- Jobs HTTP 返回既定 404，事件队列 producer/consumer 绑定均已确认。真实计费消息消费、平台回调和新计费 Cron 的业务场景仍需联通验收。

## Neon 准备与部署进展（截至 2026-10-09 UTC）

- Free / PG17 / aws-us-west-2 项目 `product-res-staging` 已创建；数据库/public owner 为受限 migrator。三角色无高权限 flags 或 neon_superuser，原权限脚本完整通过。
- 12 条迁移与 journal/SQL 数量一致，app 建表/审计 UPDATE 与 readonly DELETE 被 42501 拒绝；seed 两次四套餐 ID 稳定。报价同步写入前核验目标 `product_res_staging / app`、Stripe Sandbox account 与 PayPal Sandbox OAuth；网络失败后安全续跑 `billing:sync` 两次均退出 0，10 条映射 active，UUID 与远端 ID 稳定。此证据不代表真实支付成功。
- 两项 Neon Hyperdrive 已在 web/jobs staging 绑定中部署使用。历史代码版本 `7a229ce5e663d6781cefa2f441c01f164766a9ff`；为启用日志再次按 jobs → web 发布后，Worker version 分别为 `cac1c571-e2b9-4e64-9ce9-f61faf9e4c70`（2026-10-09 03:37:51 UTC）/ `c937023d-701a-4526-885f-42a5531f403b`（03:38:58 UTC），健康检查仍匹配同一完整 SHA。2026-10-09 03:35:05.869–03:36:10.165 UTC 健康检查均为 200、db.up；`jobs.lastCronAt` 从 `03:35:04.669Z` 更新至 `03:35:48.639Z`，在 10 分钟内更新，Neon 任务 2.3 通过。
- R2 `files-staging` 与鉴权开启的 AI Gateway `product-res-staging` 已创建；R2 S3 令牌已按用户确认存入本 worktree 的 git 忽略文件（600、明文）。Gateway vars 与 web secret 已部署，`staging:check-secrets` 退出 0、无必需缺项，健康检查无启动配置错误，Neon 任务 5.4 通过。GitHub staging 三项 secrets 已设置并核对；CI token 已验证 active 与当前 account。
- Stripe CLI 发起的 Test `invoice.paid` 已经真实 endpoint 投递到线上 staging，Neon 事件 `evt_1UOUaIL3UTpBAoXoYmdX1ucI` 的 API 版本为 `2026-09-30.endive`、状态 `ignored`、`attempts = 1`。真实验签通过；该事件无订阅，未触发业务动作或发积分，Neon 任务 5.3 通过。这不是控制台操作或购买验收。
- Neon change 最终为 28/29，仅24 小时观察（9.2）保持未完成。注册冒烟（6.2）已通过：原三个用例、断言与超时未改，临时等效配置明确使用本机现有 HTTP 代理 `127.0.0.1:7897`，退出 0、3 passed、20.2 秒；无 mock、伪造 Turnstile token 或系统设置修改，证据为 `/tmp/cloud-staging-neon-proxy-evidence.txt`。版本探活（7.1）正确版本退出 0，错误版本经过 36 轮约 180 秒退出 1，证据为 `/tmp/cloud-staging-neon-wrong-timed.log`。
- PR [#61](https://github.com/ustclhx/product-res/pull/61)、[#62](https://github.com/ustclhx/product-res/pull/62) 与 [#64](https://github.com/ustclhx/product-res/pull/64) 均已合并。Neon 绑定、AI Gateway vars 与 observability 已在 #62 合入 main；本 PR 3 仅更新文档与任务记录。锁探针七场景/49 断言、独立空库重建与小额测试积分包购买（9.1）均已通过；文档与路线图最终结项（8.2）在本 PR 3 完成。jobs 仅 staging 开启日志、采样率 100%、traces 关闭；一小时支付告警日志（5.6）已通过：2026-10-09 03:39–04:39 UTC，48 条 scheduled 记录、13 条心跳、缺凭据告警 0 条。观察期保留旧资源。详细资源 ID、权限差异与回滚见 [Neon staging runbook](staging-neon.md)。

main 当前自动部署代码 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`；[run 37894416572](https://github.com/ustclhx/product-res/actions/runs/37894416572) 为 completed/success（2026-10-09 06:36:31–06:38:28 UTC），迁移 → jobs → web → 完整版本探活 → 冒烟全部通过，3 passed（10.0 秒），任务 7.4 通过。jobs Worker version `38ec01c5-8ced-4173-b478-e2e4f1dc9139`，web `7281e552-88c9-4c40-bfb9-b3ae0c69c83d`；06:41:05.684100 UTC 健康为 ok/db.up/完整 SHA 匹配，lastCronAt 为 `2026-10-09T06:40:35.438Z`。PR #62 的初次自动运行 [37892016841](https://github.com/ustclhx/product-res/actions/runs/37892016841) 在 web 预渲染失败；#64 仅为 Deploy web step 设置两个不可达的 local Hyperdrive 占位连接，构建使用既有 pricing fallback，不连接真实数据库。失败记录不作为成功验收。24 小时观察沿用 2026-10-09 03:38 UTC 切换基线，最早 2026-10-16 同时刻完成；9.2 保持未完成，不删除旧资源。

## 当前门槛与后续

2026-10-05 尚未发现测试凭据是历史状态。2026-10-08 已通过 API 验证同一 Stripe Sandbox 与 PayPal Sandbox 凭据，现有两项 webhook 地址和事件均匹配。jobs 已补 Stripe key 与 PayPal 三项，Stripe webhook secret 已由用户手动提供并补齐、临时文件已删除；用户批准后 web PayPal 三项已统一为核验过的 Sandbox 配置。报价 sync 与 Stripe Test webhook 验签现已完成。

Stripe Checkout 首次返回 `BILLING_UNAVAILABLE`，Workbench 400 确认账户默认 Managed Payments 要求 product tax code。用户已批准每次创建 Checkout Session 显式设置 `managed_payments.enabled=false` 的两文件三行补正，已应用为提交 `ab9dc21274291a82a22da67aaa776c6a779dafef`；Stripe operations 回归由 RED（2 fail）转为 GREEN（20 passed）。根目录 `check`、`check:deps`、`check:singletons`、`typecheck`、`test`、`build` 六项均退出 0，日志为 `/tmp/cloud-staging-neon-managed-{check,check-deps,check-singletons,typecheck,test,build}.log`。

历史 Managed Payments 补正后约 2026-10-09 04:58 UTC 再次按 jobs → web 手动部署完整代码版本 `ab9dc21274291a82a22da67aaa776c6a779dafef`，jobs Worker version `172b231b-7ef3-43f0-b677-aafba97c282e`、web `1c4273f4-420e-453c-96e0-fe950447372c`。部署时间仅据脱敏部署日志/文件时间推断，不作为精确时间戳；`2026-10-09T04:59:01.440Z` 健康检查为 200、status ok、db.up、完整 SHA 匹配，`lastCronAt = 2026-10-09T04:55:31.328Z`；随后心跳推进至 `2026-10-09T05:00:53.721Z`。

已在明确的 Stripe Sandbox 中用官方 `4242` 测试卡购买一次 $10 积分包，空间 `u-4py7aicz` 的 UI 余额从 0 增至 1000。`checkout.session.completed` 事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2` 在 `2026-10-09T05:00:14.299Z` 验签处理成功，API 版本为 `2026-09-30.endive`、`status = processed`、`attempts = 1`；付款 `01a11f08-8359-71e9-813e-64beae2501f9` 关联 `pi_3UOVugL3UTpBAoXo0hPVnZJQ`，`one_time / succeeded / 1000 USD`（最小货币单位）。唯一积分批次 `01a11f08-83f6-750c-b841-c10649a02cdd` 为 `purchase`、`amount = remaining = 1000`，`source_ref` 与 `payment_id` 均匹配该付款。

已修复的重投诊断历史：Workbench 原始投递为 200，`05:00:46` 与 `05:01:03` UTC 两次手动投递均为 500；`05:03:19` UTC 的第三次重投在 live tail 中报 `billing.webhook_failed` / `Webhook delivery association mismatch`。当时 `assertAssociation` 比较完整 event payload，已存与重投的顶层 `pending_webhooks` 从 3 变为 1，导致关联检查失败；三次失败均未重复入账。用户已授权最小修复，提交 `433e737b517733553537cfdb7ed9bb9fad6dbe4e` 仅在 Stripe 已存事件与入站事件的关联比较中忽略顶层 `pending_webhooks`；当前投递原始字节的签名验证、业务 payload 及 PayPal 比较仍严格校验。真实 worktree PG 管线回归由 RED 转为 GREEN（10 passed）；根目录六项检查全部退出 0，`typecheck` 13/13、`test` 22/22（802 passed、2 个既有 skip，其中 billing 247 passed）、`build` 2/2。日志为 `/tmp/cloud-staging-neon-duplicate-{check,check-deps,check-singletons,typecheck,test,build}.log`。

历史去重补正后已按 jobs → web 手动部署完整代码 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`，jobs Worker version `e60c6ed2-0f59-4bf8-b245-98e018096bd6`、web `5bfb1235-9cf6-4558-9b88-802938dcfb05`。部署精确时间未留证；`2026-10-09T05:11:05.853Z` 健康观测为 200、status ok、db.up、完整 SHA 匹配，`jobs.lastCronAt` 从 `2026-10-09T05:00:53.721Z` 推进至 `2026-10-09T05:10:39.639Z`。该历史提交的 [CI run 37887162498](https://github.com/ustclhx/product-res/actions/runs/37887162498) 已全部通过，head SHA 为上述完整 `433e737b517733553537cfdb7ed9bb9fad6dbe4e`；CI 通过不代替首次 main 自动发布验收。

修复部署后，使用受保护的测试 key 经 Stripe CLI 重投同一原始购买事件 `evt_1UOVuiL3UTpBAoXom7S1Ate2`；Stripe Workbench 的 `2026-10-09T05:11:10Z` Manual retry 明确返回 200 OK。重投后 readonly 核对付款、积分批次、事件与初始快照完全 deepEqual：各一条，付款仍为 `one_time / succeeded / 1000 USD`（最小货币单位），唯一 `purchase` 批次 `amount = remaining = 1000` 且关联原付款，事件仍 `processed / attempts = 1 / processed_at = 2026-10-09T05:00:14.299Z`；UI 余额仍为 1000。小额测试积分包购买、同事件去重及 Cron 心跳三项均通过，Neon 任务 9.1 已完成，Neon change 最终为 28/29，仅24 小时观察（9.2）保持未完成。

验收汇总为 `/tmp/cloud-staging-neon-purchase-acceptance.json`，只读前后快照为 `/tmp/cloud-staging-neon-payment-before-resend.json`、`/tmp/cloud-staging-neon-payment-result.json`，CLI 重投提交记录为 `/tmp/cloud-staging-neon-stripe-resend-result.json`，当时健康记录为 `/tmp/cloud-staging-neon-final-health.json`。CLI 退出 0 仅证明提交成功；endpoint 200 由 Workbench 独立观测确认。以上证据仅含公开 ID 与测试数据。

退款、订阅、PayPal 购买及完整业务回调录制仍待 P2 完整门槛核验；本轮有限联通不能作为全量 P2 支付验收。不在聊天、日志或 git 中传递密钥。

按 [支付联通步骤](p2-payment-integration.md) 保存已有同步证据并核对完整门槛，再走测试卡、测试时钟和 PayPal 沙箱的完整业务场景。完成 P2 tasks 1.3、3.2、3.3、10.1、10.4、11.1，回写 Q4/Q5/Q6 后才归档 P2；上述 Neon 任务通过不能替代 P2 11.1。OAuth 继续 mock，邮件继续 log；不接入 live/production。
