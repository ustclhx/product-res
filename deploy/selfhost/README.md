# 自托管 Compose 与部署交付

> **当前实例状态（2026-10-18）**：模板自托管测试实例已按用户确认拆除；部署能力、配置、runbook 与 GHCR 镜像保留供派生项目使用。R2 次日删桶与 DNS / token 手动收尾见[拆除记录](../../docs/runbooks/evidence/teardown-2026-10-18.md)。下文各次验收与待办说明按其记录时间阅读，不表示测试主机仍运行模板实例。

本目录提供 image-only Compose、显式 SSH/本机部署与兼容回滚、health/SHA 门、空白主机初始化、代理接入和同 SHA bundle 打包。首次真实 GHCR 发布已完成；恢复/副本脚本已交付，B/D ownership 签收与服务器恢复验收仍未完成。Node 已装配真实 B 队列与 Cron。关闭 Turnstile、开启验证邮件与多租户的本地生产验收见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)；正式邮件凭据由部署方提供。默认 Cloudflare 构建与 staging 流程保持原样。

## 正式部署

从受信发布 run 下载成功的同 SHA bundle；服务器仅安装 Python3、Docker Engine/Compose
与 curl，不需要业务源码、Node 或 pnpm。按 [OPERATIONS.md](OPERATIONS.md) 配置公开
`.env`、独立 file secrets 和证书，再通过 `deploy.sh` 更新，不用直接 `up` 做升级。
镜像引用由 bundle 的 digest 清单固定，不接受运行环境改写。

详细步骤见 [部署与回滚](../../docs/runbooks/selfhost-deploy.md)、
[空白初始化](../../docs/runbooks/selfhost-init.md)、[外部代理](../../docs/runbooks/selfhost-proxy.md)
与 [release bundle](../../docs/runbooks/selfhost-release.md)。Dokploy 是可选入口，不能跳过
迁移/排空门；不会自动安装或连接任何既有服务器。第二次正式发布
`081305013b022f457c561eecf5828b1959e13908` 的 bundle 包含全部 24 项运行材料，
包括恢复/drill/副本入口和附加示例；旧 SHA 的材料保持原样。1.5/6.3/7 的恢复验收保持待办。

## 内测开关（add-beta-access-gate）

未接邮件服务（`EMAIL_TRANSPORT=log`）的内测部署用以下三项控制准入与后台流水线，均在 `.env` 中设置，
`deploy.sh` 更新后生效；留空即恢复默认行为。

| 开关 | 取值 | 作用 |
|---|---|---|
| `BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED` | `true` / 空 | `true` 时 `BOOTSTRAP_ADMIN_EMAILS` 中的账号无需验证邮箱，注册或登录即成为平台 admin（仍排除封禁账号）；其它值或空保持“已验证邮箱才提升”。 |
| `credits.requireGrantForAccess`（`template.config.ts`，本项目为 `true`） | 模板配置 | 账号的个人空间需有管理员在后台“积分调整”发放的批次才能使用工作台；未开通时 `/app` 显示“账号待管理员开通”，工作台接口返回 403 `ACCOUNT_NOT_ACTIVATED`。平台 admin 始终放行；`/account`、退出登录与 `/admin` 不受影响。发放后用户刷新即可进入；之后撤销批次不会取消开通。 |
| `DATA_PIPELINE_SCHEDULES` | `paused` / `running` / 空 | `paused` 时 `datasources-daily-v1`、`selection-daily-v1`、`selection-label-v1`、`selection-readiness-v1`、`selection-review-v1` 仍注册，到点只记一条 `pipeline.paused` 日志；`datasources-reconcile-v1`、队列消费与手动触发照常。其它取值启动即失败。 |

**风险**：`BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED=true` 时，谁先以名单邮箱注册谁就是管理员。推荐顺序：

1. 设置 `BOOTSTRAP_ADMIN_EMAILS=<运维邮箱>`、`SIGNUP_ALLOWED_EMAILS=<运维邮箱>`、`BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED=true` 并部署；
2. 运维邮箱注册，确认 `/admin` 可进入（审计 `admin.user.bootstrap`）；
3. 清空 `BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED`，按需放开 `SIGNUP_ALLOWED_EMAILS`，再次部署；
4. 内测用户注册后，管理员在 `/admin/credits` 为其个人空间发放积分开通。

数据源凭据验收前保持 `DATA_PIPELINE_SCHEDULES=paused`，验收通过后清空并部署。

