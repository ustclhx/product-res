# Selfhost 备份保留边界

`deploy/selfhost/backup/retention.py` 仅负责 WAL-G v3.0.8 主目标的 full base
保留计划与删除前置验证。默认最近 7×24 小时内的全部 full，以及 UTC 每周一
00:00 开始的最近四个固定周各自第一份成功 full；当前未完整结束的一周计入四周。
日窗口起点之前已完成的最近一份 base 也保留，以覆盖窗口起点。`daily_days`、
`weekly_weeks`、`weekly_day`（周一 0、周日 6）可配置。

实际删除边界是所有选中 base 与已有 permanent base 中最老的一份。
该边界之后的全部中间 base 和 WAL 都保留，存储量可能超过 daily/weekly
数量之和。缺少周锚点在计划的 `missingWeeklyAnchors` 中显示，不伪造完整四周历史。
**对象桶 lifecycle 不得独立按对象年龄清除 WAL 或 timeline history。**

## 调用与可信证明

模块接收可调用的 `invoke(args) -> str`，失败由调用方抛出脱敏异常。
`plan(json.loads(invoke(['backup-list', '--detail', '--json'])), now)` 返回只含
安全标识、UTC 时间与策略的 JSON dict，不输出 hostname、datadir 或 user_data。
`execute(invoke, plan, proof, now, dry_run=True)` 默认只调用 WAL-G 的无
`--confirm` 预演；实际清理必须显式传 `dry_run=False`，仍先预演再确认。
整个备份周期须持有同一互斥锁，禁止另一个管理器或人工删除同时写主 prefix。

调用方通过 PG peer socket 读取真实 `pg_control_system().system_identifier`
与 `pg_control_checkpoint().timeline_id`，不能从备份清单自证 live identity。
本模块只支持本镜像默认的 16 MiB WAL segment、单一 primary storage、单一
cluster 和单一 timeline。PG promote/恢复/升级后发现跨 timeline 时暂停清理；
由操作者核验旧链、history 与恢复承诺，再隔离新归档 prefix，不自动丢弃旧链。

`proof` 契约：

```json
{
  "clusterId": "12345",
  "timeline": 1,
  "base": {"ok": true, "lastSuccess": "2026-10-14T02:00:10Z", "backupId": "base_<24 hex>"},
  "archive": {"ok": true, "verifiedAt": "2026-10-14T02:00:20Z", "continuousUntil": "2026-10-14T02:00:15Z", "lastWal": "<24 hex>"},
  "replica": {"configured": false}
}
```

`base.backupId` 必须是本轮成功且 inventory 中最新的完整 base。
`archive.continuousUntil` 由调用方已确认归档的 switch 边界建立，不能把
lastWal 名称或最新 base 的时间直接当作 WAL 恢复上界。
`integrity_proof(invoke, oldest_backup_id, last_wal=None)` 返回严格 OK 的
实际 WAL 范围；未传 last_wal 时检查 PG 当前段之前的归档，排除正在写入的段。
调用方仍须建立可信时间上界。execute 再从计划最老 base 验证到 lastWal（含该段）。

副本配置为 true 时，必须读取可信且最多 15 分钟前完成的复制 manifest，包含
`ok: true`、`lastSuccess`、`continuousUntil`、`backupId`、`oldestBackupId`、
`clusterId`、`timeline`；最新 base、最老保留 base 和恢复上界须覆盖当前计划。
未经大小/可用 checksum/完整对象清单验证的乐观布尔值不能充当 manifest。
未加载 `compose.replica.yaml` 时保持 configured=false，结果明确 `not_configured`；启用时
`replica.py` 校验远端完整对象清单并提交 manifest，成功后才产生本地保留证明。
已配置但缺少、陈旧、失败或覆盖不足的副本证明拒绝删除。新 base、归档验证失败
同样拒绝任何 delete。WAL-G WARNING、FAILURE 即使进程 exit 0 也拒绝。

## 固定版本源码依据

研究固定 tag `v3.0.8`，提交 `f81943e64bdf97aa66f6c52fec55114703f97af7`：

