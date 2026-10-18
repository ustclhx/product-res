# Selfhost PG17 指定时间点恢复

`deploy/selfhost/restore.sh` 是 Python 3 标准库与 Docker Compose v2 的宿主编排入口。
它只创建一个 PG17 实例和新命名卷，不启动 web/jobs、迁移、邮件或支付任务。
PG仅监听容器内 Unix socket，无 TCP监听或宿主端口，归档写入关闭；S3仅用
`backup-list`、`backup-fetch`、`wal-fetch`读取。恢复完整 cluster，包括角色、业务、
`job_engine`、`dbos`，默认达到指定时间点后 **pause**。不会自动选择 LATEST、promote或切流量。

## 新服务器准备

独立安全保存与所选恢复点匹配的应用/PG镜像完整SHA或digest、部署bundle、数据库
角色材料、secret、S3 CA与证书；本机先拉取匹配的PG17镜像。入口设置pull_policy=never，
不在恢复中拉取可变tag或构建源码。它验证镜像PG17和解出的PG_VERSION，并从
pg_controldata读取源集群的共享内存参数，避免hot standby连接/worker参数小于源值。

S3恢复身份只需所选prefix的List/Get，不授予Put/Delete。恢复配置与主备份配置
隔离；切换第二目标时只传其独立文件和CA，不传主目标凭据。两个secret为文件，
仅移除一个末尾LF；遵守现有[walg文件校验](selfhost-backup.md)。目录0700，secret
文件0600，由UID999或精确ACL可读。密钥值不得在argv、Compose environment、报告
或shell历史中出现。S3 CA必须受信，HTTPS hostname/证书验证不能关闭；HTTP仅隔离夹具使用。

创建只含非敏感键的 `/restricted/restore-s3.env`，文件不执行shell展开，不支持export或引号：

```dotenv
BACKUP_S3_ENDPOINT=https://s3.example.test
BACKUP_S3_REGION=region-1
BACKUP_S3_PREFIX=s3://backup-bucket/unique-cluster/pg17
BACKUP_S3_FORCE_PATH_STYLE=true
```

可额外配置BACKUP_DISK_RATE_LIMIT、BACKUP_NETWORK_RATE_LIMIT。
拒绝任何未列出的键（特别是凭据、profile、应用环境）。secret和CA另行只读挂载。
容器包装器关闭metadata/profile探测；源postgresql.auto.conf清空并使用本次可信恢复
配置，不继承原归档命令、连接信息或恢复目标。生产PG TLS证书不用于这个socket-only
临时实例；真正接流量时必须重建生产TLS/SCRAM配置。

## 恢复与校验

只接受明确的ISO UTC时间，秒精度或最多六位小数，后缀Z或+00:00。
backup ID必须为`base_<24位大写hex>`，且清单中的base完成时间不晚于目标。
WAL/history必须覆盖目标前后的提交边界；目标超出实际链或缺段非零退出，不降级
到最新/其他时间。report的actualReplayTime表示最后已重放事务时间，可能早于target，
replayLsn标识实际恢复位置；不能把最后事务时间称为精确wall-clock目标。

项目名必须`selfhost-restore-`开头，建议带worktree名及随机后缀；卷固定为
`<project>-pgdata`，必须此前不存在。`--state-dir`必须是已有真实父目录下的**全新路径**，
拒绝已有目录、symlink或含symlink/..的父路径；macOS临时目录可先用realpath得到真实父目录。
不提供生产卷、bind数据目录或覆盖开关。状态目录0700，保存Compose、锁、脱敏报告，
不保存secret内容或SQL结果正文。所有后续操作共用operation.lock。

```sh
# 替换占位路径、固定PG镜像digest以及显式backup/UTC时间。
deploy/selfhost/restore.sh \
  --s3-env /restricted/restore-s3.env \
  --access-key-file /restricted/secrets/restore-access-key \
  --secret-key-file /restricted/secrets/restore-secret-key \
  --ca-file /restricted/s3-ca.pem \
  --image registry.example.test/project-postgres@sha256:<64hex> \
  --backup-id base_<24HEX> --target-time 2026-10-14T10:00:00.123456Z \
  --project selfhost-restore-d-restore-example \
  --state-dir /restricted/restore-example \
  --database product_res_production --checks-file /restricted/restore-checks.json
```

