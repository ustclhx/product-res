---
name: deploy-selfhost
description: 为本 SaaS 模板准备或部署自托管环境，沿主机接入/初始化、GHCR 同 SHA image-set、release bundle、health、兼容回滚与备份恢复流程执行；默认只读预检。
---

# 自托管部署

先在项目根完整阅读 `deploy/selfhost/README.md`、`deploy/selfhost/OPERATIONS.md` 与 `docs/runbooks/selfhost-{init,release,deploy,proxy}.md`；涉及备份恢复再读 `selfhost-backup.md`、`selfhost-backup-retention.md`、`selfhost-replica.md`、`selfhost-restore.md`。技能输入可提供 `--host <明确user@host>`、`--dir </srv或/opt绝对路径>`、`--sha <完整40位SHA>`、`--domain <主机名>`、`--admin-email <邮箱>`；不是新建 shell CLI，最终使用现有脚本参数。邮箱只走受限配置，不进入报告。

## 1. 默认只读预检

核对 `template.config.ts`、目标机器/架构/归属、发布仓库、GHCR namespace、来源 run 和完整 SHA；生成副本必须发布自身功能配置的镜像，模板镜像不能代替它。列出以下资源缺口：

| 资源 | 要求与证据 |
| --- | --- |
| 主机 | Ubuntu24.04 / Debian12，amd64/arm64、systemd；空白主机init 固定 Docker28.5.1/Compose2.40.3，至少2CPU/4GiB/10GiB空闲是预检下限，另审查 PG/WAL/对象/备份增长。非空白复用主机按§3接入，不能运行空白 init。 |
| 域名/TLS | APP_DOMAIN / APP_URL 与入口一致；默认 Caddy ACME 需 DNS 和公网80/443，或已有受信证书；PG证书须 DNS:postgres SAN，CA验证与 sslmode=verify-full。 |
| PG/Valkey | 私网 PG17、app/migrator/readonly最小权限、Valkey认证；仅代理映射宿主80/443，数据服务无公网端口。 |
| S3 | 外部私有 S3/R2 按§3加载 `compose.s3.yaml`，核对 endpoint/region/bucket/CA/path-style 与受限应用身份；或显式 object-storage override。备份主目标与独立凭据副本按§5隔离。文本项目也核对文件清理能力的配置需求。 |
| 邮件 | 生产按 Node adapter 配 SMTP 或 Resend（`packages/email/src/node/smtp.ts`、`packages/config/src/node-schema.ts`）；域名/发件人、TLS、认证与 secrets。log模式不代表真实送信验收。 |
| 发布身份 | 成功 GHCR发布 run、同SHA八服务image-set、双架构smoke；服务器只消费bundle，不需业务源码/Node/pnpm，不触发publish。私有registry只经安全stdin登录。 |
| 运维 | 可信SSH host key、非交互身份、稳定executor ID/owner卷、独立备份与恢复材料；B/D ownership与恢复未签收时明示，不能删owner绕过。 |

只读检查本地 `git status`、`gh run view <run-id>`（读状态）、各脚本 `--help`。如用户已授权连接明确空白主机，可在那里运行 `sudo bash <bundle>/init-server.sh --dir <dir> --check`；不猜服务器、不自动SSH、不在当前 macOS 工作站运行安装。`--check` 是预检，不安装；返回不支持OS/已有配置即报告，不自动修复。

默认交付预检报告与具体动作清单：主机/路径/SHA、要创建或修改的文件、初始化/拉取/迁移/排空/发布、secret名称、代理/TLS、备份和回滚门。任何主机初始化、配置/secret写入、资源创建、镜像发布、部署前请求明确确认这份清单；已批准相同清单可继续，新增动作需补充确认。单说“部署一下”不能批准尚未列出的服务器变更。

发布前预检外部 S3：确认待发布源码与目标 release bundle 实际包含受审的 `compose.s3.yaml`，并为 web/jobs 装配 S3 环境键、允许的 `_FILE` 和 secret 挂载（见§3）。已有发布则检查同 SHA bundle 的实际内容；只有 `.env` 占位或密钥文件不算装配完成。缺失时停在“配置缺口”，先在源码补齐并发布新 SHA，不修改已发布 bundle，也不先停旧服务。

## 2. 验证可信发布集合与 bundle

从用户指定成功 `selfhost-publish.yml` run 下载已有 artifact，是读操作：

```sh
gh run view <run-id> --json conclusion,headSha,url
gh run download <run-id> --name selfhost-image-set-<full-sha> --dir <new-image-set-dir>
gh run download <run-id> --name selfhost-release-<full-sha> --dir <new-artifact-dir>
```

阅读 workflow 的实际压缩格式再解压，核对来源 run/repo、成功结论、SHA、namespace、web/jobs/migrate/postgres/valkey/caddy/object-storage/backup 八服务 digest/revision、amd64与arm64。已存在同SHA发布只能复用，不覆盖tag；缺成功集合则报告需要发布负责人执行授权发布，技能不自动触发 `selfhost-publish`。

