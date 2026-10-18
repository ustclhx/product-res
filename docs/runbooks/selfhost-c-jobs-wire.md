# C 的 Node jobs 共享接线

生产入口仍为 `.output/server/index.mjs`。构建将 dynamic import 拆为独立 chunk，
`index.node.ts` 先校验配置并初始化唯一进程 observer，再加载 runtime/DBOS/SMTP/S3；
默认 CF 入口不加载 Node SMTP、S3 或 Sentry adapter。

`NodeJobsOptions.observer` 注入整个 queue callback、每个有效 email/billing 成员与
Cron 单元。成员 scope 在现有 ALS requestId 内创建，保留批次 jobId；外围 sink、consumer
和 Cron 错误主动采集后原样抛出。Node adapter 的同对象去重防止同一传播错误重复发送。
主动 retry 的错误也有采集点，事件只保留安全身份、机器码与源码 frames。

SMTP 配置由 `nodeEmailTransportConfig` 在业务池创建前转换，只在明确 smtp 通道创建
`createSmtpSender` 并注入现有消费者。smtp 缺 sender 会立即失败，不能回退 Resend。
渲染、from/replyTo、headers 与稳定消息身份继续使用既有实现；SMTP 的稳定 Message-ID
不代表去重，DATA 接受后确认前故障可能造成重复投递。

S3 配置完整时，jobs 仅装配删除能力。既有 string|string[] 在 composition 逐 key await；
失败立即传播，未删除对象仍由既有清理锚点保留。未配置时跳过十分钟文件清理，已装配时
运行原任务；媒体 Workflow gate、B 的 5.3/5.4 和任务勾选均未改变。

停机沿用 A 的同一个绝对 deadline：停止领取、DBOS 排空、关闭业务/缓存池，再用剩余
时间 close observer。显式 race 防止监控延长预算，剩余为零跳过 SDK close（SDK 的
close(0) 表示无限等待）。超时可能丢失尚未发出的监控事件，不额外分配 flush 时间。

## 独占 Docker fixture

```sh
pnpm --filter @product-res/jobs test:node
node apps/jobs/test/run-node-integration.mjs test/node-smtp.integration.test.ts
node apps/jobs/test/run-node-integration.mjs test/node-observer-shutdown.integration.test.ts
```

runner 创建仅 loopback 随机端口的 PostgreSQL 17、Valkey 8.1.6、Node 22.23.3 SMTP fixture，
容器名均含 `selfhost-c-wire-jobs`，退出或 SIGTERM/INT 清理自己创建的容器。
PG trust 只属于此临时独占环境；业务仍用 app DML 角色，migrator 单独执行现有业务及
DBOS 迁移。旧 Node integration 的默认 include 不要求 SMTP；只有 runner 提供明确
`JOBS_SMTP_PORT` 和 `JOBS_SMTP_CONTROL` 才纳入 SMTP 两个 fixture，缺项不伪造通过。

本批证据：65 个 Node unit 与 jobs typecheck 通过；SMTP、shutdown 和原 production
共 3 文件 5 用例通过（74.20 秒）。SMTP 证明混合批次独立确认、451 暂时失败后以原
30 秒退避成功、550 永久失败持久 DLQ、构造已有五次持久状态后的第六次边界，以及真实
PG trigger 拒写 DLQ 后未提前确认；这不是完整六次生产退避时钟。原 inbox/DLQ 的权限和
保留期不变，生产 app 未取得 DDL 权限。

shutdown fixture 另以严格 exit 0 重跑：3 个真实生产 Node 子进程在实际 SMTP 失败采集后
发送 SIGTERM，覆盖可达、HTTP 接受但不回应、禁用 transport；1 秒 shutdown 预算均在
1.7 秒退出上限内，业务终态仍为持久 dead。单文件 3 用例通过（20.79 秒）。

主代理完成整个 runner：原 production、实际产物 debug ID envelope/shutdown、SMTP、原 Cron
wire 四文件六用例均通过，每文件独立 PG 数据库并重置 SMTP 捕获状态。原 wire 沿用真实
生产时钟，不修改任务重试、调度或 B 用例的全库计数断言。
没有真实 Sentry 项目或外部 SMTP 验收，2.5/3.4 保持待办；本地 transport 不能替代真实
source map 项目验收。