恢复后执行PG17、public/job_engine/dbos schema及表、约束、三角色非管理权限、
数据库/表权限检查。默认creditsEnabled=true，使用
`packages/credits/src/queries.ts:reconcileWorkspaceCredits`相同SQL不变量：
每个空间ledger delta总和等于全部active grant remaining＋held amount－debt；
尚未执行expire的elapsed active grant仍计入，与业务对账一致。暂停恢复不可写，
因此无需执行原业务对账函数中的锁/事务写入。关闭积分的模板必须显式false。

配置checks文件是本地受信材料，SQL通过stdin在READ ONLY事务运行，期望恰好`t`，
不打印数据正文。仅允许单条SELECT/WITH且禁止分号及psql反斜杠命令。
必须按所选恢复点验证真实业务、引擎inbox/checkpoint/event/调度内容与schema/ACL快照，
基础目录检查不能替代数据快照验证。例如夹具检查文件：

```json
{
  "creditsEnabled": true,
  "checks": [
    {"name": "marker_before", "sql": "SELECT EXISTS(SELECT 1 FROM public.backup_marker WHERE id='before')"},
    {"name": "marker_after", "sql": "SELECT NOT EXISTS(SELECT 1 FROM public.backup_marker WHERE id='after')"},
    {"name": "task_state", "sql": "SELECT EXISTS(SELECT 1 FROM job_engine.backup_task WHERE id='fixture' AND status='pending') AND EXISTS(SELECT 1 FROM dbos.backup_task WHERE id='fixture' AND status='pending')"}
  ]
}
```

成功打印元数据并写`report.json`，status=validated_paused，包含backupId、targetTime、
clusterId、actualReplayTime、replayLsn、elapsedSeconds和每个检查的布尔结果。
失败status=failed、固定error code，保留自己的实例/卷/状态以便检查，不输出原始PG/S3日志。
重点错误：RESTORE_STATE_PATH_NOT_NEW、RESTORE_VOLUME_EXISTS、RESTORE_BASE_AFTER_TARGET、
RESTORE_CHAIN_OR_TARGET_INSUFFICIENT、RESTORE_TARGET_NOT_REACHED、RESTORE_CHECK_FAILED、
RESTORE_SOURCE_SETTINGS_MISMATCH。缺WAL与越界可能同属链不足，不能由该错误码推定是哪一种。

```sh
# 重新校验仍暂停的实例；随后显式promote前再次执行同一校验。
deploy/selfhost/restore.sh check --state-dir /restricted/restore-example
deploy/selfhost/restore.sh promote --state-dir /restricted/restore-example
# 只移除owner token匹配的容器/卷/自建网络，保留report；失败资源也用此入口清理。
deploy/selfhost/restore.sh cleanup --state-dir /restricted/restore-example
```

promote直接调用pg_promote，不先resume重放，避免目标点被额外WAL越过；promote后仍
socket-only、归档关闭且无jobs。此命令**不切流量**。切入生产前独立重建TLS、精确
角色secret、目标应用版本和全新归档prefix，核对对象一致性，再按获准发布流程操作。

## 可重复隔离演练

先由隔离夹具产生目标前/后marker，完成真实base/WAL归档，记录目标UTC与base ID；
不能用改数据或假报告替代重放证明。`restore-drill.sh`参数与恢复相同，要求显式
checks-file至少一个业务布尔检查，应包括前marker存在、后marker缺失及引擎状态。
成功写报告并清理**自己**的资源；失败留卷与元数据，按上面cleanup清理。每次用
新的project/state-dir，避免重用历史资源。生产服务与卷不加入演练项目。

```sh
deploy/selfhost/restore-drill.sh \
  --s3-env /restricted/drill-s3.env \
  --access-key-file /restricted/secrets/drill-access-key \
  --secret-key-file /restricted/secrets/drill-secret-key --ca-file /restricted/drill-ca.pem \
  --image registry.example.test/project-postgres@sha256:<64hex> \
  --backup-id base_<24HEX> --target-time 2026-10-14T10:00:00Z \
  --project selfhost-restore-d-restore-drill-example \
  --state-dir /restricted/drill-example --checks-file /restricted/drill-checks.json

python3 -m unittest discover -s deploy/selfhost/backup -p restore_test.py -v
node deploy/selfhost/test-backup.mjs --restore
```

本地夹具可额外传`--network <fixture-internal-network>`，入口强制验证Internal=true，
只共享S3夹具内网，不清理该外部网络。未传时创建独立网络支持真实HTTPS S3出站，
无任何端口映射；其中仅PG恢复进程，不包含业务或外部API调用执行者。本地两个桶
只证明复制/恢复机制，不等同真实不同供应商、服务器重启或资源预算验收。

