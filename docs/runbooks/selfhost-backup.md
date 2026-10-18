# Selfhost PG17 基础与逻辑备份

此入口对应 D 4.1–4.5；备份覆盖 PG 全集群，包括角色、业务以及 `job_engine`、`dbos`。
指定时间点恢复和隔离演练见 [恢复入口](selfhost-restore.md)，第二目标独立复制与恢复
见 [副本入口](selfhost-replica.md)。真实外部供应商和服务器验收保持待办；本地 S3
夹具只证明机制，不选定部署方的存储供应商。

## 配置与启动

PG 与 backup 工具安装固定 WAL-G **v3.0.8**，PG17 trixie 同一 multiarch manifest；
`install-walg.sh` 固定官方 amd64/aarch64 二进制 SHA256，构建中验证后安装。
工具和 PG 都以 **999:999** 运行。PGDATA 只读挂载给工具，运维连接经共享 Unix socket
与 peer 身份；四个已有数据库角色的权限不扩大，web/jobs 不获得 socket、备份密钥或
PGDATA。备份的管理身份必须独立于应用对象存储身份，限制到专用 bucket/cluster/pg17
prefix 的 List/Get/Put/Delete；不授予 bucket 管理权限。

复制 `.env.backup.example` 为本机配置（只填非敏感 endpoint/region/prefix 等）；
根据 `secrets.example` 创建 `backup_s3_access_key_id` 与 `backup_s3_secret_access_key`。
目录0700、文件0600，使用 UID999 属主或精确 ACL，使容器可读；Compose file secrets
不会自动转换属主。两个文件仅移除一个末尾 LF，空值、多行、CRLF、直接值和 FILE
同时提供均失败。不得使用 Docker ARG、命令参数或 env 示例保存密钥。

配置 `BACKUP_CA_FILE` 指向受信 S3 CA/bundle：公共 HTTPS 用操作系统 CA bundle，
私有 HTTPS 用其签发 CA。WAL-G 校验 CA 和 hostname，不提供关闭 TLS 校验的开关。
`BACKUP_ALLOW_HTTP=true` 仅供隔离本地夹具；官方 Compose 不暴露该选项。
关闭 EC2 metadata、共享 AWS profile 和继承的其他凭据，S3 endpoint、region、
`BACKUP_S3_PREFIX=s3://bucket/unique-cluster/pg17`、path-style 可独立配置。
不同 cluster 或 PG 主版本使用不同 prefix，禁止混用。

```sh
# 在 deploy/selfhost 中；所有镜像须取同一成功发布集合的完整 SHA/digest。
docker compose --env-file .env --env-file .env.backup \
  -f compose.yaml -f compose.backup.yaml config
docker compose --env-file .env --env-file .env.backup \
  -f compose.yaml -f compose.backup.yaml up -d
```

不加载 override 时备份保持关闭，原有部署启动方式可用。启用归档需要 PG 重启使
`archive_mode=on` 生效；override 复用生产卷，禁止 `down -v`。启用后 PG 使用
`selfhost-walg wal-push %p`，默认 `archive_timeout=60` 秒。上传失败非零，PG 保留未
归档 WAL 并重试，绝不删除本地待归档段。停止/重启保持同 project 和卷。

## 一处调度与手动操作

工具 PID1 是持久调度器，默认 **02:00 UTC**。`backup_state` 保存最近成功 slot；
首次启动/重启补跑尚未完成的最近 slot，成功 slot 不重复。失败默认每300秒重试。
同一卷只允许一个 scheduler（`scheduler.lock`），所有手动管理写与周期共享
`operation.lock`。不另设主机 cron、不扩大成多调度器。默认顺序 full base → dump →
归档完整性验证 → 保留 dry-run/确认；任一步失败，不更新周期成功 slot、不继续清理。

下面命令均需使用相同的 Compose 文件/env 参数；为简洁以 `docker compose` 表示：

```sh
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py cycle
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py base
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py dump
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py verify
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py retention-plan
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py retention-apply
docker compose exec -T backup selfhost-walg backup-list --detail --json
```

保留计划默认7天每日＋4个固定 UTC 周的第一份成功 full（周一0、周日6可调）。从
选中的最老 daily/weekly/permanent base 起，全部中间 base、WAL、history 保留，宁可
多占空间。详见 [保留边界](selfhost-backup-retention.md)。新 base 失败、未知/混合
cluster/timeline、归档缺段、陈旧/失败副本证明均拒绝删除。不得另跑 count-only retain、
garbage，也不得给桶添加独立按年龄删 WAL/history 的 lifecycle。不加载副本override时
第二目标显示 `not_configured`。启用后，副本复制必须完成真实对象大小/SHA256清单后
才能清理；不能编辑 state 的布尔字段绕过门禁。