## eBay 账号删除通知（add-ebay-account-deletion）

启用 eBay Production keyset 前必须订阅 Marketplace Account Deletion 通知（本项目持久化 eBay 卖家用户名，
不能申请豁免）。端点：`https://product.ezarouter.cc/api/webhooks/ebay/account-deletion`，即
`APP_URL` 的 origin 加固定路径；eBay 后台填写的地址必须与它逐字一致（https、无末尾斜杠、无查询参数）。

1. **生成 verification token**：eBay 要求 32–80 位，只含 `A-Z a-z 0-9 _ -`。例如
   `openssl rand -hex 32`（64 位十六进制）。写入 `secrets/optional/EBAY_VERIFICATION_TOKEN`
   （单行，文件 0600、属主 1000，与其他 `EBAY_*` 凭据同目录；compose 已把该目录只读挂给 web）。
2. **验签凭据**：POST 通知用 Production `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`（同目录）申请应用令牌，
   再调用 Notification API `getPublicKey` 取公钥，按 kid 进程内缓存 1 小时；不计入 Browse 每日额度。
3. **重启 web**（`deploy.sh` 更新或重启 web 服务）：密钥按名称缓存，写入新文件后需重启生效。
   未配置或格式不合规时 GET / POST 都返回 503，日志 `ebay.account_deletion.unconfigured`。
4. **eBay 开发者后台** → Alerts & Notifications → Marketplace Account Deletion：
   填写告警邮箱、上面的 endpoint 与 verification token，逐项保存。保存 endpoint 时 eBay 会发送
   `GET ?challenge_code=...`，本端点返回 200 `{"challengeResponse": sha256hex(challengeCode + token + endpoint)}`，
   后台显示保存成功即验证通过。
5. **Send Test Notification**：预期后台显示成功；web 日志依次没有 `signature_rejected`，并出现
   `ebay.account_deletion.processed`（只含 `userHash`、各表计数与 notificationId，不含用户名）；
   `audit_log` 新增一行 `action = 'ebay.account_deletion'`、`target_id = <notificationId>`。
   测试用户通常不在本库中，计数为 0 属正常。

返回码：验签失败（缺头、未知 kid、签名不匹配）412；公钥接口不可达或 client 凭据缺失 503；删除事务失败 500。
后三者 eBay 会重发，持续 24 小时未确认会标记端点故障并发邮件，30 天未修复判为不合规。
删除范围与已知残留（`raw_payload` 正文中顺带出现的用户名随 90 天保留期清除）见
`openspec/changes/add-ebay-account-deletion/design.md` D4、D5。

## 本地开发镜像与基础启动

从仓库根目录构建，源码与基础镜像均锁定。`APP_VERSION` 必须为对应源码的完整 40 位小写 Git SHA；没有 Git 的归档必须显式提供它，不能使用短 SHA 或版本号。所有 `FROM` 都固定 digest；镜像不携带部署凭据。只有构建阶段使用 root；运行及数据初始化均非 root。

```sh
APP_VERSION=$(git rev-parse HEAD) bash deploy/selfhost/build.sh
```

脚本生成 `product-res-selfhost/{web,jobs,migrate,postgres,valkey,caddy}:<full-sha>`，不推送镜像。`app.Dockerfile` 的三个生产 target 共用多阶段构建：web 保留完整 Nitro `.output` 与 SSR 所需生产依赖闭包，jobs 保留 ESM 与生产依赖闭包，migrate 保留已锁定的迁移工具、workspace TS 与既有 SQL。构建期无部署 dotenv/数据库，Debian 预渲染固定 IPv4 DNS 顺序；输出仍由 `pnpm build:node` 产生。`native-smoke` 是独立验收 target，使用同一 Debian/Node 运行层加载 sharp 原生扩展并编码 PNG，不加入生产依赖。

```sh
docker build -f deploy/selfhost/app.Dockerfile --target native-smoke \
  --build-arg APP_VERSION="$(git rev-parse HEAD)" -t selfhost-native-smoke .
docker run --rm selfhost-native-smoke
```

根 `.gitignore` 作为 Tailwind 扫描输入保留，避免生成目录改变 SSR/client 两次构建的 CSS URL。构建使用 Dockerfile 专用 `.dockerignore`，排除 Git、dotenv、`.dev.vars`、密钥/证书目录、开发依赖目录及生成产物。密钥不能通过 Docker ARG/ENV 或构建缓存传入；需要修改模板开关时先改 `template.config.ts` 并重新构建。