## ownership 与数据库外的边界

物理备份含旧任务/执行者数据库记录；不要原样复制旧机owner文件、不删除整个owner
目录、不用TTL、PID或锁消失伪造退出。jobs启用必须取得B/D可信异机退出证据和同版本
handler签收；此依赖未完成，数据库恢复校验仍可做，任务重新执行/服务器验收保持BLOCKED。

PG回退不回退用户S3对象、邮件、支付、Provider任务、webhook或其他第三方副作用。
独立保管用户对象备份与版本，核对DB引用、缺失/孤立对象、支付/订阅事实、任务Provider
状态与幂等键，防止重复扣款/邮件。凭据、TLS、ownership宿主环境、镜像和release清单
都需独立恢复；不能把数据库恢复成功当作整站上线或外部副作用一致性验收。

依据：[PG17 PITR与pause/promote](https://www.postgresql.org/docs/17/continuous-archiving.html)、
[备份配置及保留](selfhost-backup.md)、[保留链边界](selfhost-backup-retention.md)。

## 2026-10-15 正式发布镜像完整演练（D 6.2）

正式 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2` 镜像与同 SHA bundle 已在一次干净
夹具运行中完成四周 metadata 锚点保留、最老 weekly 主目标与仅第二目标独立 PITR，
两端业务/角色/真实 DBOS checkpoint、job_engine 与积分校验通过且 LSN 相同。
数据库恢复校验 RTO 为 8.203/7.837 秒，关闭主目标前确认链的观测 RPO 滞后 47.613 秒；
CPU/RSS/磁盘、日期模拟方法、首次夹具失败和清理记录见
[完整报告](evidence/selfhost/d-drill-2026-10-15/report.md)。
复现使用 `test-backup.mjs --release-drill --sha <正式完整SHA> --bundle-dir <同SHA目录>`。
这是小型本地独立 SeaweedFS 证据；真实供应商/服务器 7.2、异机 ownership 和生产规模
RTO/RPO 保持待办，不由数据库恢复校验代替。

## 2026-10-14 本机 arm64 交付验收

[脱敏证据](evidence/selfhost/d-restore-2026-10-14.json)记录两个隔离 SeaweedFS 实例、
独立凭据和全部自建资源清理。最终验证使用镜像内backup runtime（无`--dev-runtime`），
宿主Python3.9.6执行正式restore/drill入口，PG17.11/WAL-G3.0.8；这是本地机制验证，
不是同SHA的registry release或真实供应商/服务器签收。

基础为提交`1fe53d2eaeaa5fc649ef2c9bce3851dc0a8b03e6`加本PR最后的夹具验收改动。
PG、迁移和S3复用此前已构建的本地镜像；backup从已有固定底座重新COPY本PR runtime，
没有连接远端S3、服务器或拉取新的Docker Hub镜像。两种架构的新恢复路径已接入
`Selfhost images` smoke；本记录只证明本机arm64，PR的CI结果单独查验。

| 校验 | 主目标 | 第二目标（主PG、S3和backup均停止） |
| --- | --- | --- |
| 目标UTC | 2026-10-14T12:36:02.353457Z | 相同 |
| 最后重放事务UTC | 2026-10-14T12:35:49.235842+00:00 | 相同 |
| 重放LSN | 0/6085880 | 相同 |
| 恢复与校验耗时 | 8.099秒 | 8.888秒 |
| 前marker存在、后marker不存在 | 通过 | 通过 |
| 全schema/数据库ACL/三角色/任务状态/积分对账 | 通过 | 通过 |

任务状态包括真实job_engine inbox、event、wait、schedule和DBOS schema；演练不启动
jobs，不宣称未完成任务已重新执行或可信ownership已签收。全量复制清单包含base、
dump、WAL和真实promote产生的timeline history；初次已确认归档上界
`2026-10-14 12:36:04.251292+00`覆盖演练点，同步完成距该上界约40.22秒。
这些是小型本地夹具耗时，不是生产数据量或不同供应商的RTO/RPO承诺。

通过：显式promote、已有状态/卷拒绝、缺WAL/未来越界非零、失败drill保留报告和卷直至
显式清理；复制重复/中断后补齐/源删除不传播/第二目标故障可见且禁止主清理，主归档
独立成功。所有fixture容器/卷清理，未改生产资源。28个Python边界用例与根目录所有
规定检查通过；真实不同供应商7.2、ownership/服务器重启签收继续保持未完成。