## 逻辑备份与恢复材料

每日 `pg_dump --format=custom` 保存所选数据库的全部 schema，包含引擎元数据；
`pg_dumpall --roles-only` 保存角色、成员关系和密码散列。角色文件按 secret 保护。
空目标集群已有 postgres，因此材料省略重复 `CREATE ROLE postgres`，保留 ALTER。
ACL、对象属主与默认权限在 dump 中。用户对象文件、部署 secret、TLS、ownership
以及已发生的外部副作用不在 PG 备份范围，需独立保管和核对。

临时目录0700、文件0600；开始前要求空闲空间至少 `pg_database_size + 128 MiB`，
余量可调。base 流式上传，不存全量本地 base；dump 使用受限磁盘临时文件，先验证
`pg_restore --list`，再上传。成功/失败均清理临时文件，强制退出后的本工具遗留目录
由下一次持锁周期清理。磁盘预检是保守估算，实际写满仍失败，绝不记为成功。

远端布局：`logical/<UTC带微秒>/database.dump.lz4`、`roles.sql.lz4`、`manifest.json`。
WAL-G `st put` 默认压缩；`st get` 自动解压。manifest 最后上传，包含对象原始大小和
SHA256；无 manifest 的目录是未完成上传，不能消费。逻辑目录默认保留全部，避免
与物理链清理耦合；容量运维可在验证后独立清理完成的旧 logical 目录，建议至少35天，
不得套用到 `wal_005`、`basebackups_005` 或 history。

```sh
# 只下载到隔离受限目录；不将角色文件或dump正文打印到日志。
selfhost-walg st get logical/<id>/database.dump.lz4 /restricted/database.dump
selfhost-walg st get logical/<id>/roles.sql.lz4 /restricted/roles.sql
pg_restore --list /restricted/database.dump > /restricted/contents.list
# 新隔离PG17：先恢复角色，再由--create完整创建原名数据库并恢复对象/owner/数据库ACL。
psql -X -w -v ON_ERROR_STOP=1 -f /restricted/roles.sql
pg_restore --create --exit-on-error --dbname=postgres /restricted/database.dump
```

命令在受控工具/新隔离目标内执行，连接和密码仍走 peer 或文件；禁止对生产库运行。
逻辑备份用于离线检查、选表/迁移恢复，不能代替连续 PITR；跨 PG 主版本另行验收。

## 状态、告警与资源

```sh
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py status
docker compose exec -T backup python3 /usr/local/lib/selfhost-backup/backup.py health
docker compose exec -T postgres psql -X -w -U postgres -d product_res_production \
  -c 'select archived_count,failed_count,last_archived_wal,last_archived_time,last_failed_time from pg_stat_archiver'
docker compose exec -T postgres df -B1 /var/lib/postgresql/data
docker compose stats --no-stream postgres backup
```

状态列出最近 base/dump 成功、独立归档失败计数、验证后的连续段/切段采样时间上界、
副本未装配、周期 slot、`pg_stat_archiver`、PGDATA/WAL bytes 和空闲空间。上界先采样PG时钟，随后提交固定事务性WAL消息，再切段确认归档；空闲数据库也有
晚于上界的提交可命中时间恢复。最后并从最老保留 base 验证 FOUND 连续链，不是机器当前时间或最新
base 时间。恢复到具体时间仍需该点前后存在可重放提交并通过 PITR 演练；这是已归档
区间的保守采样边界，不承诺当前未封口 WAL 零损失。故障之后旧成功时间仍保留，
但 `ok=false` 与失败计数区分当前失败。历史 failed_count 不会因恢复成功而归零。

健康要求 base/dump/完整性验证在25小时内成功，PG可查询、最近归档没有未恢复失败。
没有首次完整成功时健康非零；Docker healthy 不能由“调度器进程存在”冒充。告警建议：
任一新失败立即检查、超过25小时无成功周期、WAL持续增长、空闲不足估算dump＋余量，
缺失周锚点需核对实际恢复覆盖；目标不可达时先修存储/权限/CA，不删除 pending WAL。

工具限额384MiB/0.2CPU，lz4，上传/磁盘读取/下载并发各1，默认磁盘和网络各10MiB/s。
PG最大100连接保持不变；base与dump串行，工具主连接通常1，归档校验/PG查询最多2，
给web/jobs各10与迁移留下预算。外部S3基础Compose常驻内存限额加backup为3712MiB；
migrate额外512MiB、宿主和缓存仍需余量。自带存储profile另增资源，不能凭限额总和
宣称2核4GB整机验收；同负载的CPU/RSS/连接/WAL/磁盘峰值见本地验收记录。
Docker json-file默认10m×3，45秒停止宽限；常驻unless-stopped，成功迁移不循环。

## 重复验证与边界

