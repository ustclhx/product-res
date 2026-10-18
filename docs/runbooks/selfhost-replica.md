# 第二目标独立恢复副本

`compose.replica.yaml` 加载在 `compose.backup.yaml` 后，复制 `basebackups_005`、
`wal_005`（包括 timeline history）和 `logical` 的原始压缩对象，路径保持不变。
复制使用 Python 标准库的 S3 SigV4 HTTP 请求，不依赖 WAL-G 的解压/重压缩行为。
正式不同供应商账号验收仍属任务7.2；本地两个隔离实例只证明机制。

## 配置与权限

将 `.env.replica.example` 复制为本地 `.env.replica`，按示例设置独立 endpoint、
region、prefix、path-style 与受信 CA。创建两个独立文件 secret：
`secrets/replica_s3_access_key_id`、`secrets/replica_s3_secret_access_key`，0600且
UID999可读。不得用主账号或应用对象存储账号。第二凭据只挂载到 backup 工具，
PG 的主归档 wrapper 没有副本凭据，也不调用复制。
第二目标仅授予专用 prefix 的 List/Get/Put，无须 Delete/bucket 管理权限。
主复制读取身份须具备主 prefix 的 List/Get；备份写入继续使用既有主身份。

```sh
# 在deploy/selfhost运行；加载同SHA镜像集合与既有backup配置。
docker compose --env-file .env --env-file .env.backup --env-file .env.replica \
  -f compose.yaml -f compose.backup.yaml -f compose.replica.yaml config
docker compose --env-file .env --env-file .env.backup --env-file .env.replica \
  -f compose.yaml -f compose.backup.yaml -f compose.replica.yaml up -d backup
```

`BACKUP_REPLICA_ENABLED=true` 启用副本。第二组变量为
`BACKUP_REPLICA_S3_ENDPOINT/REGION/PREFIX/FORCE_PATH_STYLE/CA_FILE` 与
`BACKUP_REPLICA_S3_ACCESS_KEY_ID_FILE/SECRET_ACCESS_KEY_FILE`；缺项直接失败，
不回退到主身份、不访问AWS metadata/profile、不继承代理或应用凭据。
只允许 HTTPS、CA和hostname校验；`BACKUP_REPLICA_ALLOW_HTTP=true` 仅隔离夹具使用，
正式Compose不暴露该选项。同 endpoint/bucket 下重叠prefix拒绝，防止写回主目标。

## 同步、完整性和 RPO

每日 cycle 完成base/dump/归档verify后同步，副本完整提交才运行主保留清理。
手动base或dump也会verify并同步。单独补齐步骤在同一Compose参数下运行：

```sh
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py verify
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py replica-sync
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py status
```

同一持久调度器默认每300秒 verify+同步，所有操作共用 `operation.lock`，没有第二
cron。周期失败和副本失败均非零且可查询。健康要求已验证副本成功且不超过
`BACKUP_REPLICA_MAX_AGE_SECONDS`（默认3600秒）。该值至少为同步间隔的3倍，
还须覆盖间隔＋完整同步耗时＋verify/锁等待/30秒调度步长及余量；不满足最小比例
时调度器和health拒绝配置。间隔从尝试开始计时；一次同步超过间隔后，调度器会在
本轮完成后的下一个步长再次运行，不代表每300秒一定能提交一次完整副本。
每次复制开始就持久化`replica.ok=false`，只在本次完整提交和校验后置true。
health仅在本次刷新从成功状态开始、仍持有`replica.lock`排他锁且旧证明未过期时，
继续按原lastSuccess判断健康；这不改变status中本次复制的ok=false或retention门禁。
没有成功、上次失败、成功时间在未来或超过阈值仍不健康。
SIGKILL/crash释放内核锁，即使残留running=true也不能通过health；超时/异常同样保持ok=false。
首次/失败重启自动补跑。PG wal-push始终独立，副本宕机不阻止主归档；
副本失败使每日cycle失败且禁止主清理，修复目标/CA/权限后重试。

`state.replica.lastDurationSeconds`记录最近成功同步耗时，供容量与健康预算评估。
健康预算不是恢复RPO承诺；base/dump/verification的25小时判断、WAL归档判断及
retention中900秒证明有效期均不变，不因健康预算增大而允许删除陈旧证明下的数据。
对象与延迟继续增长时应复核带宽、全量校验成本和实际恢复覆盖，不自动增大阈值。
升级时检查本机`.env.replica`：显式旧值900不会被新bundle默认值覆盖；按测量结果
设置预算（本次约19分钟同步可采用3600），随含修复的正式新SHA部署。
不能修改旧bundle或镜像内脚本现场热补丁。

