# A 7.1–7.4：Dockerfiles 与 Compose 验收

部署入口及操作步骤见 [deploy/selfhost](../../deploy/selfhost/README.md)。本机 Docker Desktop 4.55.0、Engine 29.1.3、Compose 2.40.3，Linux/arm64，Node 22.23.3；验收容器、网络和卷均使用 `selfhost-a7` 前缀。随机测试 secrets 与两套自签 CA 放在仓库外的任务专用临时目录，没有生产/staging/外部 Provider 调用。

## 镜像和基础启动

`app.Dockerfile` 的 web/jobs/migrate 三个 target 均构建成功；基础镜像固定 digest，应用 revision 标签和健康版本为完整 40 位 SHA。无 Git 构建上下文不带 `APP_VERSION` 时，在 `version-check` 阶段退出1；短/非法 SHA 使用同一正则拒绝。构建无 dotenv/数据库连接，公开页降级并预渲染18页。独立 `native-smoke` target 在相同 Debian/Node 运行层以 UID1000 加载 sharp 原生扩展并编码1像素 PNG，输出 `native sharp module loaded, uid=1000`；该依赖仅在验收 target。

本机发现并在 Docker 打包层修复：

- Debian localhost 双地址族导致预渲染连接拒绝：构建设置 `NODE_OPTIONS=--dns-result-order=ipv4first`，运行时监听不受影响。
- Nitro SSR 的 CommonJS React 外部引用不能仅靠 `.output` 解析：web 一并复制 `pnpm deploy --prod` 生产依赖闭包。保留完整 `.output`。
- Tailwind 需要根 `.gitignore` 排除生成目录：构建 context 保留此文件后，SSR 的 CSS URL 与 public 文件一致，`/login` 和 CSS 都返回200。
- 非 root PG 重启不能覆盖只读源复制出的文件：每次使用 `install -m 0600` 更新自己的 TLS 目录；授权脚本目录保持可遍历。
- Corepack默认缓存属于root，迁移用户原先会在线下载pnpm：构建阶段准备共享可读缓存和平台binary，运行时关闭Corepack下载，并以 `--network none` 验证pnpm版本。
- Caddy 官方 binary 带低端口 file capability：高端口镜像去掉它，兼容 `cap_drop: ALL`；web/Caddy 固定 ingress `.3/.2`，避免自动分配抢占代理 IP。

`docker compose config --format json` 断言通过：无 build；仅 Caddy 发布80/443；全部 service 有非 root user、healthcheck、CPU/内存上限、日志轮转、停止宽限；常驻 unless-stopped，migrate no；web/jobs 的 migrate 依赖为 `service_completed_successfully`。资源配额总计2核，常驻内存3.25GiB，migrate 512MiB；日志默认10m×3，stop grace45秒。

普通 `docker compose up -d` 在全新 named volume 创建三角色、业务 SQL 与 DBOS/job_engine 迁移后启动应用。PG、Valkey、web、jobs、Caddy 全部 healthy；migrate exited(0)。实际进程 UID：PG/Valkey999，web/jobs1000，Caddy10001；迁移容器配置1000。只有 Caddy 的宿主80/443映射，其他服务的显示端口只是 image EXPOSE。

导出六个生产镜像并逐层扫描测试凭据、私钥与配置，同时核对镜像配置/历史及应用目录中的 dotenv/Git 排除；结果无凭据命中。运行 secret 只出现在分配服务的只读挂载中。基础服务保留官方日志格式，应用/迁移/Caddy JSON，Docker json-file 配置统一轮转。本批验证配置与脱敏日志，没有把组8.2的强制日志轮转验收提前勾选。

## 迁移、TLS 和权限

真实 PG17 上，migrate 依次输出 `selfhost.db:migrate.completed` 与 `selfhost.dbos:migrate.completed`，最终退出0。使用随机错误 migrator 密码制造真实 SQL 迁移失败：只输出 `selfhost.migration.failed`，退出1、restart=no；web/jobs 保持 created，未启动，Caddy也未启动。恢复正确secret后再次成功迁移和启动，没有无限迁移重试。

使用容器内实际 postgres.js 与 pg 驱动验证：

