# D 镜像交付与协调者签收清单

最新服务器状态（2026-10-16 UTC）：正式1888e7d部署、真实R2主/副本只读PITR及逻辑恢复、B6.4批准夹具后复验、已批准的真实systemctl reboot全部通过。D7.1/7.2/7.3已验收，7.4仅待协调者审阅。最新[矩阵](evidence/selfhost/server-acceptance-1888e7d/matrix.md)与[报告](evidence/selfhost/server-acceptance-1888e7d/report.md)齐全；15个原有容器与warp保持停用。下文历史“缺资源/授权”及初次阻塞不再代表当前状态。

此文是 `add-selfhost-delivery` 1.1 的审阅草案，快照日期 2026-10-14。
协调者确认文件所有权及以下依赖后才勾选 1.1。D worker 仅领取 1.1–1.3，
不勾选 A/B/C、不同步或归档 capability、不连接服务器或使用部署凭据。

## 文件所有权

| owner / 编号 | 独占文件或接口 | 串行集成边界 |
| --- | --- | --- |
| d-images / 1.1–1.3 | `.github/workflows/selfhost-images.yml`、`selfhost-publish.yml`、`deploy/selfhost/images/**`、本交接文档 | 镜像 catalog 与发布验证入口由此 owner 维护；1.4 bundle 后续由协调者单独派发 |
| d-generator / 3.1–3.4 | `scripts/create-project*`、`docs/create-project.md`；生成器测试 | `template.config.ts`、`packages/config/**`、web/jobs 注册接线及 manifest/lockfile 的补丁由协调者串行整合；保留并行 `ai.text.*` 字段 |
| deployment / 1.4–1.5、2、6.1/6.3 | 待派发：`deploy/selfhost/deploy.sh`、`init-server.sh`、代理 override、部署/回滚 runbook 与 release bundle | `compose.yaml`、`.env.example`、README 与 ownership 卷只能由指定唯一 owner 修改 |
| backup / 4–5、6.2 | 待派发：backup 工具 Dockerfile、WAL-G wrapper、backup/restore/drill/sync 脚本与 runbook | `postgres.Dockerfile`、PG 入口、Compose、secret/env 示例需要协调者分配唯一 owner；不得改 CF `infra/postgres` |
| B owner / D 1.5 签收 | `packages/platform/src/node/job-owner.ts`、`job-engine.ts` 及对应引擎测试 | D 消费退出证明，不改 owner JSON、不删 owner 目录、不按 TTL 或 pid:host 猜测退出 |
| 协调者 / 6.4、7.4 | 汇总证据、共享补丁、迁移 SQL、capability 同步与归档 | worker 不生成迁移 SQL、不自行合并；CF staging 仍只由 main 自动发布 |

后续 worker 在改动这些共享文件之前必须确认唯一写入者。上表的“待派发”不是授权另一
worker 同时写入。正式 release bundle 必须等部署/初始化/备份/恢复脚本实际交付后再制作，
本次成功 image-set artifact 不能替代 1.4 的可部署 bundle。

## A/B/C 消费接口与剩余验收

| 依赖 | 确切消费位置 | 截止此快照的未完成编号 |
| --- | --- | --- |
| A foundation | `deploy/selfhost/app.Dockerfile` 的 web/jobs/migrate/native-smoke targets；postgres/valkey/caddy Dockerfiles；`compose.yaml` 三角色/TLS/迁移 gate；`apps/web/src/routes/api/health.ts` | 7.4（实际 ACME 签发/续期/challenge）、8.3（含合入后的 main staging 证据）、9.4（协调者汇总） |
| B job engine | `packages/platform/src/node/{job-owner,job-engine,job-queue,workflow,scheduler}.ts`；`apps/jobs/src/node/runtime.ts` 与 registration；jobs `/internal/ready`；`deploy/selfhost/migrate.mjs` SQL→DBOS public migrate | 1.9（整机预算）、5.3/5.4（媒体迁移/接线）、6.1–6.5（正式 Docker/服务器/集成验收） |
| C storage/observability | `packages/storage/src/node/**` 的 Storage/MediaOutputCopier；`packages/email/src/node/**`；`deploy/selfhost/object-storage.Dockerfile` 与 `compose.object-storage.yaml`；Node Sentry 入口/上传脚本 | 1.7（外部 S3/R2 联通）、2.5（真实 Sentry source maps）、3.4（真实 SMTP 认证链路）、4.1/4.2（跨组集成/审阅） |