```sh
python3 <bundle-dir>/release/bundle.py verify <bundle-dir> --sha <full-sha>
python3 <bundle-dir>/release/bundle.py compose-config <bundle-dir> --sha <full-sha>
```

包内校验器匹配该SHA材料。checksum只证明传输完整性，信任来自Actions来源；未知bundle不能因checksum通过即使用。`compose-config` 在干净bundle中只读example、固定digest且清除业务环境，不启动服务、不读secret内容；不用真实 `.env` 的 `docker compose config` 输出到日志。

如只有可信同SHA image-set与Git对象，可在本地**新目录**构建bundle（不是构建业务镜像）：

```sh
python3 deploy/selfhost/release/bundle.py build --source . --sha <full-main-sha> \
  --image-set <image-set-dir>/image-set.json --output <new-bundle-dir>
```

源码从Git对象读取，未提交修复不能冒充目标SHA；完整恢复材料需24项运行白名单，旧17项bundle不能声称含restore。`--fixture/--allow-fixture` 只用于隔离测试，正式服务器拒绝。回滚兼容声明默认空，只有审阅schema/DBOS handler/checkpoint与长任务后才能在build时加 `--rollback-compatible-with <previous-sha>`。

## 3. 获授权后初始化与配置

1. 明确空白目标主机才运行同bundle `sudo bash ./init-server.sh --dir <dir>`。脚本不部署、不生成真实secret、不签发证书；重复执行验证托管版本/hash/权限，不覆盖配置。已有数据/容器/防火墙/监听冲突即停止；中断后不删state重试，交操作员审阅。
2. 目标目录0700、`.env`0600：从同bundle example填写APP_URL/domain、公开ID与file secret路径；根据 `secrets.example` 用独立单文件secret、0600与精确UID/ACL（PG/backup999，应用1000，代理10001）。已发布bundle实际装配的可选secret通过 Node env支持的 `_FILE` 与受审Compose挂载；基础Compose不包含所有可选集成。读 `packages/config/src/node-schema.ts` 与 `compose.yaml` 核对每项，不能认为填写.env即可加载。现有基础bundle未装配 SMTP、支付/AI 和 BOOTSTRAP_ADMIN_EMAILS；deploy.py 只接受bundle固定白名单内的Compose文件，任意本机override会被拒绝。需要这些集成时停在配置缺口，交发布负责人在项目源码完成显式env/secret装配、必要的受审白名单扩展与验证，发布新SHA集合/bundle后再继续；不能修改已发布bundle或绕过门。
3. PG app/migrator URL均verify-full；CA/私钥按服务隔离，PG不接受非TLS TCP。只读账号不分给应用。Valkey不跨公网暴露。外部代理使用 `compose.proxy.yaml`、专用ingress和精确TRUSTED_PROXY_CIDRS，覆盖不可信转发头，不接data网络。
4. 外部应用S3或可选object-storage/backup/replica明确列入清单才加载对应Compose/env；核对S3 HTTPS、应用域CORS、容量与独立身份，不把备份secret给web/jobs。BOOTSTRAP_ADMIN_EMAILS需要发布材料明确装配为web受限配置；它不在当前Node `_FILE` 允许列表，不能臆造同名 `_FILE`。未装配时管理员验收阻塞，不能用改库替代。已验证未封禁账号才提升，移除不自动撤权。

### 外部应用 S3/R2

应用使用外部 S3/R2 时，在基础 `compose.yaml` 上叠加 `compose.s3.yaml`，部署参数为 `--compose-file compose.s3.yaml`；不同时加载自带对象存储的 `compose.object-storage.yaml`。在受限 `.env` 填 `S3_ENDPOINT`、`S3_REGION`（R2为 `auto`）、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`，并配置 `secrets/s3_access_key_id`、`secrets/s3_secret_access_key`；overlay 给 web/jobs 装配 `S3_ACCESS_KEY_ID_FILE` 与 `S3_SECRET_ACCESS_KEY_FILE`。核对浏览器可达的 HTTPS endpoint、受信CA、桶CORS及应用身份权限，文本项目也按文件清理需求核对。基础Compose和备份/副本overlay不能代替应用S3装配；备份凭据始终独立于应用身份。

### 非空白主机接入

复用非空白主机时，先只读记录80/443监听者、所属systemd服务或Docker项目/容器、配置和数据位置，以及原启用状态/重启策略；把需停用的具体服务、恢复方式和预期中断列入已授权动作清单。确认后，先停用其自动重启再停止对应服务，保留原容器、配置、卷和数据；核对80/443已释放才接入Caddy。只操作清单中的服务，不扩大到同机其他项目。已有代理继续承担入口时走 `compose.proxy.yaml` 的接入方案。已受管项目升级使用其原发布状态和既有入口，不重复执行空白init或接管步骤。

## 4. 部署、健康和首个管理员

```sh
<bundle-dir>/deploy.sh --local --dir <deploy-dir> --sha <full-sha> --bundle <bundle-dir>
# 从操作员电脑执行获准的明确SSH目标：
<bundle-dir>/deploy.sh --host <explicit-user@host> --dir <deploy-dir> \
  --sha <full-sha> --bundle <local-bundle-dir>
