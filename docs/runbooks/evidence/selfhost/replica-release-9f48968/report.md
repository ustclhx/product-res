# 9f48968 正式升级与副本健康验收

目标为 `ssh product-res-ecs` 的 `/opt/product-res-selfhost`，项目固定 `product-res-selfhost`。
从正式 `1888e7d165b0b87784e7d16a4c39709a9bc063e3` 升级到
`9f48968f1eb64a3c128a5ec4b78c0f0796ec2454`。本次升级和健康预算更新由协调者明确授权。
未初始化主机、未重启宿主或Docker、未修改其他项目、未删除卷。

## 发布与部署

来源为成功的 [selfhost-publish run 39046130395](https://github.com/ustclhx/product-res/actions/runs/39046130395)，
namespace `ghcr.io/ustclhx/product-res`。八服务集合均包含amd64/arm64。
直接下载同run的image-set与release tar，包内校验器verify及干净Compose渲染均通过，
未重建、重打包或修改已发布bundle。来源、digest、artifact hash见[provenance.json](provenance.json)。

主机原计划为`compose.yaml + compose.s3.yaml + compose.backup.yaml + compose.replica.yaml`，
读取`.env + .env.backup + .env.replica`。升级保留该组合及项目名，外部S3模式没有启动本地对象服务。
使用新bundle原版入口：

```sh
<verified-bundle>/deploy.sh --host product-res-ecs --dir /opt/product-res-selfhost \
  --sha 9f48968f1eb64a3c128a5ec4b78c0f0796ec2454 --bundle <verified-bundle> \
  --compose-file compose.s3.yaml --compose-file compose.backup.yaml \
  --compose-file compose.replica.yaml --env-file .env.backup --env-file .env.replica
```

入口拉取、核对revision、排空旧web/jobs、启动数据依赖、重跑目标迁移、启动应用和backup，
默认360秒web/jobs readiness门通过，退出码0，successful/schemaSha更新为目标SHA。
`previous`保留1888e7d。新bundle未声明兼容回滚列表，没有绕过门或修改发布材料。
本次源版本差异不含DB schema或生产handler修改，仍执行了标准迁移gate。
部署事件见[deployment.json](deployment.json)，正式HTTPS及jobs内部readiness、七个实际部署服务的
目标digest/revision与amd64架构见[readiness.json](readiness.json)。

## 健康预算与故障事件

`.env.replica`中唯一的`BACKUP_REPLICA_MAX_AGE_SECONDS=900`原子更新为3600，
同步间隔仍为300秒，保持原0600权限与属主，其他行不变；没有修改凭据、endpoint或已发布Compose。
见[budget-change.json](budget-change.json)。主备份25小时、WAL规则、retention的900秒证明门均未改动。

使用**新正式backup容器内的原版`backup.py replica-sync`**验证故障事件。
探针在0700临时状态目录读取生产状态的原子快照，只对该副本写入；
使用进程级无效副本CA路径触发真实配置拒绝，不改容器持久环境、不写生产状态或远端对象。
探针退出1，副本ok=false，输出`level=error`、`code=invalid-s3-ca-file`的
`selfhost.backup.operation.failed`事件。输出在容器内对实际凭据、endpoint/prefix及签名特征
做脱敏检查后才导出；临时状态由探针清理。
这是正式CLI的隔离故障验证，不是让主调度器发生存储故障，也不是历史网络超时的复现。
见[error-probe.json](error-probe.json)。

配置只读核对确认两目标均为R2、同一endpoint、不同bucket和不同access/secret key；
未输出账号、桶名或凭据，也未更改token权限。此为同供应商账号下的独立凭据副本，
不具备供应商/整个账号失效的独立性；见[storage-isolation.json](storage-isolation.json)。

## 完整周期观察

升级前的旧backup不健康；升级后若旧进程留下未完成状态，新版不会借旧成功冒充完成，
必须等待一次新的完整提交。观察的是新SHA容器内主调度器的真实周期，没有手工改写状态、
回填时间、缩短复制内容或伪造成功。

新容器首轮从 `2026-10-17T16:16:13.372226Z` 开始，
在 `2026-10-17T16:37:29.589605Z` 完成，实际耗时 **1276.217 秒（约21分16秒）**。
该轮清单1583个对象，复制22个对象并完成校验/manifest提交；PID1输出
`selfhost.backup.replica.completed`、`ok=true`，见[backup-events.json](backup-events.json)。

连续采样24次，主备份/逻辑备份/verification一直成功，WAL连续失败数一直为0。
首轮完成前Docker曾因继承的未完成状态保守判不健康；完成后下一次探针退出0，
Docker `healthy` 且全局backup健康。历史 `REPLICA_S3_TIMEOUT` 清除，失败计数没有新增。
下一轮已真实开始，原始 `replica.ok=false` 保持“未完成不能成功”的规则，
health仅在持有真实复制锁、前次成功仍新鲜时保持健康；没有把运行中复制标成成功。
见[observations.json](observations.json)、[after.json](after.json)。

最终web/jobs依赖就绪、cron新鲜，六个常驻容器均healthy；一次性migrate退出0
（其继承的health标签不作为常驻服务验收）。七个原项目卷名不变且创建时间均早于本次升级，
见[volume-preservation.json](volume-preservation.json)。

## 范围与后续

本报告验证本次正式升级、备份健康及失败日志，不替代既有PITR/整机恢复证据，
不承诺同步间隔等于RPO，也没有为增长中的对象清单自动放宽阈值。
原历史单次`REPLICA_S3_TIMEOUT`的底层原因无法从旧日志还原，本次没有假称复现。

## 本地检查

`pnpm check`通过（4条已有非阻断告警），`pnpm typecheck`14/14通过，
`git diff --check`通过；本次仅新增脱敏证据，不修改生产代码或测试断言。