本地开发时复制 `.env.example` 为 `.env`，使用刚构建的本机镜像替换其中 registry 占位引用，填写公开 HTTPS URL/域名和集成 ID。正式服务器部署使用上面的 release 入口。按 `secrets.example` 创建单文件 secrets 与证书，随后在本目录执行：

```sh
docker compose config
docker compose up -d
docker compose ps -a
```

Compose 没有 `build:`。示例 `.env` 设置 `COMPOSE_PROFILES=caddy`，所以普通 `up -d` 会启用代理。只有 Caddy 映射宿主 80/443；PG、Valkey、web 和 jobs 都没有 host ports。`postgres` healthy 后 migrate 依次执行：

```sh
pnpm --filter @product-res/db db:migrate
pnpm --filter @product-res/platform dbos:migrate
```

pnpm CLI 与其平台原生 binary 在镜像构建阶段预装到非 root 可读的共享缓存；migrate 设置 `COREPACK_ENABLE_NETWORK=0`，不需要部署时下载包管理器。wrapper 仅接受 `MIGRATION_DATABASE_URL_FILE` 的 migrator、postgres 服务名、`sslmode=verify-full` 连接，拒绝本地默认连接与直接值。迁移 CLI 的原始输出可能含驱动配置，因此只输出固定 JSON 成功/失败事件。失败容器退出非零且 `restart: no`；web/jobs 仅在其成功退出以及 Valkey healthy 后启动。重跑失败迁移前应检查版本、secret、证书和迁移本身，再执行 `docker compose up -d`，不配置无限重试。

jobs 的 `JOB_EXECUTOR_ID` 默认 `jobs-1`，Compose 将 hostname 固定为同值，并把持久 `job_owners` 卷挂载到 `/app/.data/job-owners`。每个 executor 的 hostname/ID 必须跨重启稳定；不能通过更换随机 ID 或清除 owner 文件绕过启动拒绝。Linux owner 记录包含 PID、host、PID namespace inode、boot ID 和进程启动时间，容器重建后即使重用 PID 1 也使用这些身份核对旧 incarnation 是否退出；证明规则与 guard 处置见 [任务引擎 runbook](../../docs/runbooks/node-job-engine.md#连接轮询与-ownership)。

双 jobs 副本需分别声明不同且稳定的 hostname/ID，挂载同一 `job_owners` 卷，并使用同一版本的完整 handler 集与队列策略。当前 service 使用固定身份，不能盲目用 `docker compose up --scale jobs=2` 扩容；不同 hostname 的副本也不能为另一 executor 证明退出。本地真实发信、双副本停启与保留卷重建证据见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)。

## 文件与权限

PG 的 bootstrap 超级用户仅分配给 postgres；app 密码仅用于初始化，app URL 仅分配给 web/jobs；migrator URL 仅分配给 migrate。readonly 不分配给应用，排查时从操作员独立 secret 文件读取。应用镜像只有默认 DML，不能 DDL；readonly 不能写；audit_log 保持只追加；DBOS/job_engine 迁移与授权由 migrator 完成。

PG 复用 `infra/local/initdb/01-roles.sql` 和 `02-db-grants.sql`。唯一共享改动是前者支持 psql 密码变量，同时保留本地开发默认值；生产初始化严格读取四个 `_FILE`，不使用这些默认密码。密码支持引号和空格，通过环境/getenv/psql 字面量转义传递，不放入 argv；空值、多行、直接值冲突会失败。初始化只在空卷执行，改变文件不会自动轮换已有角色密码。

| 服务 | 运行 UID:GID | 空 named volume |
|---|---|---|
| postgres | 999:999 | 镜像预置 data 0700；TLS 复制目标 0700；私钥 0600 |
| valkey | 999:999 | `/data` 0700，AOF 持久化；ACL 散列只在 tmpfs 中 |
| web / jobs / migrate | 1000:1000 | 应用文件归 node；jobs 的 `/app/.data/job-owners` 为 0700；无数据库/证书写卷 |
| caddy | 10001:10001 | `/data` 与 `/config` 镜像预置可写，证书/ACME 状态持久化 |
| cloudflared（仅隧道模式） | 65532:65532 | 无卷；只读根文件系统，`/tmp` 为 0700 tmpfs，token 为 0600 file secret |