```

只有一种目标方式。SSH BatchMode + StrictHostKeyChecking，不忽略host key。脚本锁定release状态，按bundle digest pull→旧web/jobs排空并证明确实退出→PG/Valkey→业务及DBOS migrate→可选bucket init→新应用/代理/backup→health，成功才更新successful/previous。Exit137、迁移失败、owner冲突与未托管旧stack均需调查，不能直接 `docker compose up` 绕过gate。

外部应用S3追加 `--compose-file compose.s3.yaml`；启用backup追加 `--compose-file compose.backup.yaml --env-file .env.backup`，启用副本再追加 `--compose-file compose.replica.yaml --env-file .env.replica`；object-storage追加同名override/env，外部代理追加 `--compose-file compose.proxy.yaml`；附加文件必须属于已校验bundle，依据相关runbook构建完整计划。

默认360秒版本门：公开 `/api/health` 与jobs `/internal/ready` 均HTTP200、完整SHA相同、db/cache/queue/scheduler up、成功heartbeat不超过10分钟。仅容器healthy或web SHA不够；不伪造心跳，不缩短默认窗口来跳过首个五分钟slot。报告只含安全状态与SHA，不打印原始配置/响应或秘密URL。

启用副本时，检查主机显式 `.env.replica` 的 `BACKUP_REPLICA_INTERVAL_SECONDS` 与 `BACKUP_REPLICA_MAX_AGE_SECONDS`：健康阈值必须大于同步间隔，当前实现还要求至少为间隔3倍，并覆盖“间隔＋完整复制耗时＋verify/锁等待/调度步长”及余量。默认300/3600秒；旧显式900不会随bundle默认值更新。按实测周期配置，不自动放宽；观察至少一次完整同步和下一轮刷新期间的容器health，核对成功证明、恢复上界与脱敏error事件。健康预算不等于RPO，不改变base/dump/verification、WAL或retention规则；中断/超时的复制必须报告失败，不能把running当成功。详见 `docs/runbooks/selfhost-replica.md`。

迁移后按生成项目清单初始化套餐（billing关闭跳过）；服务器无pnpm，套餐seed不是现有deploy.sh自动步骤。需发布负责人在有Node/pnpm的受控项目目录执行：先从受保护输入取得目标app URL并核对 current_database/current_user，显式设置 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 进程环境后运行 `pnpm billing:seed`；该脚本不读取 DATABASE_URL/MIGRATION_DATABASE_URL，不能回退到本地 `.env.worktree`。单列该写动作，不把seed误当服务器入口。名单账号注册/验证邮箱/重新登录，访问 `/admin`，再配置模型与套餐授权；实际送信/AI调用依赖用户提供集成凭据与允许外部调用。用 quick-start 的验收点核对登录、空间、所启功能，报告未完成项。

## 5. 失败、回滚与恢复入口

- pull失败在停止旧服务前退出；保留成功记录。迁移/health失败保留失败bundle与schemaSha，迁移可能已改变数据库，不自动回滚。
- 只有最后迁移release（包括health失败版）显式声明兼容目标SHA，且目标是记录的当前/上一成功bundle，才获准应用回滚：

```sh
<bundle-dir>/deploy.sh --local --dir <deploy-dir> --rollback <recorded-success-sha>
# SSH模式同样换成 --host <explicit-user@host>
```

- 应用回滚保留数据卷，不降schema、不运行旧迁移、不修改DBOS内部表或删除ownership。未声明兼容时进入 `docs/runbooks/selfhost-restore.md`：匹配PG17/base/WAL与UTC点，`restore.sh`/`restore-drill.sh`恢复到新空卷，默认暂停jobs/副作用；业务、角色、账本、引擎及B/D退出证明通过后显式promote与切入口。外部支付/邮件/对象不随PG回退，另核对备份。
- 备份入口：`compose.backup.yaml`、`selfhost-backup.md` 与 retention runbook；第二目标 `compose.replica.yaml` 和 replica runbook。应用health不证明base/dump/WAL链或独立凭据副本可恢复；必须独立恢复演练才签收。

独立凭据恢复副本按 `openspec/specs/database-backup-recovery/spec.md`：目标可在不同供应商/账号，也可在用户选择单一供应商方案时使用同一R2账号下的独立桶。主备份桶与副本桶各用仅限本桶的独立token，且与应用身份分离；核验只挂副本凭据可恢复、该token没有主桶权限。单一R2方案须记录失去供应商独立性及账号级共同故障风险，不宣称跨供应商或独立账号容灾；凭据隔离不能替代供应商隔离。

交付来源run/namespace/完整SHA、bundle验证、部署命令退出码、web/jobs readiness、管理员/业务冒烟、备份恢复和ownership状态。只做verify/config/预检时标记“未部署”，不引用模板历史证据替代本环境验收。