- [delete 命令实现](https://github.com/wal-g/wal-g/blob/v3.0.8/cmd/pg/delete.go)
  注册 `--confirm`；省略该 flag 为 dry-run。`delete before FIND_FULL <base>`
  包含边界本身，不采用按数量 retain，也不使用 garbage。
- [删除比较器](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/databases/postgres/delete.go)
  默认按 timeline 与 WAL segment 顺序；[实际删除谓词](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/delete_handler.go)
  仅删除严格小于目标且非 permanent 的对象。timeline history 没有 24 位 WAL
  segment 标识，默认比较器无法排序，不删 history。
- [permanent WAL 选择](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/databases/postgres/delete_util.go)
  只保护 permanent base 的 start_lsn 至 finish_lsn WAL，不保护其后任意 PITR 区间。
  所以本策略靠最老 base 的 before 边界保护整链，不以标记代替整链。
- [wal-verify flags](https://github.com/wal-g/wal-g/blob/v3.0.8/cmd/pg/wal_verify.go)
  包含 `--backup-name`、`--timeline`、`--lsn`、`--json`。
  [扫描器](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/databases/postgres/wal_segment_scanner.go)
  从 current 的前一段开始，因此 inclusive lastWal 校验传下一段起点+1 的 LSN。
  [结果写出](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/databases/postgres/wal_verify_handler.go)
  没有基于 WARNING/FAILURE 设置失败 exit；必须检查 JSON 和实际 FOUND 范围。
- [JSON list 编码](https://github.com/wal-g/wal-g/blob/v3.0.8/internal/printlist/entities.go)
  编码整个结构体；详细列表原生含 system_identifier 与数字 start_lsn/finish_lsn，
  不只包含表格字段。backup-push 的 user metadata flag 是 `--add-user-data`。

## 隔离 S3 集成验收（由集成 owner 执行）

单元验证：

```sh
python3 -m unittest discover -s deploy/selfhost/backup -p retention_test.py -v
```

所有命令通过工具服务已装配的 secret 文件执行，不把 endpoint 凭据放 argv。
只操作本 worktree 创建的 fixture bucket/prefix，复制或修改成功 fixture 的
metadata 时间来加速保留边界验证，不修改 PG 生产数据或远端存储。

1. 用固定 v3.0.8 真实生成至少五份 full，full 之间产生业务 marker、调用
   `pg_switch_wal()` 并等待相应归档完成。独立记录清理前对象列表与 history。
2. 在该隔离 prefix 中调整 metadata 的 start_time/finish_time，使一份 weekly
   base 超过七天但处于最近第四个 UTC 固定周；时间顺序必须与 WAL 顺序一致。
   计划须含该 weekly；dry-run 后对象清单完全不变。
3. 执行 `wal-g delete before FIND_FULL <plan.oldest>` 后仍无对象变化，再用
   同一命令加 `--confirm`。断言 old base 被删除，oldest 本身、所有其后的
   base、WAL 及全部 timeline history 保持。检查 weekly 之后每个必需 WAL。
4. 在新隔离空 PG17 目录 `wal-g backup-fetch <new-dir> <oldest>`，用归档
   `wal-fetch` 重放到 weekly 后的已记录 UTC marker 时间；断言前 marker 存在、
   后 marker 不存在。此测试仅提供 4.3 机制证据，不交付任务 5 的生产恢复入口。
5. 从 fixture 删除链中一段 WAL，证明 `wal-verify integrity timeline --json
   --backup-name <oldest>` 的 JSON 非 OK（进程可能仍 exit 0），工具 apply
   非零失败且剩余对象不发生删除。另分别注入新 base 上传失败、配置副本但
   manifest 失败/超过 15 分钟/上界不足，断言全部无 delete 调用。
6. 调用 actual v3.0.8 `backup-mark <weekly>` 后再 dry-run，记录它只保护
   base 完成时必需 WAL 的行为；不能据此允许 count-only retain 删除连续链。

真实不同供应商副本、amd64 runtime 和服务器 PITR 仍须对应后续任务证据。
