# 副本健康告警诊断（2026-10-17）

目标：`ssh product-res-ecs`，仅 `product-res-selfhost` 项目。运行 revision 为
`1888e7d165b0b87784e7d16a4c39709a9bc063e3`。
本轮只执行容器 inspect/status/health、日志汇总及现有凭据下的 List/Get。
没有修改服务器配置、secret、对象或状态，没有重建/重启服务，也没有删除卷或数据。

## 已证实的原因

- `backup.py health` 返回1，容器 unhealthy；base、dump、verification均成功，
  主归档连续失败数0、PG archived_count=1466、failed_count=0。
- 实际 interval=300秒、max_age=900秒，两端网络限速均10MiB/s。所谓约19分钟的
  “间隔”是完整同步完成之间的距离，并非部署把interval配置为19分钟。
  最近完成时间13:57:05、14:16:03、14:35:08 UTC，相差约1138/1145秒。
- 14:51:53 UTC采样时，replica.lastAttempt=14:35:43、running=true、ok=false，
  上一成功14:35:08，consecutiveFailures=0。`operation()`每次开始同步就把ok置false，
  health又要求ok=true，因此长时间刷新期间，即使有已验证且仍有效的旧副本也会不健康。
  此外完整同步本身已超过900秒，原阈值无法覆盖实际成功间距。
- 同步对全部对象逐个校验源一次、目标最多三次，每个请求单独建连接，单并发。
  只读采样主目标约1493个对象、242MB，副本约1479个对象、240MB。
  数据量不大但数千次串行请求会累加延迟。代码和现有耗时共同支持这是主要耗时来源；
  本轮没有做全量trace或并发改造，不将其视为精确性能分解。

这属于健康状态模型和默认容量预算不匹配，并非主机interval误配。
修复保留所有对象内容SHA256、完整清单和独立保留校验，不用跳过验证来缩短周期。

## 历史 REPLICA_S3_TIMEOUT 的事实与限制

状态中的lastError来自2026-10-16 19:42:14 UTC的单次失败；之后已有成功，
当前是运行中而非连续超时失败。24小时日志含157次replica.completed、1次replica.failed。
失败事件确实存在，但仅含event/ok，缺少level、code和目标/方法/阶段；成功也未清除旧lastError。

`REPLICA_S3_TIMEOUT`只在`S3.request()`的请求发送（含DNS/连接/TLS/PUT）或响应头等待
遇到TimeoutError时产生，socket超时固定30秒；它不是19分钟的整轮运行超时。
响应正文读取超时会使用另外的下载/清单错误码。上传/下载均单并发，无并发洪峰证据。
最大原始对象25,535,244字节，主/副本读取耗时2.529/2.614秒；List耗时0.806/1.613秒。
当前相同身份的List/Get正常，无HTTP401/403；没有证据支持对象过大或token持续失效。
本轮不为诊断试写正式副本，历史成功同步只能证明当时Put已被接受。

**尚未确定**：历史那一个请求的具体目标、方法、对象、超时阶段及底层网络原因。
现有日志无法恢复这些信息，只读探测也未复现；不能声称已证实R2故障、token错误或
需要放宽30秒超时。因此保留原超时、不添加自动重试，用新增脱敏请求事件支持再次发生时定位。

## 本地修复与安全边界

- 每次副本刷新立即置ok=false，旧成功时间与manifest元数据保留；仅在本次刷新从
  成功状态开始且内核锁仍证明它活跃时，health按旧lastSuccess检查新鲜度。
  首次无成功、失败、未来时间和超过预算均不健康；中断释放锁后不能借旧证明放行。
  初版直接保留ok=true造成SIGKILL误报的回归与补正见[CI中断回归补正](ci-interruption-correction.md)。
- 默认max_age改为3600秒，至少为interval的3倍；运维还需按
  interval＋完整sync＋verify/锁等待/调度余量核对预算。记录lastDurationSeconds和有效maxAgeSeconds。
- 所有操作失败输出level=error和脱敏错误码；请求传输失败额外输出目标角色、
  方法、阶段、PUT字节数。无URL、bucket/key、签名、凭据或原始异常正文。
  成功清除当前lastError，保留历史失败次数/时间。
- base/dump/verification健康规则、WAL判断、主retention证明900秒有效期、完整链和
  大小/SHA256校验不变。没有传播副本删除，也没有放宽清理门禁。

## 验证

- `openspec validate --specs --strict`：44/44；七份spec只增加Purpose句子，
  `## Requirements`之后与修改前逐字相同。
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/selfhost/backup -p '*test*.py'`：32项通过。
  健康与错误日志回归用例先在旧实现失败，再修复通过；覆盖刷新中健康、陈旧/失败拒绝、
  失败日志脱敏、socket超时阶段，以及主安全门不受副本预算影响。
- `pnpm check`、`pnpm typecheck`：通过（Node22；typecheck为14项已有Turbo缓存）。
- 基础＋backup＋replica三个Compose文件使用无真值example渲染通过：interval=300、max_age=3600。
- 首次全仓测试25/26任务成功；web的两个路由注册用例因本worktree缺少被忽略的
  `routeTree.gen.ts`失败（typecheck命中共享缓存，没有本地生成产物）。执行现有
  `pnpm --filter @product-res/web exec node scripts/generate-route-tree.mjs`后，定向两个用例通过；
  没有修改应用源码。使用Node22与`NODE_OPTIONS=--no-experimental-webstorage`
  重跑`pnpm test`：26/26任务成功（22项缓存），web 65个文件/428项全部通过。

## 未完成与发布门

**阻塞：需发布含修复的新 SHA。** 镜像内部Python及受校验Compose均需新正式同SHA
image-set/bundle。本轮没有触发发布或修改1888e7d已发布材料，到此停止主机操作。

发布后由协调者核对本机`.env.replica`显式旧值900，并按实测预算改为3600或更合适的值；
新bundle默认值不会覆盖本机旧值。通过既有发布流程部署后，需观察至少一个完整同步周期，
确认刷新期间health稳定、真实失败仍立即告警、主归档不变，再签收主机验收。
历史单次socket超时的底层归因仍未解决；若复现，使用新增脱敏事件继续定位。

原始脱敏元数据见[主机快照](host-snapshot.json)与[只读探测](read-probes.json)。