操作失败输出`selfhost.backup.operation.failed`，包含`level=error`、操作名与固定错误码；
周期失败另有`replica.failed`/`cycle.failed`摘要。S3请求阶段的传输失败额外记录
`replica.request.failed`，仅含目标角色、方法、阶段、PUT字节数和错误码，不含端点、
对象key、签名、凭据或原始异常。请求/响应头阶段的30秒socket超时映射为
`REPLICA_S3_TIMEOUT`，它不表示整次同步超时；正文读取失败使用独立的下载错误码。
成功后清除当前`lastError`，保留历史失败次数与时间，避免把已恢复的历史超时误判为当前故障。

复制分页读取真实对象清单，每个对象下载到0600临时文件（最多一个对象），
计算原始压缩内容大小和SHA256，读取目标比较；缺失或不一致则上传，再读取校验。
multipart ETag不作为checksum。临时空间需要最大单对象大小+16MiB；不足直接失败，
临时文件正常/失败均删除。单对象流式内存使用1MiB，串行请求，30秒socket超时；
GET/PUT对象正文执行实际速率限制：主读取服从`BACKUP_NETWORK_RATE_LIMIT`（默认10MiB/s），
第二目标服从`BACKUP_REPLICA_NETWORK_RATE_LIMIT`（默认10MiB/s），下载与上传串行，
因此不会叠加两个上传流。大对象需要足够临时磁盘，整个复制运行在既有backup CPU/RSS限制下。
每次重复同步仍完整读取源和目标的内容SHA256，并重读目标建立清单；源约读取一次、
目标最多读取三次，成本随全部独立保留对象增长，实际同步周期可能超过300秒。
新对象增加一次上传和校验读取，容量/带宽预算必须覆盖此完整校验成本。

最后对第二目标全部真实对象重新读取校验，生成 `replica/manifest.json`，含每个key、
bytes、SHA256、clusterId、timeline、最新/最老保留base、lastWal、continuousUntil、
完成时间、对象数量和syncLagSeconds。清单自身PUT后再GET校验SHA256，成功才写本地
`state.replica.ok=true`。失败保留旧成功时间/上界但标记ok=false并累计失败；不得编辑
状态绕过完整性门。中断可能留部分对象，重复同步校验后补齐，不提交乐观成功清单。

连续上界沿用PG采样→提交固定WAL消息→切段→确认归档的verify证明，要求从最老
保留base至lastWal的每段实际存在，两端对象内容相同，base目录与sentinel完整复制。
恢复上界不是复制机器当前时间。`syncLagSeconds`是完成时刻距该保守上界的间隔，
status的`currentLagSeconds`会随时间增加。RPO受归档封段、300秒同步间隔、对象数量、
下载/上传/校验耗时及故障影响，不能把定时间隔当作硬上限或承诺零损失。
完整PITR可用性仍须通过相同时间点恢复演练证明。

## 独立保留与源删除

第二目标策略固定为 `retain-all-independent`：保留全部base/dump/WAL/history，
不传播源删除，不执行Delete，不配置按年龄删除WAL/history的lifecycle。清单也包含
源端已删除但第二目标仍存在的对象。这是明确的独立保留策略，不使用主daily/weekly
清理计划直接操作副本。容量告警应按持续增长设置；当前入口不提供破坏性自动清理。
需要收缩容量时，先独立核验目标承诺区间与最老可恢复base，在另一个受控操作中
制定完整base+WAL/history保留计划、dry-run并实际恢复验收；禁止单独删旧WAL。

## 主账号失效时恢复

在新隔离恢复配置中，将第二目标各非敏感配置和独立file secret作为恢复的
`BACKUP_S3_*` 输入；恢复容器仅挂载第二凭据和CA、不挂载主凭据，网络禁止访问主
endpoint。读取第二 `replica/manifest.json` 的成功上界和backup ID，按
selfhost恢复runbook选择不晚于该上界的UTC目标并校验marker、全部schema、角色及任务
持久状态。第二目标路径无需重排，WAL-G backup-fetch/wal-fetch直接消费其原布局。
外部用户对象、部署secret/TLS、可信ownership退出证据与外部副作用仍须独立核对。

本地故障注入：停止第二TLS/存储实例后，确认PG主归档仍成功，replica-sync失败、
state副本ok=false且主retention拒绝删除；恢复实例重跑应成功。中断只结束本次sync
进程，再重跑检查清单与SHA256。删除隔离主对象后确认副本对象仍在、重复同步不删。
真实双S3与仅副本恢复由集成owner运行，不用mock代替该验收。