首次 named volume 通过镜像目录复制正确属主，不使用 root init 容器。jobs 镜像由 node（UID 1000）创建 0700 的 owner 目录，空 `job_owners` 卷继承该属主和权限，owner/guard 文件为 0600。已有卷必须预先匹配上述 UID；不要通过 root 入口在每次启动时修正。Compose file secrets 不转换宿主文件 UID/mode：宿主父目录使用 0700，secret 文件与只读证书挂载源必须让分配的容器 UID 可读。Linux 可按对应 UID/GID 设置权限；不把私钥开放到公共宿主目录。PG 入口每次以 postgres 用户将挂载证书复制到受限可写目录。

PG 拒绝全部非 TLS TCP 连接，TLS 要求 SCRAM。`certs/postgres/server.crt` 必须有 `DNS:postgres` SAN；`server.key` 为对应私钥；`certs/ca.crt` 是签发 CA/bundle。所有 Node 容器使用 `NODE_EXTRA_CA_CERTS=/run/certs/ca.crt` 和 `sslmode=verify-full`，同时验证 CA 与服务名。不要改为 `require`（postgres.js 会关闭证书验证），也不要将 `sslrootcert=/path` 塞入 postgres.js URL。外部 PG 修改服务名时需要同步证书与受控 migrator wrapper。

Valkey 密码通过 ACL SHA-256 文件加载，不进入命令行；web/jobs 共用命名空间。内部 data 网络不向宿主映射端口，Valkey 使用认证 redis 连接，当前没有配置 Valkey TLS。需要跨主机缓存时应由部署方配置受验证的 rediss 与 CA。`maxmemory 256mb`、`noeviction`，达到容量时显式失败；AOF everysec，缓存不取代 PG 账本。

## TLS 与代理

`CADDY_TLS_MODE=acme` 使用 Caddy 自动签发，需真实域名指向主机且公网 80/443 可达；容器只监听 8080/8443。`CADDY_TLS_MODE=supplied` 使用只读 `certs/caddy/server.crt` 与 `server.key`，证书必须覆盖 `APP_DOMAIN`；可用自签 CA 完成本机验收。正式环境不要关闭客户端证书验证。

Caddy 不信任外部转发链；它将 XFF 覆盖为实际 peer，并移除 CF-Connecting-IP 与 Forwarded。web 只信任专用 ingress 上的 Caddy 固定地址 `172.30.77.2/32`，不信任所有 Docker 网段。没有开启请求 access log，避免认证链接/query 进入日志；Caddy 自身日志为 JSON。

外部代理模式设置 `COMPOSE_PROFILES=`，通过 `docker network connect <project>_ingress <proxy-container>` 将受控代理接到本项目 ingress，并使用 `web:3000`。给代理固定地址，将 `TRUSTED_PROXY_CIDRS` 设置为它的确切地址或受限子网；显式空值表示完全不信任转发头；代理同样必须覆盖客户端转发头。外部代理不接 data 网。Dokploy/Traefik 的外部网络、label、域名与证书由 D 配置，本 Compose 不声明 Dokploy 专有设置；接入后仍使用同样的迁移 gate 与 secret 隔离。