| 行为 | 结果 |
|---|---|
| 正确 CA、`sslmode=verify-full`、postgres SAN | 两驱动成功；pg_stat_ssl 确认 TLS |
| 无关自签 CA | 两驱动拒绝证书链 |
| postgres-wrong DNS alias（SAN不含该名） | 两驱动 `ERR_TLS_CERT_ALTNAME_INVALID` |
| postgres.js 显式明文 | PG hostnossl 拒绝，28000 |
| migrator 创建测试表 | 成功 |
| app 对新表 INSERT，readonly SELECT | 成功，证明 default privileges |
| app CREATE TABLE / audit_log UPDATE、DELETE | 均拒绝，42501 |
| readonly INSERT / job_engine.message 正文读取 | 均拒绝，42501 |
| app public/job_engine/dbos CREATE、数据库 CREATE/TEMP | 全部无权限 |

PG 的测试行和 Valkey 的 AOF 测试键在 `down`（不删卷）、重新创建容器及失败迁移之后保留。PG 重启仍使用999，复制后的私钥0600，TLS正常。最后用 `down -v` 清理全部本任务容器、网络、数据/证书卷；未操作其他容器。

## TLS 入口与 IP

自带证书模式使用测试 CA签发、SAN=selfhost-a7.local 的证书，HTTPS 请求使用 `--cacert` 验证，未使用 `-k`。真实 Caddy 的80端口返回308，Location 是标准443的HTTPS URL；443可访问 SSR、CSS和健康端点。Caddy健康、证书和config卷为非 root可写。没有发布 UDP/HTTP3，避免广告未映射的8443端口。

使用仅挂载到验收容器的临时 upstream probe，复用项目 `createNodeRequestMetadata` 与 Compose 的真实 trusted CIDR，不添加生产调试端点。通过真实 TLS Caddy 连续发送两组伪造 XFF链/CF-Connecting-IP/Forwarded：upstream peer始终172.30.77.2，XFF被覆盖为实际Docker Desktop客户端192.168.65.1，CF/Forwarded被删除；解析clientIp稳定192.168.65.1，不是攻击者地址。另从不可信 data peer直连，伪造XFF被忽略，clientIp等于真实peer。随后恢复真实web镜像。

ACME模式 `caddy validate` 通过，但没有可用公网测试域名，未验证实际签发、续期或公网 challenge；7.4与ACME验收保持未勾选。自带证书/IP测试不能代替ACME验收。Dokploy/Traefik外部网络和正式域名仍由D交付。

## 健康与范围外发现

当前 web `/internal/live` 200，含完整SHA；jobs `/internal/live` 200，queue/scheduler均unavailable、lastCronAt=null，没有伪造消费者或Cron。当前 `/api/health` 实际是DB-only 200、DB up、lastCronAt=null，含同一完整SHA；**尚不能返回任务说明预期的完整 readiness 503**，它需要A8.1扩展与A9装配。B4与协调者生成的调度SQL迁移#128在本批执行期间合入main，但Node composition仍没有装配它。本批不修改共享server或B实现，不勾选8/9组。

附加尝试现有生产 `/api/auth/sign-in/email` 时返回500，日志为 `new Request` 克隆输入时 `Cannot read properties of undefined (reading 'window')`，发生在异步邮件/队列之前；没有调用外部Turnstile。此问题需协调者在A9完整认证验收前复核，涉及共享auth/runtime，未在A7越界修改，也未宣称认证e2e通过。IP验收使用上述真实代理+平台解析器probe完成。

## 工程检查

根 `pnpm check`（修正迁移wrapper格式后）、`check:deps`、`check:singletons`、`dedupe --check`、`typecheck`、`test`、`build` 全部通过。首次全量 `test` 165文件/1201用例通过，typecheck14/14，默认Cloudflare构建2/2；rebase #127/#128后166文件/1213用例通过，最终默认Cloudflare构建2/2重新执行成功。六个生产镜像通过 `build.sh` 构建，验收版本 `a959eb607dae82c7ce72623f6e68342fe85e1eea`；该提交后的改动仅为文档与Compose显式空trusted CIDR处理（config验证通过），不改变镜像源码。没有新增迁移SQL、生产凭据、staging部署或CI权限变更。
