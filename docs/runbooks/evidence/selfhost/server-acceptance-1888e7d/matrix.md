# 需求与证据矩阵

来源与完整 SHA、授权边界和本轮实测方法见 [报告](report.md)。
既有已签收证据保持其原环境、SHA 和适用范围，不冒称在本服务器重新执行。

| 范围 | 对应证据 | 本轮适用范围 |
| --- | --- | --- |
| P1 不可变双架构镜像 | [正式发布 run](https://github.com/ustclhx/product-res/actions/runs/38924583361)、[部署元数据](deployment.json)；既有 [release runbook](../../../selfhost-release.md) | 可信同 SHA 八服务 image-set/bundle，实际主机消费 amd64 digest；不将单台 amd64 机器称为 arm64 服务器验收 |
| P2 Compose 发布/迁移 | [部署](deployment.json)、[web/jobs health](deploy-acme.json)、[deploy runbook](../../../selfhost-deploy.md) | 只用原始 bundle 入口及受审 s3/backup/replica override；服务器无业务构建；一次性迁移退出 0。选择 plain Compose/Caddy，未选择 Dokploy |
| P3 版本门与回滚 | [health](deploy-acme.json)、既有 [正式 flock VM/升级与回滚](../d-vm2-2026-10-15/report.md) | 当前 web/jobs 完整 SHA 与自然 heartbeat 通过。此 release 的 rollback_compatible_with 为空，不宣称它允许回滚，也未执行一次虚构的兼容回滚 |
| P4 空白机初始化 | [init runbook](../../../selfhost-init.md)、[正式 VM](../d-vm2-2026-10-15/report.md)、[主机启动预检](reboot-preflight.json) | 本机是获准复用的 Ubuntu22.04，保留现有 Docker/Compose/防火墙/SSH，不运行空白 init。空白 Debian/Ubuntu 安装、拒绝已用主机与幂等沿用已签收隔离 VM 证据 |
| P5 生成器与功能裁剪 | [生成器实测](../../create-project/2026-10-14/selfhost-features.json)、[协调者集成签收](../signoff-2026-10-15.json) | 既有 selfhost 生成与裁剪证据；本轮没有修改生成器或将默认正式模板冒充裁剪副本 |
| B1 每日 full/WAL/分层保留 | [备份状态](backup.json)、[摘要](backup-summary.json)、[保留计划](retention.json)、[R2 锁/生命周期](r2-settings.json) | 真 R2、首次每日 slot 与额外完整周期；7天/4周策略。新环境缺少前三周锚点；四周 metadata 机制另见 [既有演练](../d-drill-2026-10-15/report.md) |
| B2 每日逻辑备份 | [下载与 SHA 校验](logical.json)、[禁网逻辑恢复](logical-restore.json) | 实际 pg_dump + roles/custom dump 恢复，业务/任务/约束/角色 11 项；不把逻辑快照当作连续 PITR |
| B3 新卷显式 UTC PITR | [主桶恢复](restore-main-readonly.json) | 正式 restore-drill.sh、初始 base+连续 WAL、前标记存在/后标记不存在、15 项校验；原卷未挂载 |
| B4 临时实例恢复演练 | [主](restore-main-readonly.json)、[副本](restore-replica-readonly.json)、[逻辑](logical-restore.json) | 新临时卷、无 host ports、无应用/外部副作用；成功后清理本次资源；RTO/RPO 的测量范围明确 |
| B5 独立凭据恢复副本 | [同步 token 权限](permissions.json)、[恢复只读权限](permissions-readonly.json)、[副本挂载](restore-replica-readonly-audit.json)、[副本同点恢复](restore-replica-readonly.json) | 仅副本只读 token/桶成功，主桶 List403，Put/Delete403，replay LSN 相同；同一账号/供应商的共同故障风险保留 |
| §6.7 指定点恢复 | [主](restore-main-readonly.json)、[副本](restore-replica-readonly.json)、[备份摘要](backup-summary.json) | 本服务器实际新卷恢复与数据/角色/真实任务状态校验通过，不仅是本地机制夹具 |
| §6.8 实际服务器 reboot | [真实reboot](reboot.json)、[命令](reboot-command.json)、[前](reboot-pre.json)/[后](reboot-post.json)、[备份恢复周期](backup-postboot.json)、[会话/文件](postboot-file.json)、[最终状态](final-state.json) | 实际systemctl reboot，21项通过：自然heartbeat、全服务自动恢复、迁移不重跑、原任务/deadline/成功step、PG/Valkey/证书/文件、备份周期及原15服务继续停用；无手工启动或owner删除 |
| A foundation 7.4 | [实际 ACME](deploy-acme.json)、[续期](acme-renewal.json)、[既有证书/XFF/非 root](../../../selfhost-a7.md) | 已补齐实际域名 ACME 门；staging 续期与生产证书状态隔离 |
| A 其他需求、B/C 依赖 | [A 最终矩阵](../../../selfhost-a-final.md)、[协调者集成签收](../signoff-2026-10-15.json)、各 change tasks 的既有逐项证据 | A 8.3/9.1–9.3 与 B/C 已合入签收不由本 worker 重做；本轮增加剩余服务器证据 |
| B job-engine 6.4 | [调度10/10](scheduler.json)、[引擎/队列14/14](queue.json)、[重试](queue-timeline.json)、[双worker](permits.json)、[长例通过](workflow-proof.json)、[短例复验](workflow-approved-fast.json)、[分次覆盖](workflow-acceptance.json)、[修正说明](approved-fixture.md)、[原失败](workflow-recovery-failures.json)、[资源](resources.json) | 长例实际3675秒通过；批准夹具初始sleep 2→5秒后，10个短例全部通过，原断言完整保留。B6.4已勾选，分次运行及原失败均明确保留 |
| C storage-observability 1.7 | [业务/SDK](storage.json)、[浏览器](browser.json)、[私有桶配置](r2-settings.json) | R2 外挂默认路径通过，无自带对象存储服务；不重复验收或修改已签收的 B 媒体接线 |
| A 9.4 / D 7.4 最终签收 | 本矩阵与 [报告](report.md) 提交协调者 | 服务器实测门已齐全，待协调者审阅；主 spec 同步与归档仍由协调者执行，不虚构已收到的审阅确认 |

当前服务器未配置真实邮件/OAuth/Turnstile/支付/AI/管理员集成，不将既有其他环境的对应
验收混称为本服务器实际接通。生产 Cloudflare/staging 没有被本次操作修改。
