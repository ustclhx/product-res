# Cloudflare 形态生产数据库恢复与演练

对应 `add-cloud-production-neon` 4.1 / 4.2 与 production-deployment spec「生产数据库备份与恢复演练」。生产库为 Neon 项目 `product-res-production`（`super-resonance-99115167`，默认分支 `main`），项目与凭据见 [production-neon](./production-neon.md)。自托管形态的 WAL-G / PITR 见 [selfhost-restore](./selfhost-restore.md)，两者互不替代。

**铁律**：演练与恢复只创建临时目标（Neon 临时分支或本地临时库），**不覆盖、不重置生产 `main` 分支**；校验只读执行；不在命令参数、日志或证据中写连接串与密钥。

## 1. 两条恢复路径

| 路径 | 来源 | 覆盖的故障 | 预期 RPO |
|---|---|---|---|
| A. Neon 时间点分支 | Neon PITR（保留 7 天） | 误删 / 错误迁移 / 应用写坏数据 | 秒级（任意时间点） |
| B. 逻辑备份 | R2 `product-res-production-backups` 中每日 age 加密 `pg_dump`（Bucket Lock 30 天、35 天过期） | Neon 项目或账号不可用、超过 7 天的回溯 | ≤ 24 小时（每日一次） |

## 2. 路径 A：Neon 时间点分支

```sh
# 目标时间用 UTC ISO 格式；分支 24 小时后自动过期，演练结束仍应主动删除
neonctl branches create --project-id super-resonance-99115167 \
  --name restore-drill-<YYYYMMDD> --parent <2026-10-20T03:00:00Z> \
  --expires-at <创建时间 + 24h> --no-secrets --output json
```

取临时分支的 readonly 非 pooled 连接串（`neonctl connection-string restore-drill-<YYYYMMDD> --project-id super-resonance-99115167 --database-name product_res_production --role-name readonly`），只放进环境变量，运行校验：

```sh
RESTORE_DATABASE_URL=<只在环境变量中> node scripts/production/verify-restore.mjs --roles
```

`--roles` 额外核对三角色仍受限（时间点分支保留集群角色）。演练结束：`neonctl branches delete restore-drill-<YYYYMMDD> --project-id super-resonance-99115167`。

真正需要用历史数据恢复生产时，先停写（暂停 jobs 发布或开启维护）、评估差异，再由用户决定：把应用切到恢复分支，或从恢复分支导出少量数据回写。不要直接 reset `main`。

## 3. 路径 B：逻辑备份恢复

前提：age 私钥（开发机 `~/.config/product-res/production-backup.agekey` 或离线副本）、R2 读取凭据。

1. 列出并下载目标备份（对象键 `neon/product_res_production/YYYY/MM/DD/product_res_production-<UTC>.dump.age`），核对对象元数据 `sha256` 与本地 `shasum -a 256` 一致。
2. 恢复到临时目标：本地 Docker PG 17（`product-res-pg`）中新建临时库，或新建一个空的 Neon 临时分支 / 数据库。不要恢复到 `product_res_dev` 或生产 `main`。

   ```sh
   docker exec product-res-pg psql -U postgres -qAt -c "CREATE DATABASE restore_drill"
   age -d -i ~/.config/product-res/production-backup.agekey <下载的文件>.dump.age \
     | docker exec -i product-res-pg pg_restore -U postgres -d restore_drill \
         --no-owner --no-privileges --exit-on-error
   ```

   备份以 `--no-owner --no-privileges` 生成；恢复到需要对外服务的目标时，再以 migrator 执行 `infra/local/initdb/02-db-grants.sql` 设置 owner 与权限。
3. 校验（逻辑恢复的新库没有原角色，不加 `--roles`）：

   ```sh
   RESTORE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/restore_drill \
     PSQL=/opt/homebrew/opt/libpq/bin/psql node scripts/production/verify-restore.mjs
   ```

4. 清理：`DROP DATABASE restore_drill`，删除下载的加密文件。

## 4. 校验内容

`scripts/production/verify-restore.mjs` 在只读事务中逐项输出 `{"check","ok"}`，任一失败退出码为 1：

- `pg17`：服务端为 PostgreSQL 17。
- `migrations`：`drizzle.__drizzle_migrations` 行数等于 `packages/db/migrations/meta/_journal.json` 条目数。
- `business_tables`、`constraints`：public 表存在，所有约束已验证。
- `credits_balance`：每个空间 ledger 合计 = active 剩余 + held − debt（与 `reconcileWorkspaceCredits`、自托管恢复演练相同）。
- `--roles` 时另查 `roles`、`role_permissions`。

另输出 `user`、`organization`、`payment`、`credit_ledger`、`ai_task` 行数，与恢复目标时间点的生产只读查询对比。

## 5. 演练记录

上线前及之后每季度各演练一次两条路径，证据写入 `docs/runbooks/evidence/production/restore-<YYYY-MM-DD>.md`：目标时间点、备份对象键与 sha256、开始 / 可查询 / 校验完成的 UTC 时间、RTO（开始到校验通过）、RPO（目标时间与实际数据最新时间之差）、各项校验结果与行数对比、临时资源已删除。演练时同时验证 age 私钥离线副本可解密。

## 6. 本地验证记录（2026-10-15）

- 备份脚本 `BACKUP_DRY_RUN=1` 对本地 `product_res_dev` 生成加密 dump（PG17 容器 `pg_dump` → age，116,701 字节，age 头正确），未上传。
- 用临时 age 密钥解密后 `pg_restore` 到本地临时库，`verify-restore.mjs` 五项全部通过；删除一条迁移记录后 `migrations` 判定失败，证明校验能发现差异。临时库与文件已删除。
- 以 `readonly` 执行 `pg_dump` 会因 `permission denied for schema drizzle` 失败；临时角色授予 `pg_read_all_data` 后可完整导出（含 `drizzle` 与 `job_engine` 共 45 张表数据）且写入仍被拒绝。生产需由 owner 执行 `GRANT pg_read_all_data TO readonly`（待用户批准，见 production runbook）。
