# D 6.2 正式发布镜像的完整本地 PITR 演练

2026-10-15（Asia/Taipei；原始时间保留 UTC）。本次仅签收本地 6.2；真实独立供应商账号与服务器演练 7.2 保持待办。

## 来源与一次运行的边界

正式发布 [run 38624392597](https://github.com/ustclhx/product-res/actions/runs/38624392597) 成功，完整 SHA 为 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`。从该 run 下载 image-set 和 release tar；tar SHA256 为 `150ce38d6b5666b26dde432d3561db255e38030340f1d38b5f9294e793feef64`。包内原版 verify 与干净目录 compose-config 通过；四个执行镜像 postgres/backup/migrate/object-storage 均匿名按 digest 拉取，inspect 的 OCI revision 与发布 SHA 一致。完整八服务 digest、实际拉取和 bundle 校验记录见 [provenance.json](provenance.json)。额外拉取的 Caddy 未参加数据库演练。

验收夹具提交为 `8b1c3cf0c77c204aa0ebaf5284cbc6c06c03a0cd`，调用时整个 Git 工作树干净，`sourceDirty: false`。夹具版本与正式运行镜像版本分别记录。没有构建或 COPY 新 runtime，没有 `--dev-runtime`，没有修改正式 bundle；恢复与 cleanup 使用 bundle 内的 restore/drill 入口。TLS/S3 控制脚本只作为夹具挂载，生产迁移、WAL-G、备份/保留/副本及 PG 恢复代码来自正式镜像/bundle。

环境为 macOS arm64、Docker Desktop 29.1.3 / Compose 2.40.3-desktop.1、Node 23.11.0、pnpm 12.8.1。源 project 为 `selfhost-d-drill-d5321cb4c968`，恢复 project 均带 `selfhost-restore-d-drill-`。两个独立 SeaweedFS 实例具有各自对象卷和随机独立凭据；网络 internal，无宿主数据端口。没有连接服务器、staging 或真实存储供应商。

## 完整流程与校验

同一次 `--release-drill` 运行完成以下操作，原始结果见 [drill.json](drill.json)：

1. 正式 migrator 镜像执行实际业务 SQL 与 DBOS 迁移。直接 SQL fixture 向真实 organization、credit_grant/ledger、job_engine inbox/event/wait/schedule 以及 DBOS workflow_status/operation_outputs 写入持久数据；另有辅助 marker 表。这是数据库恢复验收，不声称任务曾由引擎执行或已完成异机 ownership 签收。
2. 正式 scheduler 补跑一个 daily full + custom dump + 角色材料 + WAL 验证周期。仅夹具将 daily 时间设为启动前一分钟，以便补跑；没有等待四周。逻辑完整恢复、数据库 ACL、app DML/非管理权限、readonly SELECT/拒绝写入、migrator DDL 均通过，重启后成功 slot 和 base 不重复。
3. 保留前真实生成五份 full；只调整隔离 S3 的 metadata start/finish 时间，分别模拟 40 天旧 base、9 月 21/28 日、10 月 5 日 weekly 与本周最新 base。真实 PG 时钟、base 内容、cluster ID、LSN、WAL 和目标 marker 均不改。原始/模拟时间与完整计划在 `backup.retention_plan`；7 天 daily + 4 周 weekly 均有锚点，missingWeeklyAnchors 为空。正式工具 dry-run 无删除，apply 实际删除过期 base，最老 weekly 和其后 WAL 保留。最老 weekly 的模拟实际年龄约 23.84 天，不宣称真实运行四周。
4. 从最老 weekly 真实 PITR，目标前 marker 存在、之后 marker 不存在；另在 verify 后无业务写入时按连续上界恢复通过。缺 WAL 拒绝清理；磁盘不足、S3 上传失败、新 base 失败均非零且不破坏可用链，未归档 WAL 保留。PG 自然重试归档成功；随后生成第六份成功 full，重新验证主链。
5. 同 SHA bundle 从该最老 weekly 恢复至下表目标，默认暂停，13 项检查全部通过：PG17、业务/引擎 schema 与表、约束、三角色权限、全部表名/数据库 ACL 快照、真实 DBOS checkpoint 与 job_engine 状态、前后 marker 和积分账本对账（ledger=17、active remaining=17）。随后仅隔离实例显式 promote；不启动 jobs，不接流量。
6. 第二目标完整复制 base/dump/WAL/history，按大小和 SHA256 校验并提交清单；重复同步、中断后补齐、第二目标故障与主归档独立成功、源删除不传播均通过。真实 promote history 专项在最后一次主链验证后产生并复制；混 timeline prefix 此后不再进行新的主 verify/retention。
7. 停止主 PG、主 S3、主 TLS 和 backup 后，第二恢复容器只挂第二目标凭据，经 bundle drill 独立恢复同一最老 weekly、同一目标点；相同 13 项校验通过，LSN 相同。未来越界、缺 WAL、已有状态/卷、故意错误业务校验均非零；失败 drill 的报告和卷保留至显式 cleanup。

| 项 | 主目标 | 仅第二目标 |
| --- | --- | --- |
| backup ID | `base_000000010000000000000007` | 相同 |
| UTC 目标 | `2026-10-14T22:08:08.319539Z` | 相同 |
| cluster ID | `7696648614416543780` | 相同 |
| replay LSN | `0/8002E80` | 相同 |
| 状态 | validated_paused | validated_paused，随后清理 |
| 数据库恢复并校验 RTO | 8.203 秒 | 7.837 秒 |

`actualReplayTime` 在两端原样为 null；不把它充当目标时间或 RPO。恢复点由暂停状态、LSN 与前后 marker 校验共同记录。这里的 RTO 仅含新卷创建、base/WAL 恢复和数据库校验，不含下载镜像、人工处置、应用启动、ownership、DNS 或切流量。

最后确认的连续恢复上界是 `2026-10-14 22:11:32.185425+00`；复制完成距该上界 46.391409 秒。关闭主目标前 `22:12:19.798Z` 的观测滞后为 **47.613 秒**。以两端均已确认的同一链保守记录本地 RPO 为 47.613 秒；指定目标的数据校验没有丢失。这是本次夹具观测，受故障注入、封段及完整复制校验耗时影响，不是生产 RPO 上限或零损失承诺，也不以 300 秒同步间隔当作硬保证。见 [resources.json](resources.json)。

## 资源与清理

约每秒异步读取 cgroup、进程 RSS、SQL、df/du；Docker 操作和同步夹具步骤会造成采样间隙。以下为各服务采样最大值，不是同时发生的整机峰值；RSS 和可能重复计算共享页，内存预算以 cgroup 为准。主/副恢复及六个常驻服务均有非空有效样本，观测未发生 OOM。

| 服务 | 有效样本数 | RSS 和峰值 MiB | cgroup 峰值 MiB | CPU 峰值（单核 100%） |
| --- | ---: | ---: | ---: | ---: |
| 主PG | 95 | 171.88 | 201.33 | 15.80% |
| backup | 95 | 136.19 | 89.52 | 20.72% |
| 主SeaweedFS | 95 | 237.23 | 217.45 | 6.70% |
| 主TLS fixture | 93 | 87.30 | 47.32 | 4.14% |
| 第二SeaweedFS | 102 | 207.94 | 166.62 | 2.62% |
| 第二TLS fixture | 101 | 88.11 | 52.16 | 5.62% |
| 主目标正式恢复 | 34 | 72.48 | 166.17 | 26.24% |
| 第二目标正式恢复 | 4 | 80.83 | 140.02 | 20.48% |

主库最多 8 连接，采样 PGDATA 峰值 129.54 MiB、WAL 峰值 96.00 MiB；主/副正式恢复 PGDATA 峰值分别 145.02/129.00 MiB。完整分阶段原始值及失败实例采样见 JSON。该小数据量本地结果不能替代 2 核 4 GB 整机或生产数据规模的容量验收。

所有演练容器、卷、网络已清理，现有容器 ID、运行状态、启动时间、卷挂载保持原样；见 [cleanup.json](cleanup.json)。首次组合运行因过早写入 timeline-2 history 被正式工具正确拒绝，已清理；原因和修正见 [first-failure.json](first-failure.json)，该次未作为通过证据。

## 复现与其余验证

先从可信成功 run 下载并校验同 SHA bundle/image-set，匿名拉取其四个执行镜像 digest；在已提交的干净 worktree 中运行：

```sh
node deploy/selfhost/test-backup.mjs --release-drill \
  --sha 598d1f68b6ef7b19e8a6d30c13575bac1701b7c2 \
  --bundle-dir /private/tmp/selfhost-d-drill-bundle \
  --output /private/tmp/selfhost-d-drill-final-results
```

夹具强制 bundle SHA、OCI revision/digest、非 root、无 build/公开数据端口、镜像内 runtime 和干净工作树。不得把真实供应商配置传给此夹具。

根 check/deps/singletons/dedupe/typecheck/test/build 和 OpenSpec strict 全通过；typecheck 额外无缓存 14/14 以生成路由，test 26/26 任务、1520 通过/2 个既有 Linux-only 跳过，build 2/2 命中缓存。最终夹具修正后再次 check、Node 语法与 28 项 Python 备份测试通过；见 [validation.json](validation.json)。首次无缓存 typecheck 的本地 plan 表缺失只触发既有定价降级，没有新增迁移。

真实供应商身份独立性、外部存储/服务器、生产规模 RTO/RPO 和异机 jobs 退出证明仍需对应签收；只勾选 6.2，不勾选 7.2、不归档或合并 change。

PR 变基到 main 的协调者签收 #207 后，仅 tasks.md 冲突；保留原复核为历史并保留 6.4 签收。本次运行的夹具文件 SHA256 与变基后逐一一致，strict/check 再次通过，见 [rebase.json](rebase.json)。