状态以三个 change 的 `tasks.md` 为准，旧文档的“B 未装配”描述不能覆盖代码事实。
readiness 必须同时核对 db/cache/queue/scheduler、成功五分钟心跳、web/jobs 的完整 SHA；
`/internal/live` 只是进程探活。镜像 smoke 等真实 slot，不能回填数据库心跳。
C 的存储能力不等于 B 的媒体 workflow 已移植，D 不替 5.3/5.4 验收。

## B/D 生命周期签收（D 1.5）

设计文档的 ownership 快照早于已合入的补修。现在 `job-owner.ts` 的
`ProcessOwner` 包含可信宿主 `machineId`、host、PID 与 PID namespace，
boot ID 和启动时间仅供诊断；`processExited()` 要求相同 hostname/machineId，
且旧 token 锁文件存在并可取得非阻塞共享 flock，无法证明时拒绝接管。
Compose 已将 `JOB_EXECUTOR_ID` 同时用于稳定 hostname，并挂载 `job_owners` 到
`/app/.data/job-owners`；UID1000、目录0700。以
[A 最终验收](selfhost-a-final.md) 和 [引擎 runbook](node-job-engine.md) 为证据来源。

协调者/B owner 应签收以下行为及证据，再放行 D 1.5；已有实现并不自动代表整机验收完成：

- 旧执行者仍活时，同 ID 启动明确拒绝；退出后才能恢复同版本任务。
- `stop/start` 与保留卷的 container recreate 分别有证据；hostname/ID 稳定，旧 owner/guard 保留，PID 1 复用不被误认。
- 实际 VM reboot 改变 boot ID，并由内核释放旧进程持有的 flock 后恢复；不能用 container restart 替代 reboot，也不以 boot ID 单独作为退出证明。
- 异机恢复只在旧执行者确定退出、版本/handler 匹配后执行明确恢复流程；不能复制 owner 文件当作退出证据。
- 双 jobs 的互异 ID/hostname、共享持久 ownership 目录与引擎 namespace 契约签收；不能直接 `--scale jobs=2` 复制同 ID。
- 记录排空/强制退出、旧任务身份、成功 step 缓存、原 deadline 和幂等结果；不能仅用 health SHA 证明任务恢复。

上述为原签收清单；本机正式 flock 验收进展见下方 d-vm2 记录。异机恢复和真实服务器
仍各有独立门，本轮没有修改 B 引擎。

### 2026-10-15 d-vm 补修及剩余门

本次任务明确授权 B 补修同 PR 交付。检查固定正式 SHA `0813050` 后发现：不同 PID
namespace 可能同时活着，同名异机的 boot 差异也不能证明旧机退出。新实现要求可信宿主
machineId，同 boot 下不同 namespace 拒绝；D Compose 接入 host PID namespace 和只读
宿主身份。Linux 初始化临界区以 OS flock 保护可信 dead guard 的定向恢复，保留历史记录。
确切行为、Linux/PG/VM证据见 [d-vm报告](evidence/selfhost/d-vm-2026-10-15/report.md)。

评审后将退出证明改为进程生命周期内核锁：Node 持有 ownership 卷上 executor/token 锁的
描述符直至真实退出，同机跨容器/namespace 由 flock 互斥证明，不再使用 `pid:host`；
machineId 仍拒绝异机卷。d-vm 报告中的补修 VM 证据针对此前 `pid:host` 版本，
锁版本使用 `test-vm-lifecycle.py --official-flock --expected-sha <正式完整SHA>`
重跑 exit/namespace/recreate/reboot，禁止挂载本地补修源码代替发布镜像。