```sh
python3 -m unittest discover -s deploy/selfhost/backup -p '*test*.py' -v
# 先本机构建同SHA的postgres/backup及已有fixture配套镜像；不触及其他worktree容器。
node deploy/selfhost/test-backup.mjs
```

`test-backup.mjs` 创建含 `d-backup` 的随机独立 project/卷，internal网络、无宿主数据
端口、随机临时 file secrets、自签 TLS；仅清理自己资源。覆盖真实 base/WAL/dump、
隔离逻辑恢复、最老 weekly PITR、删除语义、TLS/密钥失败、上传/磁盘/归档故障与重启。
日期边界由隔离fixture元数据模拟，真实WAL/目标marker不改，不宣称已运行四周。
夹具PG的 `archive_timeout` 会在任意时刻归档新WAL段，对象清单比较只允许新增WAL段，
既有对象不得删除或改写；重复副本同步的复制数须恰为这些新段。失败时 image smoke
只附加 `backup-smoke.json` 中的固定 phase/reason，不透传命令原始输出。
amd64使用 `Selfhost images` 的原生CI矩阵；本机arm64实际记录及CI链接见交付记录。
正式远端存储、不同供应商、真实服务器/PITR/reboot仍未获资源，保持待办。

资料：[PG17连续归档](https://www.postgresql.org/docs/17/continuous-archiving.html)、
[WAL-G v3.0.8 PG命令](https://github.com/wal-g/wal-g/blob/v3.0.8/docs/PostgreSQL.md)、
[S3配置](https://github.com/wal-g/wal-g/blob/v3.0.8/docs/STORAGES.md)。

## 2026-10-14 本机 arm64 验收记录

以基线 `65c0413794f408259682c9c6afdf2c4364fbfdac` 加本工作树备份改动构建 PG/backup，
独立夹具复用 #172 已测的 migrate/object-storage 镜像。仅测试资源在本机运行；这不是
正式 release SHA 或 registry 发布。full先以镜像内工具代码验证完整链，再以只读开发runtime补验实际业务SQL/DBOS迁移、
完整schema清单与数据库ACL；重建工具镜像后以镜像内代码重复smoke。两次full的
`backup-smoke.json` passed/cleaned 均true，夹具容器/卷均清理。
工具 WAL-G3.0.8、Python3.13.5、PG17.11；Docker29.1.3、Compose2.40.3-desktop.1。

通过：UID999文件secret/TLS拒绝与自签CA、真实full/WAL/dump上传、实际SQL/DBOS迁移后的全schema逻辑恢复、数据库ACL与
三角色权限、成功slot重启不重复、缺段拒绝清理、40天旧base实际删除且21天weeklybase
及后续连续WAL保留、从最老weekly真实PITR前marker存在/后marker不存在、promote后真实
history归档。日期仅在隔离metadata模拟，cluster的64位身份精度保持，真实WAL不改。
另外按 `2026-10-14 10:12:01.882799+00` 的验证上界成功暂停恢复，verify之后没有业务
写入，证明空闲数据库也有后继提交支持时间目标。

磁盘阈值不足、TLS代理停止、新base/dump失败均非零，状态累计失败且不删除可用链；
待归档 `.ready` WAL保留。恢复代理后PG自然重试成功（历史failed_count保留），dump恢复。
副本失败/陈旧/上界不足由精简单元用例验证拒绝删除，未实现第二供应商同步。
14个Python边界用例及4个镜像发布策略用例通过。

以下是小型业务/引擎fixture的约1秒采样最大值，含采样开销；RSS为各进程RSS之和，
共享页可能重复，cgroup峰值才是容器内存预算依据。不能据此替代真实整机负载验收。

| 服务 | RSS和峰值 MiB | cgroup峰值 MiB | CPU采样峰值（单核100%） |
| --- | ---: | ---: | ---: |
| postgres | 108.28 | 203.54 | 11.34% |
| backup | 81.75 | 87.44 | 18.57% |
| SeaweedFS夹具 | 210.65 | 166.10 | 3.72% |
| TLS夹具 | 79.03 | 36.35 | 2.75% |

主库最多8连接，WAL目录峰值96.00MiB，PGDATA峰值128.86MiB；工具256MiB夹具限额下
无OOM，生产配置384MiB。fixture使用独立恢复实例但不会把该过程的资源算作2核4GB
整机证明。实际S3供应商、第二账号、服务器和amd64保持对应任务未完成；amd64由PR的
`Selfhost images` 原生矩阵运行真实smoke，artifact含backup-smoke.json。

本机 `images/check-bases.mjs` 在 Docker Desktop 读取 Node基础manifest 时120秒超时，
已停止该步；基础digest未更换，两个架构的manifest检查留Selfhost images CI。未据此
勾选4.1，也未将本机证据当作正式镜像发布。