Cloudflare Tunnel 模式加载 bundle 中的 `compose.tunnel.yaml`：随发布交付的 cloudflared（官方
`cloudflare/cloudflared:2026.10.0` 固定 multiarch digest，非 root 65532，catalog 第 9 个镜像）作为唯一公网入口，
内置 Caddy 停用且所有服务无宿主端口。cloudflared 只接 ingress 固定地址 `172.30.77.6`，web 只信任
`172.30.77.6/32`；Tunnel token 仅以 `cloudflared_tunnel_token` file secret 经 `--token-file` 读取，不进入环境变量、
命令行、日志或 bundle。Tunnel 为 Cloudflare 控制台创建的 remotely-managed 类型，public hostname 指向
`http://web:3000`。部署追加 `--compose-file compose.tunnel.yaml`，与 `compose.proxy.yaml` 互斥（部署脚本在任何
服务变更前拒绝），也不与 object-storage override 组合。切换入口模式时部署脚本移除本 project 未启用的旧入口
容器，健康门经 `APP_URL` 走隧道。创建 Tunnel、写入 token、部署命令与真实客户端 IP / 伪造 XFF 验收见
[代理与隧道 runbook §4](../../docs/runbooks/selfhost-proxy.md#4-随发布交付的-cloudflare-tunnelcomposetunnelyaml)。

Caddy 配置依据官方 [global options](https://caddyserver.com/docs/caddyfile/options) 与 [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。Valkey ACL/认证依据官方 [security](https://valkey.io/topics/security/)；这些资料不替代本仓库固定镜像的实测结果。

## 资源、探活与停止

默认 CPU 配额总计 2 核；常驻服务内存上限合计约 3.25 GiB，migrate 额外 512 MiB。PG 最大连接100，web/jobs 各池10，迁移使用独立低并发连接；调整池预算时保留运维余量。每个 service 包含健康检查、资源上限、restart、日志轮转和45秒停止宽限期。应用 shutdown 默认30秒，必须小于容器 grace；增大 `SHUTDOWN_TIMEOUT_MS` 时同步修改 grace。

Docker `json-file` 的 `LOG_MAX_SIZE=10m`、`LOG_MAX_FILE=3` 可调。应用与迁移输出脱敏 JSON；PG/Valkey 保留官方 stderr 格式，由 Docker 包装和轮转。只有 Caddy profile 有公开入口。内部 `/internal/live` 仅用于容器进程探活，依赖暂未就绪不触发重启循环；外部 `/api/health` 实时检查 DB/cache/queue/scheduler，返回完整 SHA 与 `lastCronAt`。所有依赖正常且有有效成功心跳时返回 200；启动尚无心跳、依赖故障或消费者/调度器停摆时返回 503。容器 healthy 只说明进程存活，不能代替该 readiness。

初轮镜像与尚未通过的 ACME 项见 [A7 验收记录](../../docs/runbooks/selfhost-a7.md)，完整健康与认证尾部验收见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)。停止保留数据用 `docker compose down`；仅删除隔离验收数据时才使用 `down -v`。

## 外部 S3 / R2（C 1.7）

正式 bundle 的 `compose.s3.yaml` 将 `S3_ENDPOINT/REGION/BUCKET/FORCE_PATH_STYLE` 和两份
应用凭据 `_FILE` 装配到 web/jobs。按 `.env.example` 填公开配置，按 `secrets.example` 创建
UID1000 可读的 `s3_access_key_id` / `s3_secret_access_key`，通过
`deploy.sh ... --compose-file compose.s3.yaml` 部署。不加载此文件时基础 Compose 无 S3
配置或凭据前提。外部 S3 与自带 object-storage 二选一；此路径不启动 SeaweedFS 或
bucket 初始化器，不将应用存储凭据分给 PG、迁移器、代理或 backup。
R2 的 S3 API endpoint、region=auto、私有桶、最小权限与浏览器 CORS 设置步骤见
[外部存储 runbook](../../docs/runbooks/selfhost-c-storage.md#正式-bundle-的外部-s3--r2-配置)。
新增装配须随新 SHA 发布；旧 bundle 不含该文件，不能现场修改旧版本绕过校验。

## 可选 object-storage（C 1.5/1.6）

默认仍连接部署方选择的外部 S3。自带 SeaweedFS **Community 4.48** 只通过额外的 Compose override 启用；不加载该文件时，基础 Compose 不定义自带存储服务或 S3 secret。关闭时同时省略该 override，不能仅删 `--profile` 而保留其中对初始化器的依赖。需要支持 `!override` 的 Docker Compose **2.24.4+**。

复制 `.env.object-storage.example` 为本机 `.env.object-storage`（只填镜像、域名、region、bucket）；按 `secrets.example` 的补充清单创建四份独立随机凭据。不要把值写入 env 示例、Docker ARG、命令参数或日志。使用已包含 C 存储 SDK 的迁移镜像，初始化器挂载仓库脚本、复用其锁定 SDK，不在启动时安装依赖。构建此存储 wrapper 仅使用固定上游镜像；应用镜像发布、服务器部署、备份与恢复仍归 D。

```sh
# 从仓库根目录构建存储 wrapper；上游 manifest digest 固定并含 amd64/arm64。
docker build -f deploy/selfhost/object-storage.Dockerfile \
  -t product-res-selfhost/object-storage:4.48 .
# 然后在 deploy/selfhost 目录：
docker compose --env-file .env --env-file .env.object-storage \
  -f compose.yaml -f compose.object-storage.yaml --profile object-storage config
docker compose --env-file .env --env-file .env.object-storage \
  -f compose.yaml -f compose.object-storage.yaml --profile object-storage up -d
```

配置独立 `S3_PUBLIC_DOMAIN` 的 DNS 与 HTTPS 证书，证书覆盖 APP_DOMAIN 和 S3_PUBLIC_DOMAIN；自带证书需对应 CA，ACME 则需两域公网可达。web/jobs 签名与服务端操作均使用 `https://S3_PUBLIC_DOMAIN`，不能在签名后替换协议、Host、路径或 query。专用 ingress 中该域名解析到 Caddy；profile 内部 Caddy 监听443并发布宿主443，HTTP8080发布80。只有代理 namespace 的 `ip_unprivileged_port_start=0`，其 UID10001、cap_drop ALL 保持；jobs 使用独立固定内网地址避免占用代理地址。

对象服务仅接私有 object 网络，Caddy接 object/ingress、不接 PG data；web/jobs 不接 object。master/filer/admin/volume/gRPC 等内部控制端口没有 host 映射，额外 WebDAV/IAM/Iceberg/Lance/Admin UI 关闭。上游 mini 必须运行内部管理/维护组件，关闭 UI 不代表删除控制面；不要把应用容器、其他不受信任服务或外部代理接入 object 网。健康检查用于 master/S3 进程存活，不能代替实际签名协议验收。

首次 named volume 从镜像目录继承 UID1000/GID1000、0700；数据在 `object_data`，master/admin/filer LevelDB 元数据在 `object_metadata`。已有卷应预先匹配属主；入口不执行 root 修复。认证在开始监听前由非 root wrapper从只读 file secrets生成0700 tmpfs中的0600 JSON，Go参数及环境不含凭据。应用身份只声明指定 bucket 的 Read/Write/List/Tagging；admin身份只给初始化器和对象服务。**SeaweedFS 4.48 的 bucket Write 同时允许修改 CORS、生命周期等管理操作**，因此公开代理另拒绝 bucket 根 PUT/POST/DELETE；初始化器使用私有端点进行管理。应用不得绕过代理直接接控制网；当前不支持公开批量 DeleteObjects或用应用密钥管理 bucket。

初始化器依次在数据库迁移、存储健康后完成，成功退出才启动 web/jobs。它以 admin创建私有 bucket，按 APP_URL 的 **origin** 幂等更新 CORS：PUT/GET/HEAD，Content-Type/If-None-Match，暴露 ETag/Content-Length/Content-Type/Content-Disposition，不允许其他来源。不设置匿名策略；错误只输出固定摘要。重跑初始化会覆盖该 bucket 的 CORS，以本配置为准。

S3站点不启用 access log，并用固定503错误响应处理代理故障，防止 Caddy默认5xx错误日志包含预签名 request URI。不要启用 debug或添加包含query的access/error日志。Docker仍按10m×3轮转进程日志。

profile资源起点与最终验收记录见 [C profile runbook](../../docs/runbooks/selfhost-c-profile.md)。仅此 override 将 web/jobs 上限收敛为768/512MiB；PG1024、Valkey384、代理128、存储512MiB，常驻合计3328MiB/2CPU。migrate和bucket init在应用前运行。SeaweedFS设置384MiB Go内存目标、单Go执行核、LevelDB索引、128MiB volume、storage/filer并发参数2与32MiB上传预算；Go内存目标不是硬上限，Docker512MiB才是边界。实测安全并发只适用于记录中的负载，不承诺任意对象数量或吞吐。

停止并保留全部对象/元数据/数据库：

```sh
docker compose --env-file .env --env-file .env.object-storage \
  -f compose.yaml -f compose.object-storage.yaml --profile object-storage down
```

不加 `-v`。随后关闭profile时省略第二份配置文件，使用部署方的外部S3配置；该操作不复制对象，旧对象不会自动出现在新endpoint。重新启用时复用相同project名、卷和凭据。密钥轮换、数据迁移/备份由部署方另行安排。

## 可选 PG 备份（D 4.1–4.5）

显式加载 `compose.backup.yaml` 与 `.env.backup.example` 的本机副本，使用与 PG 同一
完整 SHA 的 backup 镜像；WAL-G v3.0.8、每日 full/逻辑备份和连续归档，仅 PG/工具
获得独立 backup file secrets、UID999 peer socket、受限状态卷。默认每日02:00 UTC，
7天每日＋4周 weekly 保留完整连续链；实际清理先 dry-run 和最老链校验。
配置、逻辑恢复用途、状态/告警及未完成外部验收见
[备份 runbook](../../docs/runbooks/selfhost-backup.md)。不加载 override 时原有部署保持可用。
