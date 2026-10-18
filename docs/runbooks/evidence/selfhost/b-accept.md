# B 6.1–6.3 本地 Docker 验收（2026-10-14）

只勾选本次分配的 6.1–6.3；正式源码 SHA 为
`70496c6496ca7f2b89ea75a49f1a6629836fe628`，DBOS 5.2.11、PG 17.11、
Node 23.11.0，生产心跳场景另使用 Valkey 8.1.6。
本轮使用 worktree 独占 Docker PG/Valkey 与正式 Node 生产构建/适配器测试，
没有用 spike 或旧轮报告替代，没有访问真实采集 API 或手动发布 staging。

| 任务 | 本轮通过证据 |
|---|---|
| 6.1 | [调度/真实 web 心跳报告](b-6.1-report.md)：时区映射、自主双 jobs、跨 slot 无重叠、skip/once/恢复、前置失败不推进、601 秒停摆旧心跳 |
| 6.2 | [队列报告](b-6.2-queues.md)：真实 Drizzle 未提交/回滚/提交、十条混合批次、六次生产退避与 DLQ、三个 SIGKILL 窗口、同时双 publisher 全局限额 |
| 6.3 | [流水线报告](b-6.3-workflow.md)：真实 61.123 分钟、三次同版本重启、18 个成功 callback 各一次、原 sleep/deadline、3667.365 秒早到事件与副作用/结算幂等 |

流水线实际 UTC 起止：**2026-10-14 11:55:48.631 → 12:56:56.032**。
开始/结束来自 native 同身份记录，事件时间来自自有 inbox，未修改时钟或回填时间。

[本地资源采样汇总](b-6.3-resource-summary.json) 与
[web/双 jobs/PG/Valkey 快照](b-6.1-resources.json) 仅记录本地观察：
长跑 PG working set 采样峰值 72.04MiB、kernel memory peak 140591104B，
OOM/OOM kill 为零；长跑库连接采样峰值 6，持续 worker RSS 峰值 113840KiB。
宿主 Node 无 cgroup 限额，WAL 包含同 PG 另库快验，完整测量范围与 SQL 聚合方法见报告。
这些数值不构成整机 2 核/4GiB 签收。

[根检查记录](b-accept-validation.json) 包含命令、退出码与关键结果。
准备/观察脚本曾出现的 schema filter、UUID 与时间解析错误均保留其说明和补正证据；
没有修改生产代码、有效测试断言或根 manifest/lockfile，也没有提交迁移 SQL。

所有本轮容器/卷、自有 Node 进程与采样进程已结束，临时凭据已移除：
[调度清理](b-6.1-cleanup.json)、[队列记录](b-6.2-evidence.json)、
[流水线清理](b-6.3-cleanup.json)。

6.4 新加坡 Linux 服务器验收 **BLOCKED**，未执行、未勾选。
1.9 整机预算与 6.5 的 Compose/auth e2e、main 自动 staging/health 集成门槛仍未完成，
由协调者按后续分配处理；本轮根检查通过不提前勾选这些未分配项。