原正式 bundle/镜像保持不可变；新源码 fixture 不代签旧正式镜像。协调者已确认
修复前镜像（0813050及更早）从未部署到真实服务器，**BREAKING：不提供缺machineId或
token锁文件的旧owner升级迁移路径，正式flock版须新卷部署**；不自动改写旧记录或删除
目录绕过。异机恢复退出证明仍为开放设计项，本轮不实现。正式镜像的本机签收与
第7组真实服务器门分别处理，不以本地VM验收解除真实主机决策门。

### 2026-10-15 d-vm2 正式 flock 本机签收

第三次已批准的正式发布为 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`
（[run 38624392597](https://github.com/ustclhx/product-res/actions/runs/38624392597)）。
新建 Debian12 arm64 Lima `selfhost-d-vm2`（2C/4GiB），初始部署、reboot和生命周期探针
使用其原版 bundle 与正式 GHCR digest；升级回滚另使用仅SHA元数据变化的本地registry
fixture。生产 jobs 和受控任务 probe 均没有源码补修挂载或 host PID namespace。

正式代码的 exit/namespace/recreate/reboot 全部通过：旧进程仍活、DB advisory 已释放时
拒绝同 ID；真实退出后恢复；保留原任务身份、原 deadline，成功 callback 恰一次。
实际 reboot 后全部常驻服务含 backup 自动恢复、迁移不循环，fresh 自然 heartbeat、
web/jobs 完整 SHA、backup scheduler/成功 slot、数据与卷保持。
据此按协调者本轮已定范围勾选 1.5 与 6.3；异机退出证明仍开放，第7组保持待办。
同轮正式bundle SSH部署、真实PG/DBOS升级/失败/回滚与八项隔离机制通过后，2.1/2.3
也已勾选。任务资源与VM已删除，不将本地版本元数据fixture称为第二个正式发布。
逐项证据见 [d-vm2报告](evidence/selfhost/d-vm2-2026-10-15/report.md)。

## 镜像集合与后续接入

`deploy/selfhost/images/catalog.json` 当前含 web/jobs/migrate/postgres/valkey/caddy/
object-storage。`pendingServices: ["backup"]` 明确记录 D 4.1 未交付的备份工具镜像。
发布入口在只读 trust job 校验完整集合，缺少 backup 时失败，尚未获取 packages 写权限
的 job 不运行。不得删除 pending 来伪造完成；backup owner 需交付 Dockerfile、双架构
基础镜像与 checksum、实际非 root/native/secret/TLS smoke 后，协调者将 backup 加入
catalog 和 runtime smoke，再移除 pending。

PR 双架构成功 artifact 是每架构的 tar、build.json、smoke.json，发布流程加载已测 tar，
核对 image ID、架构及 revision，再组合 amd64/arm64 manifest。D 1.4 必须消费最后成功
生成的 `image-set.json` 中 digest，不能根据“某个 SHA tag 存在”认定版本可部署。
正式 SHA 不覆写；部分失败的 SHA 也拒绝自动重跑覆盖，按发布说明处理。

## Capability 同步顺序

只由协调者在相应 change 全部签收后串行执行：先合并 A 的 `selfhost-deployment`
基础 requirements，再追加 D 同路径的交付 requirements；先同步既有 observability
change 的 `project-bootstrap`，再追加 D 的 target/功能裁剪/排除 requirements；
D `database-backup-recovery` 独立新增。B/C 各 capability 按自身证据同步。

已比对 A/D selfhost-deployment 与既有/D project-bootstrap 的 `### Requirement:`
名称，没有重复 requirement；不复制、改名或覆盖 A 的基础条款。
尚未完成的 A/B/C/D 不因本 PR 合入而归档。

## 第 7 组阻塞

7.1 缺少用户选择并授权的主机、入口、运维方式、域名/TLS 与容量；7.2 缺独立备份
供应商账号/凭据及演练窗口；7.3 缺真实 reboot 授权窗口及 1.5 签收；7.4 等待前述
服务器证据齐全后由协调者审阅。所有项保持未勾选。

已有 `product-res-ecs` 不被默认选中，也未连接。设计记录其已有生产负载、资源余量
不足与端口冲突；空白主机初始化脚本不能用于该机。本地 Docker/VM/CI 证据不解除
用户主机决策门，不添加 secret、不改 `deploy-staging.yml` 的 CF 发布行为。
