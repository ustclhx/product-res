# Bundle 运维入口

> **模板测试实例状态（2026-10-18）**：用户确认拆除 `product-res-ecs` 上的 `product-res-selfhost` 项目。当前部署的基础 / S3 / backup / replica Compose 栈、项目卷、本机项目镜像和 `/opt/product-res-selfhost` 已清理，80/443 已释放；其他容器、匿名卷、镜像与 `warp-svc` 状态保留。三个 selfhost R2 桶已解除锁并设为所有对象 1 天后过期，待次日核空删除；域名 DNS 与桶级 token 的手动收尾见[拆除记录](../../docs/runbooks/evidence/teardown-2026-10-18.md)。本目录部署材料、runbook 与远端 GHCR 镜像保留供派生项目使用。

仅使用受信 Actions 发布成功的 `image-set.json` / 同 SHA bundle。校验 checksum 用于传输
完整性；不替代来源核实。先校验源 SHA、发布 run、所有镜像两架构、namespace/revision。
发布需要明确授权；首次模板发布的源 SHA 与 run 见仓库发布 runbook，本地 fixture 不能用于服务器。

1. 在明确选择的**空白** Ubuntu24.04 / Debian12 amd64/arm64 上，单命令运行
   `sudo ./init-server.sh --dir /srv/product-res-selfhost`。已有主机只使用经审阅的既有 Docker / 入口，
   不运行空白初始化。初始化不部署应用或安装 Dokploy。
2. 部署目录0700，`.env`0600。复制本 bundle `.env.example`，填写域名、APP_URL和公开集成
   ID；依据 `secrets.example` 准备角色/认证 file secrets 和验证证书。PG SAN 为 postgres，
   app/migrator URL必须 verify-full；应用只拿 CA。不要输出或提交密钥，不将密码放命令行。
   secrets 挂载需让指定非root UID读取，父目录仍受限。
3. 本机执行 `./deploy.sh --local --dir /srv/product-res-selfhost --sha <full-sha> --bundle <bundle-dir>`；
   从操作员电脑执行 `./deploy.sh --host <explicit-user@host> --dir /srv/product-res-selfhost
   --sha <full-sha> --bundle <local-bundle-dir>`。SSH须已有可信 host key 与非交互身份。
   脚本校验并串行拉取→旧app排空→强制目标 migrate→启动→公开health及jobs版本检查。
   默认 readiness 窗口360秒覆盖首次五分钟成功心跳；失败返回非零。
4. 默认 Caddy profile 处理80/443。外部代理设置 `COMPOSE_PROFILES=`，仅web连接已有专用
   ingress，用 `--compose-file compose.proxy.yaml`，指定 `EXTERNAL_INGRESS_NETWORK` 及
   每个确切代理 `/32` 或 `/128`。PG/Valkey/jobs不连接代理网，不新增宿主端口。
   代理覆盖不可信XFF并移除CF/Forwarded；最终渲染必须检查，Dokploy只选择web:3000。
5. 可选 backup 用 `--compose-file compose.backup.yaml --env-file .env.backup`，该 env0600、
   独立备份file secrets/CA只给PG和backup。可选自带对象服务使用
   `--compose-file compose.object-storage.yaml --env-file .env.object-storage`，env含
   `COMPOSE_PROFILES=object-storage`；bucket init也必须成功后才启动应用。
   外部 S3/R2 则只加 `--compose-file compose.s3.yaml`，在 `.env` 中配置公开的
   `S3_ENDPOINT/REGION/BUCKET/FORCE_PATH_STYLE`，两份应用 S3 file secrets 仅给 web/jobs。
   此路径与 object-storage 二选一，不启动本地存储，不要求其管理身份；可与 backup/replica
   组合，应用与备份身份保持独立。外部桶须事先私有化并配置 APP_URL origin 的 CORS，
   R2 使用 S3 API HTTPS endpoint 与 region=auto，详见仓库外部存储 runbook。
6. release-state保留上一成功版本和最后迁移SHA。失败不自动回滚；兼容性审阅后执行
   `./deploy.sh --local --dir /srv/product-res-selfhost --rollback <previous-success-sha>`（SSH换成
   `--host <explicit-host>`）。最后迁移release必须显式声明目标兼容，包括schema、DBOS
   handler/checkpoint和长任务版本；应用回滚不会降低数据库schema或执行旧migration。
   不兼容时恢复匹配PG17备份到**新空卷**，暂停jobs/外部副作用、核对业务/角色/任务状态、
   明确promote及入口切换。新版bundle含restore/drill入口，旧版bundle需独立取得匹配材料；
   不删除旧卷或ownership文件，不改DBOS内部表。

空间预检仅是部署目录至少2GiB余量；还需核对Docker data-root及PG/WAL/备份实际容量。
成功app health不代表备份成功。B/D退出证据签收、整机恢复、真实registry/公网TLS/Dokploy
和独立备份资源验收尚待协调者确认，禁止将本地机制测试当作服务器验收。

## 指定点恢复与第二目标（新版完整 bundle）

`restore.sh` / `restore-drill.sh` 只使用 Python3、Docker/Compose 和事先拉取的匹配 PG17
镜像，在新空卷恢复完整 cluster，不启动 jobs，不切流量。先独立保管角色 secret、
TLS、匹配应用镜像和用户对象备份。恢复身份只需要独立 prefix 的 List/Get 权限。
受限目录0700，secret文件0600且UID999可读；不要把值放env、argv或日志。

恢复用单独的受限 `restore-s3.env`，不能直接传 `.env.backup.example`：

```dotenv
BACKUP_S3_ENDPOINT=https://backup.example.com
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=s3://backup-example/cluster/pg17
BACKUP_S3_FORCE_PATH_STYLE=true
```

```sh
./restore-drill.sh --s3-env /restricted/restore-s3.env \
  --access-key-file /restricted/secrets/restore-access-key \
  --secret-key-file /restricted/secrets/restore-secret-key \
  --ca-file /restricted/backup-ca.crt --image <matching-postgres-digest> \
  --backup-id <base-id> --target-time <explicit-UTC-time> \
  --project selfhost-restore-example --state-dir /restricted/new-drill \
  --checks-file /restricted/restore-checks.json
```

checks为受信JSON，含 `creditsEnabled` 和 `checks:[{name,sql}]`；SQL仅单条只读SELECT/WITH，
期望恰好一个`t`。必须校验目标前/后业务及真实引擎记录，不能只核对schema。
用 `restore.sh` 保留实例时成功状态为 `validated_paused`；`check` / `promote` / `cleanup`
均传同一 `--state-dir`。promote不切流量，drill成功只清理自己的资源，失败保留报告/卷。
恢复后启用jobs仍需要B/D可信退出证据和同版本handler签收。

第二目标加载 `compose.replica.yaml` 与 `.env.replica.example` 的本机副本，额外提供
`backup_replica_s3_access_key_id` / `backup_replica_s3_secret_access_key` 文件及独立CA，
只给backup。它异步复制完整base/dump/WAL/history并校验，不传播主目标删除；副本失败
可见但不阻塞主PG归档。只能用第二目标独立凭据与配置重复恢复，才能证明主账号不可用
时仍可恢复。应用健康不等于备份或副本成功。
